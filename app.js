/**
 * DOM wiring only. All judgement lives in lib/inspect.js, so the page and the
 * CLI share one vocabulary and this file can stay dumb.
 */

import { Rpc } from "./lib/rpc.js";
import { inspectContract, inspectPayload } from "./lib/inspect.js";

let rpc = new Rpc();

const $ = (id) => document.getElementById(id);

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

  parts.push(`<ul class="findings">${result.findings.map(findingHtml).join("")}</ul></div>`);
  return parts.join("");
}

function busy(out, message) {
  out.innerHTML = `<div class="card"><p class="dim">${escapeHtml(message)}</p></div>`;
}

function failed(out, error) {
  out.innerHTML = `<div class="card"><p class="bad">${escapeHtml(error.message ?? error)}</p></div>`;
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
$("rpc-apply").addEventListener("click", async () => {
  const url = $("rpc-url").value.trim();
  rpc = new Rpc(url || null);
  await showRpcStatus();
});

async function showRpcStatus() {
  const status = $("rpc-status");
  status.textContent = "checking…";
  status.className = "hint";
  try {
    const chainId = await rpc.chainId();
    status.textContent = `connected — chainId ${chainId} via ${rpc.lastUrl}`;
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
  try {
    payload = JSON.parse($("payload").value);
  } catch (error) {
    failed(out, new Error(`That is not valid JSON: ${error.message}`));
    return;
  }
  // Tolerate a wrapper like {"params": [address, data]} by picking the object.
  if (!payload.types && Array.isArray(payload.params)) {
    payload = payload.params.find((p) => p && typeof p === "object" && p.types) ?? payload;
  }
  const signature = $("signature").value.trim() || null;
  busy(out, "computing the digest…");
  try {
    const result = await inspectPayload(rpc, payload, {
      signature,
      checkOnchain: $("check-onchain").checked,
    });
    out.innerHTML = renderPayload(result);
  } catch (error) {
    failed(out, error);
  }
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

// Deep-link support: ?address=0x… pre-fills and runs, so a report can be shared.
const params = new URLSearchParams(location.search);
if (params.get("address")) {
  $("address").value = params.get("address");
  if (params.get("name")) $("exp-name").value = params.get("name");
  if (params.get("version")) $("exp-version").value = params.get("version");
  $("inspect").click();
}
