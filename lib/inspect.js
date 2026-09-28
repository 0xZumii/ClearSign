/**
 * Verification orchestration for the two tabs. Pure-ish: takes an Rpc, returns
 * the same shape the CLI produces, so both surfaces speak one vocabulary.
 */

import {
  DOMAIN_SEPARATOR_SELECTOR,
  EIP712_DOMAIN_SELECTOR,
  checkDomain,
  classify,
  decodeEip712Domain,
  domainSeparator,
  hashTypedData,
  recoverAddress,
  toHex,
} from "./eip712.js";
import { selector } from "./keccak.js";
import { delegationTarget } from "./rpc.js";

const norm32 = (v) => "0x" + String(v).replace(/^0x/i, "").padStart(64, "0").toLowerCase();

async function tryCall(rpc, to, data) {
  try {
    const result = await rpc.callContract(to, data);
    return result && result !== "0x" ? result : null;
  } catch {
    return null; // not implemented, or reverted — never a crash
  }
}

/**
 * Verify one contract's EIP-712 domain. `expected` (name/version/chainId) is
 * optional and only used for pre-ERC-5267 contracts.
 */
export async function inspectContract(rpc, address, expected = null) {
  const result = {
    address,
    nodeChainId: null,
    declaredDomain: null,
    declarationSource: null,
    hasSeparator: false,
    onchainSeparator: null,
    recomputedSeparator: null,
    match: null,
    extensions: [],
    findings: [],
    status: "error",
    error: null,
  };

  try {
    const code = await rpc.getCode(address);
    if (!code || code === "0x" || code === "0x0") {
      result.findings.push({
        level: "notable",
        message: "There is no contract at this address. It is an account, or the wrong chain is selected.",
      });
      result.status = "no_contract";
      return result;
    }
    // EIP-7702: the account's code is a 0xef0100 designator pointing elsewhere.
    // That is not "no contract" and not a normal contract either - the behavior
    // lives at another address, so say that rather than reporting a bland result.
    const target = delegationTarget(code);
    if (target) {
      result.delegationTarget = target;
      result.findings.push({
        level: "notable",
        message: `This account delegates its code to ${target} (EIP-7702). The EIP-712 domain, if any, belongs to that contract — inspect it directly.`,
      });
      const delegated = await tryCall(rpc, target, DOMAIN_SEPARATOR_SELECTOR);
      result.status = "delegated";
      result.hasSeparator = Boolean(delegated);
      if (delegated) result.onchainSeparator = norm32(delegated);
      return result;
    }
  } catch (error) {
    result.error = String(error.message ?? error);
    result.findings.push({ level: "high", message: `Could not read the address: ${result.error}` });
    return result;
  }

  try {
    result.nodeChainId = await rpc.chainId();
  } catch {
    /* chainId is a nicety; verification does not depend on it */
  }

  const separator = await tryCall(rpc, address, DOMAIN_SEPARATOR_SELECTOR);
  if (separator) {
    result.hasSeparator = true;
    result.onchainSeparator = norm32(separator);
  }

  const raw = await tryCall(rpc, address, EIP712_DOMAIN_SELECTOR);
  if (raw) {
    try {
      const decoded = decodeEip712Domain(raw);
      result.declaredDomain = decoded.domain;
      result.declarationSource = "ERC-5267 eip712Domain()";
      result.extensions = decoded.extensions;
    } catch {
      /* a malformed declaration is not a declaration */
    }
  }

  if (result.declaredDomain === null && expected) {
    result.declaredDomain = { ...expected, verifyingContract: address };
    if (result.nodeChainId != null) result.declaredDomain.chainId ??= result.nodeChainId;
    result.declarationSource = "supplied expectation (no ERC-5267)";
  }

  if (result.declaredDomain === null) {
    result.status = result.hasSeparator ? "unverified" : "no_domain";
    result.findings.push(
      result.hasSeparator
        ? {
            level: "notable",
            message:
              "Contract exposes DOMAIN_SEPARATOR() but has no ERC-5267 eip712Domain(), and no name was supplied, so it cannot be verified here.",
          }
        : {
            level: "info",
            message: "No EIP-712 domain found on this contract. It may not use typed-data signatures at all.",
          }
    );
    return result;
  }

  const check = checkDomain(
    result.declaredDomain,
    result.onchainSeparator,
    result.nodeChainId,
    address
  );
  Object.assign(result, check);
  result.status = classify(result);
  return result;
}

/** Types whose whole purpose is to authorize someone to move your assets. */
const RISKY_PRIMARY_TYPES = new Set([
  "Permit",
  "PermitSingle",
  "PermitBatch",
  "PermitTransferFrom",
  "PermitBatchTransferFrom",
  "PermitTransferFromWithPermit",
]);

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

/**
 * Fields where the maximum value means "unlimited spending power".
 *
 * Deliberately an allowlist, not "any field equal to 2^256-1". A deadline of
 * uint256 max means "never expires", not "the whole balance" -- treating every
 * max-valued field as a spending limit produced exactly that false claim, and a
 * security tool that misreads a timestamp as a money amount is worse than one
 * that says nothing.
 */
const SPEND_LIMIT_FIELDS = new Set([
  "value", "amount", "allowance", "amountallowed", "amountallowedmax",
  "tokenamount", "permitted", "maximumamount",
]);

/** A spender is whoever gets the authority; these are the field names that give it. */
const COUNTERPARTY_FIELDS = new Set(["spender", "operator", "to", "recipient"]);

function flattenMessage(prefix, value, out) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, sub] of Object.entries(value)) flattenMessage(`${prefix}${key}.`, sub, out);
  } else if (Array.isArray(value)) {
    value.forEach((sub, i) => flattenMessage(`${prefix}[${i}].`, sub, out));
  } else {
    out.push([prefix.replace(/\.$/, ""), value]);
  }
}

/**
 * What is known about an address that is about to receive signing authority.
 *
 * Reports FACTS from the chain and nothing else. It deliberately does not say
 * "drainer": that claim needs labels, labels rotate, and a wrong label is worse
 * than no label. What it can say is checkable by anyone against the same node:
 * whether there is code, how big it is, and whether the account has ever acted.
 *
 * The shape that matters is an address with no code and no history receiving
 * unlimited authority. That is not proof of anything, and it is not presented
 * as such -- it is the reason to look twice.
 */
export async function inspectSpender(rpc, address) {
  const result = { address, isContract: null, codeSize: null, txCount: null, balanceWei: null, findings: [] };
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ""))) {
    result.findings.push({ level: "info", message: "Not an address; nothing to look up." });
    return result;
  }

  try {
    const code = await rpc.getCode(address);
    const hex = typeof code === "string" ? code.replace(/^0x/, "") : "";
    result.codeSize = hex.length / 2;
    result.isContract = result.codeSize > 0;
  } catch (error) {
    result.findings.push({ level: "info", message: `Could not read code: ${error.message}` });
    return result;
  }

  try {
    result.txCount = await rpc.getTransactionCount(address);
  } catch {
    /* history is a nicety; absence is not evidence */
  }
  try {
    result.balanceWei = await rpc.getBalance(address);
  } catch {
    /* same */
  }

  if (!result.isContract) {
    result.findings.push({
      level: "info",
      message:
        "No code at this address. It is a plain account, so whatever authority you grant sits with whoever holds that key.",
    });
    // Only meaningful for an EOA: contracts are usually *called*, not callers,
    // so a low txCount on a busy router is normal and says nothing.
    if (result.txCount === 0) {
      result.findings.push({
        level: "notable",
        message:
          "This account has never sent a transaction. An address with no history receiving authority is the classic shape of a receiving wallet, though it can also be a legitimate fresh one.",
      });
    }
  } else if (result.codeSize < 100) {
    result.findings.push({
      level: "notable",
      message: `Only ${result.codeSize} bytes of code. That is small enough to be a forwarder rather than a real protocol; check what it forwards to.`,
    });
  } else {
    result.findings.push({
      level: "info",
      message:
        `Contract, ${result.codeSize} bytes of code. Note that a contract's transaction count ` +
        "counts only transactions it originated, so it is usually low even for a heavily-used " +
        "protocol. Inspect the code separately before trusting it with authority.",
    });
  }

  return result;
}

/**
 * Find whoever receives authority in a flattened payload: the fields that name
 * a counterparty. Returns the parsed values, in order, without duplicates.
 */
export function counterpartiesFrom(fields) {
  const seen = new Set();
  const out = [];
  for (const f of fields ?? []) {
    const leaf = f.path.split(".").pop().toLowerCase();
    if (!COUNTERPARTY_FIELDS.has(leaf)) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(f.value)) continue;
    const key = f.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: f.path, address: f.value });
  }
  return out;
}

/** keccak4 selectors for the reads permit-liveness needs. Derived, not hardcoded. */
const ALLOWANCE_SELECTOR = selector("allowance(address,address)");
const NONCES_SELECTOR = selector("nonces(address)");

/** The canonical "never expires" sentinel, per the EIP-2612 rationale. */
const NEVER_EXPIRES = (1n << 256n) - 1n;

/**
 * Is a Permit signature still able to be used?
 *
 * EIP-2612 says permit sets allowance[owner][spender] = value and increments
 * nonces[owner]. So the nonce is the mechanism, not a hint: if the token still
 * reports the payload's nonce for that owner, the signature has NOT been
 * submitted, and whoever holds it can submit it at any time before the deadline.
 *
 * This is what separates "you are being drained right now" from "you are being
 * handed a knife that the attacker keeps". Both are bad; only the second is
 * recoverable, and only if you know it is there.
 */
export async function checkPermitLiveness(rpc, { token, owner, spender, nonce, deadline, value }) {
  const out = {
    token: token ?? null,
    owner: owner ?? null,
    spender: spender ?? null,
    onchainNonce: null,
    signatureUnspent: null,
    allowance: null,
    allowanceUnlimited: null,
    neverExpires: null,
    expired: null,
    findings: [],
  };

  if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    out.findings.push({
      level: "notable",
      message:
        "No token address to check against, so whether this permit is still usable cannot be determined.",
    });
    return out;
  }

  // --- does it ever expire? ----------------------------------------------
  // Checked BEFORE the liveness message, because whether the signature is still
  // usable depends on whether the deadline has passed. Composing the "can be
  // used later" sentence first produced a contradiction: a permit that had
  // already expired was described as usable "at any time".
  if (deadline !== undefined && deadline !== null) {
    try {
      const d = BigInt(String(deadline));
      out.neverExpires = d === NEVER_EXPIRES;
      const now = BigInt(Math.floor(Date.now() / 1000));
      out.expired = !out.neverExpires && d <= now;
      if (out.neverExpires) {
        out.findings.push({
          level: "high",
          message:
            "deadline is the maximum uint256, which EIP-2612 documents as the way to make a permit " +
            "that effectively never expires. The signature stays usable until the nonce is consumed.",
        });
      } else if (out.expired) {
        out.findings.push({
          level: "info",
          message: `deadline ${d} is in the past, so this permit can no longer be submitted.`,
        });
      } else {
        const secs = d - now;
        out.findings.push({
          level: "notable",
          message:
            `deadline ${d} is in the future (about ${Math.round(secs / 86400)} days away), so this ` +
            "signature remains usable until then.",
        });
      }
    } catch {
      /* not a number; skip the check */
    }
  }

  // --- does the signature still work? -------------------------------------
  if (owner && nonce !== undefined && nonce !== null) {
    const raw = await tryCall(rpc, token, NONCES_SELECTOR + encodeAddressWord(owner));
    if (raw) {
      try {
        const onchain = BigInt(raw);
        out.onchainNonce = onchain;
        const payloadNonce = BigInt(String(nonce));
        out.signatureUnspent = onchain === payloadNonce;
        if (out.signatureUnspent) {
          let usability = " at any time until it expires.";
          if (out.neverExpires) usability = " at any time — it never expires.";
          if (out.expired) usability = " — except the deadline has passed, so it can no longer be used.";
          out.findings.push({
            level: "high",
            message:
              `This permit has NOT been submitted yet (on-chain nonce ${onchain} still matches the ` +
              `payload). Whoever holds this signature can submit it${usability}`,
          });
        } else {
          out.findings.push({
            level: "info",
            message:
              `This permit has already been used (on-chain nonce ${onchain} is past the payload's ` +
              `${payloadNonce}), so this signature is no longer executable.`,
          });
        }
      } catch {
        /* a non-numeric return is not a nonce */
      }
    } else {
      out.findings.push({
        level: "notable",
        message: "The token exposes no nonces(address), so the signature's liveness cannot be checked.",
      });
    }
  }

  // --- what is actually open right now? ----------------------------------
  if (owner && spender) {
    const raw = await tryCall(
      rpc,
      token,
      ALLOWANCE_SELECTOR + encodeAddressWord(owner) + encodeAddressWord(spender)
    );
    if (raw) {
      try {
        const a = BigInt(raw);
        out.allowance = a.toString();
        out.allowanceUnlimited = a === (1n << 256n) - 1n || a === (1n << 160n) - 1n;
        if (out.allowanceUnlimited) {
          out.findings.push({
            level: "high",
            message:
              `The token currently reports an UNLIMITED allowance from ${owner} to ${spender}. ` +
              "That authority is live on-chain now and does not need the signature.",
          });
        } else if (a > 0n) {
          out.findings.push({
            level: "notable",
            message: `The token currently reports an allowance of ${a} from owner to spender.`,
          });
        }
      } catch {
        /* not a number */
      }
    }
  }

  return out;
}

/** Left-pad an address into a 32-byte ABI word, without a bignumber library. */
function encodeAddressWord(address) {
  return String(address).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

/**
 * Verify a signed (or to-be-signed) eth_signTypedData_v4 payload.
 *
 * The domain comparison says whether the contract will ACCEPT the signature.
 * It says nothing about whether the signature is something you want to give.
 * So the message fields are flattened and checked against the shapes that
 * actually drain wallets — unlimited approvals and operator grants — because
 * that is the part a domain check cannot see.
 */
export async function inspectPayload(rpc, payload, options = {}) {
  const { signature = null, expectedSigner = null, checkOnchain = false } = options;
  const domain = payload?.domain ?? {};
  const types = payload?.types ?? {};
  const primary = payload?.primaryType ?? payload?.primary_type ?? null;
  const message = payload?.message ?? {};

  const result = {
    primaryType: primary,
    domain,
    digest: null,
    signer: null,
    fields: [],
    findings: [],
  };

  if (!primary) {
    result.findings.push({ level: "info", message: "Payload has no primaryType; nothing to hash." });
    return result;
  }

  // Flatten the message first: this is what the signature actually authorizes,
  // and it is independent of whether the domain check later passes.
  const flat = [];
  flattenMessage("", message, flat);
  result.fields = flat.map(([path, value]) => {
    const isBigIntish =
      (typeof value === "string" && /^\d+$/.test(value)) || typeof value === "bigint";
    let unlimited = false;
    if (isBigIntish) {
      try {
        const n = BigInt(value);
        const leaf = path.split(".").pop().toLowerCase();
        // Only a field that IS a spending limit can be an unlimited one.
        unlimited =
          SPEND_LIMIT_FIELDS.has(leaf) && (n === MAX_UINT256 || n === MAX_UINT160);
      } catch {
        /* not an integer after all */
      }
    }
    return { path, value: String(value), unlimited };
  });

  // The drain shapes, checked before anything reassuring is said.
  if (RISKY_PRIMARY_TYPES.has(primary)) {
    result.findings.push({
      level: "high",
      message: `'${primary}' is an authorization, not a payment. Approving it lets the counterparty move assets without a further confirmation from you.`,
    });
  }
  for (const f of result.fields) {
    if (!f.unlimited) continue;
    result.findings.push({
      level: "high",
      message: `UNLIMITED at '${f.path}'. This grants access to the entire balance, not just what you are spending now.`,
    });
  }
  for (const f of result.fields) {
    const leaf = f.path.split(".").pop().toLowerCase();
    if (COUNTERPARTY_FIELDS.has(leaf) && /^0x[0-9a-fA-F]{40}$/.test(f.value)) {
      result.findings.push({
        level: "notable",
        message: `'${f.path}' = ${f.value} is who receives this authority. Verify that is an address you intend to trust.`,
      });
    }
  }
  result.drainShaped = result.findings.some((f) => f.level === "high");

  let digest;
  try {
    digest = hashTypedData(domain, types, primary, message);
  } catch (error) {
    result.findings.push({
      level: "notable",
      message: `Could not compute the EIP-712 digest: ${error.message}`,
    });
    return result;
  }
  result.digest = toHex(digest);

  // Treat anything that is not 65 bytes of hex as "no signature given" rather
  // than reporting a recovery failure. A stray character in an optional field
  // should not read as "your payload is broken".
  const sig = typeof signature === "string" ? signature.trim() : signature;
  const usableSig =
    sig && (/^0x[0-9a-fA-F]{130}$/.test(sig) || (sig instanceof Uint8Array && sig.length === 65));

  if (usableSig) {
    try {
      const signer = recoverAddress(digest, sig);
      result.signer = signer;
      result.findings.push({ level: "info", message: `Signature recovers to ${signer}.` });
      if (expectedSigner && signer.toLowerCase() !== expectedSigner.toLowerCase()) {
        result.findings.push({
          level: "high",
          message: `Recovered signer ${signer} is NOT the expected ${expectedSigner}.`,
        });
      }
    } catch (error) {
      result.findings.push({ level: "high", message: `Signature could not be recovered: ${error.message}` });
    }
  } else if (sig) {
    result.findings.push({
      level: "notable",
      message:
        "A signature was supplied but it is not a 65-byte hex value, so the signer was not recovered. " +
        "The digest above is still correct for this payload.",
    });
  }

  const verifying = domain?.verifyingContract;

  // Chain identity is checked before anything else, because every other read
  // below is meaningless if the endpoint is on the wrong chain.
  let chainMismatch = false;
  if (options.checkChain !== false) {
    result.chain = await checkChainMatch(rpc, payload);
    for (const f of result.chain.findings) result.findings.push(f);
    chainMismatch = result.chain.matches === false;
  }

  // Comparing separators across chains compares unrelated contracts, so skip it
  // rather than reporting a coincidence as agreement.
  if (checkOnchain && verifying && !chainMismatch) {
    const separator = await tryCall(rpc, verifying, DOMAIN_SEPARATOR_SELECTOR);
    if (separator) {
      const onchain = norm32(separator);
      const local = toHex(domainSeparator(domain, types));
      if (local !== onchain) {
        result.findings.push({
          level: "high",
          message:
            "This payload's domain does not match the verifying contract's DOMAIN_SEPARATOR(). A wallet signing it will produce a signature the contract rejects.",
        });
        result.onchainMatch = false;
      } else {
        result.onchainMatch = true;
        result.findings.push({
          level: "info",
          message: "Payload domain matches the verifying contract's on-chain separator.",
        });
      }
      result.onchainSeparator = onchain;
    } else {
      result.findings.push({
        level: "notable",
        message: "The verifying contract exposes no DOMAIN_SEPARATOR(), so the domain could not be compared on-chain.",
      });
    }
  }

  // The counterparty facts. This is the layer that a domain check cannot reach:
  // a consistent domain says nothing about who ends up holding the authority.
  // Skipped entirely on a chain mismatch, where the reads describe a different
  // contract.
  if (options.inspectSpenders && !chainMismatch) {
    const parties = counterpartiesFrom(result.fields);
    result.spenders = [];
    for (const party of parties) {
      result.spenders.push({ path: party.path, ...(await inspectSpender(rpc, party.address)) });
    }
  }

  // Persistence: a permit is not a payment, it is a standing permission. The
  // question is not only "what does this grant" but "is it still executable,
  // and does it ever expire" -- i.e. can the attacker come back later.
  if (options.checkLiveness && RISKY_PRIMARY_TYPES.has(primary) && !chainMismatch) {
    const m = (key) => result.fields.find((f) => f.path.toLowerCase() === key.toLowerCase())?.value;
    result.liveness = await checkPermitLiveness(rpc, {
      token: verifying ?? m("token"),
      owner: m("owner") ?? m("from"),
      spender: m("spender") ?? m("operator"),
      nonce: m("nonce"),
      deadline: m("deadline"),
      value: m("value") ?? m("amount"),
    });
  }

  // Only claim "nothing alarming" when there is genuinely nothing alarming.
  // A drain-shaped payload (unlimited approval / authorization type) is a high
  // finding, so this branch cannot fire for it — that ordering is deliberate.
  if (!result.findings.some((f) => f.level === "high")) {
    result.findings.push({
      level: "info",
      message:
        "No domain mismatch and no drain-shaped fields found. This is not an endorsement: " +
        "check the address above against a source you trust.",
    });
  }
  return result;
}

/**
 * Which chain is the endpoint actually on, and does it match what the payload
 * claims?
 *
 * Every check in this tool reads state from the endpoint for the verifying
 * contract's address. If the endpoint is on a different chain than the payload
 * was built for, those reads describe a DIFFERENT contract -- possibly one that
 * does not exist there, possibly one that does and has nothing to do with you.
 * Reporting a confident result across that mismatch would be worse than useless,
 * so it is called out before anything else.
 */
export async function checkChainMatch(rpc, payload) {
  const claimed = payload?.domain?.chainId;
  const out = {
    endpointChainId: null,
    claimedChainId: claimed == null ? null : Number(claimed),
    matches: null,
    findings: [],
  };

  try {
    out.endpointChainId = await rpc.chainId();
  } catch (error) {
    out.findings.push({
      level: "notable",
      message: `Could not read the endpoint's chain id: ${error.message}. Results below are unverified against a chain.`,
    });
    return out;
  }

  if (out.claimedChainId === null) return out;

  out.matches = out.endpointChainId === out.claimedChainId;
  if (!out.matches) {
    out.findings.push({
      level: "high",
      message:
        `The payload says chainId ${out.claimedChainId}, but the RPC endpoint is on chain ` +
        `${out.endpointChainId}. Reads below describe whatever contract sits at that address on ` +
        `the endpoint's chain, which may be unrelated. Point the RPC field at chain ` +
        `${out.claimedChainId} before trusting this result.`,
    });
  }
  return out;
}
