/**
 * DOM wiring for three views: Check (the tool), Learn (explanation), Test (a
 * signing trigger). All judgement lives in lib/inspect.js, so this file stays
 * dumb and the page and the CLI speak one vocabulary.
 */

import { Rpc } from "./lib/rpc.js";
import { inspectContract, inspectPayload } from "./lib/inspect.js";

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------------------------------------------------------------------------
// Example payloads. Shared by Learn (load and check) and Test (sign it).
// ---------------------------------------------------------------------------
function unlimitedPermit(chainId, verifyingContract) {
  return {
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
    domain: { name: "USD Coin", version: "2", chainId, verifyingContract },
    message: {
      owner: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      spender: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      nonce: "0",
      deadline: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    },
  };
}

function harmlessMessage(chainId, verifyingContract) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Mail: [{ name: "contents", type: "string" }],
    },
    primaryType: "Mail",
    domain: { name: "ClearSign example", version: "1", chainId, verifyingContract },
    message: { contents: "this signature authorises nothing" },
  };
}

// ---------------------------------------------------------------------------
// Wallet layer. Any EVM wallet, discovered per EIP-6963.
// ---------------------------------------------------------------------------
const discovered = [];
let selectedUuid = null;
let account = null;
let currentChainId = null;

function activeProvider() {
  const chosen = discovered.find((d) => d.info.uuid === selectedUuid);
  return chosen?.provider ?? discovered[0]?.provider ?? window.ethereum ?? null;
}

function activeWalletName() {
  const chosen = discovered.find((d) => d.info.uuid === selectedUuid);
  return chosen?.info.name ?? discovered[0]?.info.name ?? (window.ethereum ? "a browser wallet" : null);
}

function discoverWallets(onChange) {
  const seen = new Set();

  /**
   * Only keep wallets that can actually answer an EVM call.
   *
   * Multi-chain wallets announce an Ethereum provider whether or not they are
   * currently pointed at an EVM network -- Tezos and Solana wallets included,
   * since that is what the spec says a provider should do. But this page signs
   * typed data, which a wallet sitting on a non-EVM chain cannot do. Listing it
   * would offer a choice that fails on click.
   *
   * The test is a capability, not a name: a wallet that cannot answer
   * eth_chainId cannot help here. The spec explicitly says rdns must not be used
   * for feature detection (it is self-attested and imitable), so there is no
   * allowlist of "real EVM wallets" -- and it would rot if there were.
   */
  const admits = (provider) =>
    new Promise((resolve) => {
      if (!provider?.request) return resolve(false);
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      // A wallet that never answers must not stall the list forever.
      const timer = setTimeout(() => done(false), 1500);
      Promise.resolve()
        .then(() => provider.request({ method: "eth_chainId" }))
        .then((id) => {
          clearTimeout(timer);
          done(typeof id === "string" && /^0x[0-9a-f]+$/i.test(id));
        })
        .catch(() => {
          clearTimeout(timer);
          done(false);
        });
    });

  window.addEventListener("eip6963:announceProvider", async (event) => {
    const detail = event.detail;
    // Duplicates must be dropped by uuid: some wallets re-announce on every
    // request, and a list showing the same wallet five times is worse than useless.
    if (!detail?.info?.uuid || seen.has(detail.info.uuid)) return;
    seen.add(detail.info.uuid);
    if (await admits(detail.provider)) {
      discovered.push(detail);
      onChange?.();
    }
  });

  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // Legacy wallets never announce. Give the standard ones a moment first.
  setTimeout(() => {
    if (!discovered.length && window.ethereum) onChange?.();
  }, 300);
}

async function refreshWallet() {
  const status = $("wallet-status");
  const provider = activeProvider();
  if (!provider) {
    status.textContent =
      "no wallet detected — install any EVM wallet, or open this page in one's built-in browser";
    status.className = "hint bad";
    renderWalletPicker();
    return;
  }
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    account = accounts?.[0] ?? null;
    const chainHex = await provider.request({ method: "eth_chainId" });
    currentChainId = Number(BigInt(chainHex));
    const name = activeWalletName();
    status.textContent = account
      ? `connected ${account.slice(0, 6)}…${account.slice(-4)} on chain ${currentChainId}${name ? ` via ${name}` : ""}`
      : `${name ?? "wallet"} detected but not connected`;
    status.className = account ? "hint ok-text" : "hint";
  } catch (error) {
    status.textContent = `could not read the wallet: ${error.message}`;
    status.className = "hint bad";
  }
  renderWalletPicker();
}

/** A picker with one option is noise, so it only appears when there is a choice. */
function renderWalletPicker() {
  const box = $("wallet-picker");
  if (!box) return;
  if (discovered.length < 2) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML =
    discovered
      .map((d, i) => {
        const isActive = selectedUuid ? d.info.uuid === selectedUuid : i === 0;
        return `<button type="button" class="wallet-choice${isActive ? " active" : ""}" data-uuid="${escapeHtml(d.info.uuid)}">
          <img src="${escapeHtml(d.info.icon)}" alt="" width="20" height="20" />
          ${escapeHtml(d.info.name)}
        </button>`;
      })
      .join("") +
    // Say why a wallet the user owns may be missing. Otherwise an absent Temple
    // or Phantom reads as a bug rather than as "that one is on another chain".
    `<p class="hint">Only wallets currently on an EVM network are listed. A
      multi-chain wallet that is sitting on a non-EVM chain, or one that cannot
      sign Ethereum typed data, is left out — switch it to an EVM network and
      reload if you expected it here.</p>`;

  for (const btn of box.querySelectorAll(".wallet-choice")) {
    btn.addEventListener("click", async () => {
      selectedUuid = btn.dataset.uuid;
      account = null;
      await refreshWallet();
    });
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function showView(name) {
  for (const v of document.querySelectorAll(".view")) {
    v.classList.toggle("active", v.id === `view-${name}`);
  }
  for (const b of document.querySelectorAll(".navbtn[data-view]")) {
    b.classList.toggle("active", b.dataset.view === name);
  }
  location.hash = name === "check" ? "" : name;
}

for (const btn of document.querySelectorAll(".navbtn[data-view]")) {
  btn.addEventListener("click", () => showView(btn.dataset.view));
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------
let rpc = new Rpc();

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

/** True when the RPC field holds something that is not an endpoint. */
function rpcUrlLooksWrong() {
  const raw = $("rpc-url").value.trim();
  return raw !== "" && !/^https?:\/\/\S+$/i.test(raw);
}

async function showRpcStatus() {
  const status = $("rpc-status");
  status.textContent = "checking…";
  status.className = "hint";
  try {
    const chainId = await rpc.chainId();
    const name = CHAIN_NAMES[chainId] ? ` (${CHAIN_NAMES[chainId]})` : "";
    status.textContent = `connected — chain ${chainId}${name}`;
    status.className = "hint ok-text";
  } catch (error) {
    status.textContent = String(error.message ?? error);
    status.className = "hint bad";
  }
}

$("rpc-apply").addEventListener("click", async () => {
  const raw = $("rpc-url").value.trim();
  const status = $("rpc-status");
  // This field also accepts a URL only. A pasted signing payload is not one, and
  // letting it through turns one mistake into a pile of reads that all fail.
  if (raw && !/^https?:\/\/\S+$/i.test(raw)) {
    status.textContent =
      "That is not an endpoint. An RPC URL starts with https:// — a signing request goes in the box above.";
    status.className = "hint bad";
    return;
  }
  rpc = new Rpc(raw || null);
  await showRpcStatus();
});

// ---------------------------------------------------------------------------
// Rendering results
// ---------------------------------------------------------------------------
const STATUS_LABELS = {
  ok: { text: "domain is consistent", cls: "ok" },
  mismatch: { text: "INCOMPATIBLE", cls: "high" },
  unverified: { text: "cannot verify", cls: "notable" },
  no_domain: { text: "no EIP-712 domain found", cls: "info" },
  no_contract: { text: "no contract here", cls: "notable" },
  delegated: { text: "EIP-7702 delegated", cls: "notable" },
  error: { text: "error", cls: "high" },
};

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

function formatWei(wei) {
  const n = BigInt(wei);
  if (n === 0n) return "0";
  const whole = n / 10n ** 18n;
  const frac = n % 10n ** 18n;
  if (whole > 0n) return String(whole) + "." + String(frac).padStart(18, "0").slice(0, 4);
  const fracStr = String(frac).padStart(18, "0").slice(0, 8).replace(/0+$/, "");
  return fracStr ? "0." + fracStr : "<0.00000001";
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
      ["what it is", result.primaryType],
      ["contract", d.verifyingContract],
      ["network", d.chainId === undefined ? null : `chain ${d.chainId}`],
      ["digest", result.digest],
      ["recovered signer", result.signer],
    ])
  );

  if (result.chain?.matches === false) {
    parts.push(
      `<p><span class="pill high">WRONG CHAIN</span> <span class="dim">the endpoint is on chain ${escapeHtml(result.chain.endpointChainId)}, the request says ${escapeHtml(result.chain.claimedChainId)}</span></p>`
    );
  } else if (result.chain?.matches === true) {
    parts.push(`<p><span class="pill ok">chain ${escapeHtml(result.chain.endpointChainId)} — matches</span></p>`);
  }

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

  if (result.spenders?.length) {
    parts.push(`<h3 class="subhead">who receives this authority</h3>`);
    for (const s of result.spenders) {
      parts.push(`<div class="spender">`);
      parts.push(
        rowsHtml([
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

  if (result.liveness) {
    const L = result.liveness;
    parts.push(`<h3 class="subhead">can this be used against you later?</h3>`);
    parts.push(
      `<div class="fields">` +
        rowsHtml([
          ["has it been used", L.signatureUnspent === null ? "unknown" : L.signatureUnspent ? "not yet — still executable" : "yes, spent"],
          ["expires", L.neverExpires === null ? "unknown" : L.neverExpires ? "never" : L.expired ? "already expired" : "in the future"],
          ["allowance now", L.allowance === null ? "unknown" : L.allowanceUnlimited ? "UNLIMITED" : L.allowance],
        ]) +
        `</div>`
    );
    parts.push(`<ul class="findings">${L.findings.map(findingHtml).join("")}</ul>`);
  }

  parts.push(`<ul class="findings">${result.findings.map(findingHtml).join("")}</ul>`);
  if (result.status === "ok" || result.onchainMatch === true) {
    parts.push(`<p class="caveat">${escapeHtml(CONSISTENCY_CAVEAT)}</p>`);
  }
  parts.push(`</div>`);
  return parts.join("");
}

function renderContract(result) {
  if (result.error) return `<div class="card"><p class="bad">${escapeHtml(result.error)}</p></div>`;
  const label = STATUS_LABELS[result.status] ?? { text: result.status, cls: "info" };
  const d = result.declaredDomain ?? {};
  const parts = [
    `<div class="card"><div class="verdict"><span class="pill ${label.cls}">${label.text}</span>
      <span class="mono dim">${escapeHtml(result.address)}</span></div>`,
  ];

  if (result.status === "no_contract" || result.status === "delegated") {
    parts.push(rowsHtml([["delegation target", result.delegationTarget], ["target separator", result.onchainSeparator]]));
    parts.push(`<ul class="findings">${result.findings.map(findingHtml).join("")}</ul></div>`);
    return parts.join("");
  }

  parts.push(rowsHtml([["declaration", result.declarationSource], ["name", d.name], ["version", d.version], ["chainId", d.chainId], ["verifyingContract", d.verifyingContract]]));
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

  // When the check stops for want of a name, say where to get it. "Cannot
  // verify" with no next step reads as a dead end, and the answer is usually a
  // single extra call the user can make themselves.
  if (result.status === "unverified") {
    parts.push(
      `<p class="caveat">This contract predates ERC-5267, so it publishes no ` +
        `name to check against. You can usually find the exact string it was ` +
        `deployed with by calling <code>name()</code> on the token, or from the ` +
        `project's own docs — then paste it above and Inspect again.</p>`
    );
  }
  if (result.status === "ok") parts.push(`<p class="caveat">${escapeHtml(CONSISTENCY_CAVEAT)}</p>`);
  parts.push(`</div>`);
  return parts.join("");
}

function busy(out, message) {
  out.innerHTML = `<div class="card"><p class="dim">${escapeHtml(message)}</p></div>`;
}

function failed(out, error) {
  out.innerHTML = `<div class="card"><p class="bad">${escapeHtml(error.message ?? error)}</p></div>`;
}

// ---------------------------------------------------------------------------
// Check view
// ---------------------------------------------------------------------------
$("check-payload").addEventListener("click", async () => {
  const out = $("payload-out");
  let payload;
  try {
    payload = JSON.parse($("payload").value);
  } catch (error) {
    failed(out, new Error(`That is not valid JSON: ${error.message}`));
    return;
  }
  // Tolerate a {"params": [address, data]} wrapper by picking the object.
  if (!payload.types && Array.isArray(payload.params)) {
    payload = payload.params.find((p) => p && typeof p === "object" && p.types) ?? payload;
  }
  // Re-render from what is actually being checked, so the box can never show one
  // payload while a different one is analysed.
  $("payload").value = JSON.stringify(payload, null, 2);

  // Guard the whole run on a usable endpoint, rather than emitting a pile of
  // reads that cannot succeed and quoting the bad value in every one.
  if (rpcUrlLooksWrong()) {
    failed(
      out,
      new Error(
        "The RPC endpoint field does not contain a URL, so nothing can be read from a chain. " +
          "Clear it, or put an https:// endpoint there."
      )
    );
    return;
  }

  const signature = $("signature").value.trim() || null;
  busy(out, "reading the chain…");
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

$("clear-payload").addEventListener("click", () => {
  $("payload").value = "";
  $("signature").value = "";
  $("payload-out").innerHTML = "";
});

/**
 * Sharing is explicit and warned about, because a payload can contain an
 * address and an unlimited spender. Putting that in a URL by default would leak
 * it into browser history and anything the link is pasted into.
 */
$("share-payload").addEventListener("click", async () => {
  const out = $("payload-out");
  let parsed;
  try {
    parsed = JSON.parse($("payload").value);
  } catch {
    failed(out, new Error("Nothing valid to share yet."));
    return;
  }
  const params = new URLSearchParams();
  params.set("payload", JSON.stringify(parsed));
  const url = `${location.origin}${location.pathname}?payload=${params.get("payload")}`;
  try {
    await navigator.clipboard.writeText(url);
    out.innerHTML = `<div class="card"><p class="dim">
      Link copied. <strong>It contains the whole request</strong>, including the
      contract address and whoever receives the authority — so treat the link
      itself as sensitive and do not post it publicly.
    </p></div>`;
  } catch {
    out.innerHTML = `<div class="card"><p class="bad">Clipboard unavailable, so no link was created.</p>
      <p class="dim">Share the request text itself instead — it is in the box above.</p></div>`;
  }
});

// Contract-only check, for when there is an address and no request. Same
// repertoire as the payload path: what is declared, what is on-chain, do they
// agree.
$("inspect").addEventListener("click", async () => {
  const out = $("contract-out");
  const address = $("address").value.trim();
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

// ---------------------------------------------------------------------------
// Learn view
// ---------------------------------------------------------------------------
function loadExample(key) {
  const chainId = currentChainId ?? 1;
  const verifying =
    chainId === 1
      ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
      : "0x0000000000000000000000000000000000000001";
  const payload = key === "drain" ? unlimitedPermit(chainId, verifying) : harmlessMessage(chainId, verifying);
  $("payload").value = JSON.stringify(payload, null, 2);
  $("signature").value = "";
  showView("check");
  $("check-payload").click();
}

$("sample-drain").addEventListener("click", () => loadExample("drain"));
$("sample-safe").addEventListener("click", () => loadExample("safe"));

// ---------------------------------------------------------------------------
// Test view
// ---------------------------------------------------------------------------
$("connect").addEventListener("click", async () => {
  const provider = activeProvider();
  if (!provider) return refreshWallet();
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    account = accounts?.[0] ?? null;
    await refreshWallet();
  } catch (error) {
    $("wallet-status").textContent = `connection rejected: ${error.message}`;
    $("wallet-status").className = "hint bad";
  }
});

for (const btn of document.querySelectorAll("[data-sample]")) {
  btn.addEventListener("click", () => {
    const chainId = currentChainId ?? 1;
    const verifying =
      chainId === 1
        ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
        : "0x0000000000000000000000000000000000000001";
    const payload = btn.dataset.sample === "permit" ? unlimitedPermit(chainId, verifying) : harmlessMessage(chainId, verifying);
    $("test-payload").value = JSON.stringify(payload, null, 2);
  });
}

/** Carry the request into the Check view, where the analysis lives. */
function sendToCheck() {
  const raw = $("test-payload").value;
  try {
    const parsed = JSON.parse(raw);
    $("payload").value = JSON.stringify(parsed, null, 2);
    showView("check");
    $("check-payload").click();
  } catch (error) {
    failed($("test-out"), new Error(`That is not valid JSON: ${error.message}`));
  }
}

$("send-to-check").addEventListener("click", sendToCheck);

$("copy-payload").addEventListener("click", async () => {
  const out = $("test-out");
  try {
    await navigator.clipboard.writeText($("test-payload").value);
    out.innerHTML = `<div class="card"><p class="dim">Copied. Paste it on the Check tab.</p></div>`;
  } catch {
    const box = $("test-payload");
    box.focus();
    box.select();
    out.innerHTML = `<div class="card"><p class="dim">Clipboard unavailable — the request is selected above, copy it with Ctrl/Cmd+C.</p></div>`;
  }
});

$("sign").addEventListener("click", async () => {
  const out = $("test-out");
  const provider = activeProvider();
  if (!provider) {
    out.innerHTML = `<div class="card"><p class="bad">No EVM wallet detected.</p></div>`;
    return;
  }
  let payload;
  try {
    payload = JSON.parse($("test-payload").value);
  } catch (error) {
    failed(out, new Error(`That is not valid JSON: ${error.message}`));
    return;
  }

  const [from] = await provider.request({ method: "eth_requestAccounts" });
  // The signer must be the connected account or the wallet may refuse, so set
  // owner rather than failing opaquely.
  if (payload?.message?.owner && /^0x[0-9a-fA-F]{40}$/.test(payload.message.owner)) {
    payload.message.owner = from;
    $("test-payload").value = JSON.stringify(payload, null, 2);
  }

  try {
    const signature = await provider.request({
      method: "eth_signTypedData_v4",
      params: [from, JSON.stringify(payload)],
    });
    out.innerHTML = `<div class="card">
      <p><span class="pill ok">signed</span> — nothing was sent on-chain.</p>
      <div class="kv"><span class="k">signature</span><span class="v mono">${escapeHtml(signature)}</span></div>
      <p class="hint">Your wallet showed a summary, not this JSON. Use <strong>Check it →</strong> to see what it authorised.</p>
    </div>`;
    $("signature").value = signature;
  } catch (error) {
    out.innerHTML = `<div class="card"><p class="bad">Signing failed or was rejected: ${escapeHtml(error.message ?? String(error))}</p></div>`;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// A fresh load clears any leftover fragment. The payload does NOT travel in the
// URL: an earlier design put the whole request in the fragment so a second page
// could read it, which meant a payload containing your address and an unlimited
// spender sat in the address bar, in browser history, and in anything the link
// was pasted into. The Test -> Check handoff is in memory now, so the URL never
// needs it. Clearing on load also removes any fragment left over from that
// earlier version sitting in someone's history.
if (location.hash && !["#learn", "#test"].includes(location.hash)) {
  history.replaceState(null, "", location.pathname + location.search);
}

const initialView = (location.hash || "").replace(/^#/, "");
if (["learn", "test"].includes(initialView)) showView(initialView);

discoverWallets(() => {
  if (!account) refreshWallet();
});

refreshWallet().then(() => {
  if (!$("test-payload").value) {
    const chainId = currentChainId ?? 1;
    $("test-payload").value = JSON.stringify(
      unlimitedPermit(chainId, chainId === 1 ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" : "0x0000000000000000000000000000000000000001"),
      null,
      2
    );
  }
});

showRpcStatus();

function watchProvider(provider) {
  if (!provider?.on) return;
  provider.on("chainChanged", () => refreshWallet());
  provider.on("accountsChanged", () => refreshWallet());
}
watchProvider(activeProvider());
