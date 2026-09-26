/**
 * DOM wiring only. All judgement lives in lib/inspect.js, so the page and the
 * CLI share one vocabulary and this file can stay dumb.
 */

import { Rpc } from "./lib/rpc.js";
import { inspectContract, inspectPayload } from "./lib/inspect.js";

let rpc = new Rpc();

const $ = (id) => document.getElementById(id);

/**
 * Worked examples, so the page can be understood without a real request in hand.
 * The drain one is a genuine USDC Permit asking for an unlimited, never-expiring
 * allowance: every check should fire on it, which is the best way to see what
 * the tool does.
 */
const SAMPLES = {
  drain: {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 1,
      verifyingContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    message: {
      owner: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      spender: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      nonce: "0",
      deadline: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    },
  },
  safe: {
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Mail: [{ name: "contents", type: "string" }],
    },
    primaryType: "Mail",
    domain: { name: "Example App" },
    message: { contents: "hello, this signature moves nothing" },
  },
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/**
 * Status labels are deliberately non-binary, and `compatible` is deliberately
 * NOT called "safe" or even "ok".
 *
 * A domain that hashes correctly proves ONE thing: the contract and the wallet
 * agree on the string they hash. It does not mean the contract is legitimate. A
 * Permit drainer will pass this check, and that is the outcome the attacker
 * wants, so presenting it as a green tick would be a lie by layout. The loud
 * result (MISMATCH) is a compatibility bug; the reassuring result is the one
 * that can be misleading. Both are stated as what they are.
 */
const STATUS_LABELS = {
  ok: { text: "domain is consistent", cls: "ok" },
  mismatch: { text: "INCOMPATIBLE", cls: "high" },
  unverified: { text: "cannot verify", cls: "notable" },
  no_domain: { text: "no EIP-712 domain found", cls: "info" },
  no_contract: { text: "no contract here", cls: "notable" },
  delegated: { text: "EIP-7702 delegated", cls: "notable" },
  error: { text: "error", cls: "high" },
};

/**
 * What a consistent domain does and does not tell you. Rendered under every
 * positive result, because omitting it is how the page would imply safety.
 */
const CONSISTENCY_CAVEAT =
  "This means the contract and a wallet agree on the domain they hash. " +
  "It does NOT mean the contract is trustworthy. A malicious contract that " +
  "asks for an unlimited approval will pass this check — the signature is " +
  "still valid, and it is still a drain. Read the message fields, not the colour.";

function findingHtml(f) {
  return `<li class="finding"><span class="level ${f.level}">${f.level}</span>${escapeHtml(f.message)}</li>`;
}

function rowsHtml(pairs) {
  return pairs
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(
      ([key, value]) =>
        `<div class="kv"><span class="k">${escapeHtml(key)}</span><span class="v mono">${escapeHtml(value)}</span></div>`
    )
    .join("");
}

function renderContract(result) {
  if (result.error) {
    return `<div class="card"><p class="bad">${escapeHtml(result.error)}</p></div>`;
  }
  const label = STATUS_LABELS[result.status] ?? { text: result.status, cls: "info" };
  const d = result.declaredDomain ?? {};

  const parts = [];
  parts.push(`<div class="card">
    <div class="verdict"><span class="pill ${label.cls}">${label.text}</span>
      <span class="mono dim">${escapeHtml(result.address)}</span></div>`);

  if (result.status === "no_contract") {
    parts.push(`<ul class="findings">${result.findings.map(findingHtml).join("")}</ul></div>`);
    return parts.join("");
  }

  // A delegated account has no domain of its own: show the target and stop,
  // rather than rendering an empty table that implies something was checked.
  if (result.status === "delegated") {
    parts.push(
      rowsHtml([
        ["delegation target", result.delegationTarget],
        ["target separator", result.onchainSeparator ?? "(none)"],
      ])
    );
    parts.push(`<ul class="findings">${result.findings.map(findingHtml).join("")}</ul></div>`);
    return parts.join("");
  }

  parts.push(
    rowsHtml([
      ["declaration", result.declarationSource],
      ["name", d.name],
      ["version", d.version],
      ["chainId", d.chainId],
      ["verifyingContract", d.verifyingContract],
      ["salt", d.salt],
    ])
  );

  if (result.extensions?.length) {
    parts.push(rowsHtml([["extensions", result.extensions.join(", ")]]));
  }

  if (result.onchainSeparator || result.recomputedSeparator) {
    const cmp =
      result.match === true
        ? `<span class="pill ok">equal</span>`
        : result.match === false
          ? `<span class="pill high">different</span>`
          : `<span class="pill notable">not compared</span>`;
    parts.push(`<div class="seps">
      <div class="kv"><span class="k">on-chain</span><span class="v mono">${escapeHtml(result.onchainSeparator ?? "(none)")}</span></div>
      <div class="kv"><span class="k">recomputed</span><span class="v mono">${escapeHtml(result.recomputedSeparator ?? "(not computed)")}</span></div>
      <div class="kv"><span class="k">result</span><span class="v">${cmp}</span></div>
    </div>`);
  }

  parts.push(`<ul class="findings">${result.findings.map(findingHtml).join("")}</ul>`);

  // A consistent domain must carry its caveat inline, every time. Omitting it
  // is what would turn this page into a false assurance.
  if (result.status === "ok") {
    parts.push(`<p class="caveat">${escapeHtml(CONSISTENCY_CAVEAT)}</p>`);
  }
  parts.push(`</div>`);
  return parts.join("");
}

function renderPayload(result) {
  if (result.error) return `<div class="card"><p class="bad">${escapeHtml(result.error)}</p></div>`;
  const parts = [`<div class="card">`];

  if (!result.digest) {
    parts.push(`<ul class="findings">${result.findings.map(findingHtml).join("")}</ul></div>`);
    return parts.join("");
  }

  const d = result.domain ?? {};
  parts.push(
    rowsHtml([
      ["primaryType", result.primaryType],
      ["domain.name", d.name],
      ["domain.version", d.version],
      ["domain.chainId", d.chainId],
      ["domain.verifyingContract", d.verifyingContract],
      ["digest", result.digest],
      ["signer", result.signer],
    ])
  );

  // Chain identity comes first: if the endpoint is on another chain, nothing
  // below describes the contract you think it does.
  if (result.chain?.matches === false) {
    parts.push(
      `<p><span class="pill high">WRONG CHAIN</span> <span class="dim">endpoint is on chain ${escapeHtml(result.chain.endpointChainId)}, payload says ${escapeHtml(result.chain.claimedChainId)}</span></p>`
    );
  } else if (result.chain?.matches === true) {
    parts.push(
      `<p><span class="pill ok">chain ${escapeHtml(result.chain.endpointChainId)} — matches the payload</span></p>`
    );
  }

  // The message fields are the part that can actually cost money, so they get
  // their own block rather than being folded into the summary above. The domain
  // check says nothing about them.
  if (result.fields?.length) {
    parts.push(`<h3 class="subhead">what this signature authorises</h3>`);
    parts.push(
      `<div class="fields">` +
        result.fields
          .map(
            (f) =>
              `<div class="kv"><span class="k">${escapeHtml(f.path)}</span>` +
              `<span class="v mono${f.unlimited ? " unlimited" : ""}">${escapeHtml(f.value)}</span></div>`
          )
          .join("") +
        `</div>`
    );
  }

  if (result.onchainMatch === true) {
    parts.push(`<p><span class="pill ok">domain is consistent on-chain</span></p>`);
    parts.push(`<p class="caveat">${escapeHtml(CONSISTENCY_CAVEAT)}</p>`);
  } else if (result.onchainMatch === false) {
    parts.push(`<p><span class="pill high">domain does NOT match on-chain — the contract would reject this signature</span></p>`);
  }

  // Who ends up holding the authority. Rendered after the fields, because the
  // facts only mean something once you have seen what is being granted.
  if (result.spenders?.length) {
    parts.push(`<h3 class="subhead">who receives this authority</h3>`);
    for (const s of result.spenders) {
      parts.push(`<div class="spender">`);
      parts.push(
        rowsHtml([
          ["field", s.path],
          ["address", s.address],
          ["has code", s.isContract === null ? "unknown" : s.isContract ? `yes (${s.codeSize} bytes)` : "no — plain account"],
          ["txs sent", s.txCount === null ? "unknown" : String(s.txCount)],
          ["balance", s.balanceWei === null ? "unknown" : `${formatWei(s.balanceWei)} ETH`],
        ])
      );
      parts.push(`<ul class="findings">${s.findings.map(findingHtml).join("")}</ul>`);
      parts.push(`</div>`);
    }
  }

  // Persistence. This is the "can they come back later" answer, so it renders
  // with its own heading rather than being folded into the findings list.
  if (result.liveness) {
    const L = result.liveness;
    parts.push(`<h3 class="subhead">can this be used against you later?</h3>`);
    parts.push(
      `<div class="fields">` +
        rowsHtml([
          ["signature spent", L.signatureUnspent === null ? "unknown" : L.signatureUnspent ? "NOT yet used — still executable" : "already used"],
          ["on-chain nonce", L.onchainNonce === null ? "unknown" : String(L.onchainNonce)],
          ["expires", L.neverExpires === null ? "unknown" : L.neverExpires ? "never (deadline = uint256 max)" : L.expired ? "already expired" : "in the future"],
          ["allowance now", L.allowance === null ? "unknown" : L.allowanceUnlimited ? "UNLIMITED" : L.allowance],
        ]) +
        `</div>`
    );
    parts.push(`<ul class="findings">${L.findings.map(findingHtml).join("")}</ul>`);
  }

  parts.push(`<ul class="findings">${result.findings.map(findingHtml).join("")}</ul></div>`);
  return parts.join("");
}

/** Wei to a short ETH string, without pulling in a bignumber library. */
function formatWei(wei) {
  const n = BigInt(wei);
  if (n === 0n) return "0";
  const whole = n / 10n ** 18n;
  const frac = n % 10n ** 18n;
  if (whole > 0n) return String(whole) + "." + String(frac).padStart(18, "0").slice(0, 4);
  // Below 1 ETH, show enough decimals to tell dust from real funding.
  const fracStr = String(frac).padStart(18, "0").slice(0, 8).replace(/0+$/, "");
  return fracStr ? "0." + fracStr : "<0.00000001";
}

function busy(out, message) {
  out.innerHTML = `<div class="card"><p class="dim">${escapeHtml(message)}</p></div>`;
}

function failed(out, error) {
  out.innerHTML = `<div class="card"><p class="bad">${escapeHtml(error.message ?? error)}</p></div>`;
}

/** True when the RPC field holds something that is not an endpoint. */
function rpcUrlLooksWrong() {
  const raw = $("rpc-url").value.trim();
  return raw !== "" && !/^https?:\/\/\S+$/i.test(raw);
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
$("rpc-apply").addEventListener("click", async () => {
  const raw = $("rpc-url").value.trim();
  const status = $("rpc-status");

  // This field sits at the top of the page, so it is the first thing someone
  // pastes into -- and a pasted signing payload is not an endpoint. Catching
  // that here beats letting it become a URL and failing with a 405 whose error
  // message quotes the entire payload back at the user.
  if (raw && !/^https?:\/\/\S+$/i.test(raw)) {
    status.textContent =
      "That does not look like an endpoint. An RPC URL starts with https:// — a signing payload goes in the Signed payload tab instead.";
    status.className = "hint bad";
    return;
  }
  rpc = new Rpc(raw || null);
  await showRpcStatus();
});

/** Chain names, so a non-Ethereum endpoint is identifiable at a glance. */
const CHAIN_NAMES = {
  1: "Ethereum mainnet",
  10: "OP Mainnet",
  56: "BNB Chain",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
  4663: "Robinhood Chain",
  43114: "Avalanche C-Chain",
};

async function showRpcStatus() {
  const status = $("rpc-status");
  status.textContent = "checking…";
  status.className = "hint";
  try {
    const chainId = await rpc.chainId();
    const name = CHAIN_NAMES[chainId] ? ` (${CHAIN_NAMES[chainId]})` : "";
    status.textContent = `connected — chain ${chainId}${name} via ${rpc.lastUrl}`;
    status.className = "hint ok-text";
  } catch (error) {
    status.textContent = String(error.message ?? error);
    status.className = "hint bad";
  }
}

$("inspect").addEventListener("click", async () => {
  const address = $("address").value.trim();
  const out = $("contract-out");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    failed(out, new Error("Enter a 0x-prefixed 20-byte contract address."));
    return;
  }
  const name = $("exp-name").value.trim();
  const version = $("exp-version").value.trim();
  const expected = name ? { name, ...(version ? { version } : {}) } : null;
  busy(out, "reading the chain…");
  try {
    out.innerHTML = renderContract(await inspectContract(rpc, address, expected));
  } catch (error) {
    failed(out, error);
  }
});

$("check-payload").addEventListener("click", async () => {
  const out = $("payload-out");
  let payload;
  const rawBox = $("payload").value;
  try {
    payload = JSON.parse(rawBox);
  } catch (error) {
    failed(out, new Error(`That is not valid JSON: ${error.message}`));
    return;
  }
  // Tolerate a wrapper like {"params": [address, data]} by picking the object.
  if (!payload.types && Array.isArray(payload.params)) {
    payload = payload.params.find((p) => p && typeof p === "object" && p.types) ?? payload;
  }

  // Re-render the box from what is actually being checked. A normalised display
  // costs nothing and removes a real hazard: if the box shows one payload while
  // a different one was parsed, the user reads a result for something they did
  // not paste.
  $("payload").value = JSON.stringify(payload, null, 2);

  const signature = $("signature").value.trim() || null;

  // Guard the whole check on a usable endpoint. If the RPC field holds something
  // that is not a URL, every read below fails and the failures quote that value
  // back -- which is how a pasted payload ends up in five error messages at once.
  if (rpcUrlLooksWrong()) {
    failed(
      out,
      new Error(
        "The RPC endpoint field does not contain a URL, so nothing can be read from a chain. " +
          "Clear it, or put an https:// endpoint there. A signing payload belongs in this box, not that one."
      )
    );
    return;
  }

  busy(out, "computing the digest…");
  try {
    const result = await inspectPayload(rpc, payload, {
      signature,
      checkOnchain: $("check-onchain").checked,
      inspectSpenders: $("check-spenders").checked,
      checkLiveness: $("check-liveness").checked,
    });
    out.innerHTML = renderPayload(result);
  } catch (error) {
    failed(out, error);
  }
});

for (const [id, key] of [["sample-drain", "drain"], ["sample-safe", "safe"]]) {
  $(id).addEventListener("click", () => {
    $("payload").value = JSON.stringify(SAMPLES[key], null, 2);
    $("signature").value = "";
    $("check-payload").click();
  });
}

// The test trigger. It stays on the page rather than navigating immediately,
// because the explanation is the point: a user who does not know they can
// produce a signature prompt on demand cannot test anything.
$("open-trigger").addEventListener("click", () => {
  const note = $("trigger-note");
  note.hidden = !note.hidden;
  if (!note.hidden) note.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("close-trigger").addEventListener("click", () => {
  $("trigger-note").hidden = true;
});

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) {
      const active = t === tab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    }
    for (const panel of document.querySelectorAll(".panel")) {
      panel.classList.toggle("active", panel.id === `panel-${tab.dataset.tab}`);
    }
  });
}

// Probe the endpoint once on load, so the status line reflects reality rather
// than sitting on its initial hint while everything already works.
showRpcStatus();

// Deep-link support. Two shapes are accepted:
//   ?address=0x…&name=…&version=…   from a shared link
//   #payload=<json>&signature=0x…   from the test trigger's handoff
// The payload travels in the fragment, so it is never sent to any server.
function loadFromUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get("address")) {
    $("address").value = params.get("address");
    if (params.get("name")) $("exp-name").value = params.get("name");
    if (params.get("version")) $("exp-version").value = params.get("version");
    $("inspect").click();
    return;
  }

  const hash = new URLSearchParams((location.hash ?? "").replace(/^#/, ""));
  const payload = hash.get("payload");
  if (!payload) return;
  try {
    const parsed = JSON.parse(payload);
    document.querySelector('.tab[data-tab="payload"]').click();
    $("payload").value = JSON.stringify(parsed, null, 2);
    if (hash.get("signature")) $("signature").value = hash.get("signature");
    $("check-payload").click();
  } catch {
    /* a malformed handoff is not worth an error banner */
  }
}

loadFromUrl();
