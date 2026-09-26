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
    // That is not "no contract" and not a normal contract either — the behaviour
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

/**
 * Verify a signed (or to-be-signed) eth_signTypedData_v4 payload: compute the
 * digest, optionally recover the signer, optionally compare the domain against
 * the verifying contract on-chain.
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
    findings: [],
  };

  if (!primary) {
    result.findings.push({ level: "info", message: "Payload has no primaryType; nothing to hash." });
    return result;
  }

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

  if (signature) {
    try {
      const signer = recoverAddress(digest, signature);
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
  }

  const verifying = domain?.verifyingContract;
  if (checkOnchain && verifying) {
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

  if (!result.findings.some((f) => f.level === "high")) {
    result.findings.push({ level: "info", message: "No EIP-712 mismatches detected." });
  }
  return result;
}
