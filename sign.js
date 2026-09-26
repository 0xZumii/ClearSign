/**
 * Ask a wallet to sign typed data, so a signature prompt can be produced on
 * demand. Real dapps gate this behind eligibility; this does not.
 *
 * It ONLY calls eth_signTypedData_v4. It never sends a transaction, never asks
 * for a key, and never touches funds. A typed-data signature is authorisation
 * though, so the examples point at example contracts and the page says so.
 */

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const ROBINHOOD_CHAIN_ID = 4663; // 0x1237

/** The canonical drain shape: unlimited allowance, never expires. */
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
    domain: {
      name: "USD Coin",
      version: "2",
      chainId,
      verifyingContract,
    },
    message: {
      owner: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      spender: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      nonce: "0",
      deadline: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    },
  };
}

/** Moves nothing, grants nothing. For seeing the --harmless path. */
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

let account = null;
let currentChainId = null;

/**
 * Multiple injected wallets.
 *
 * With two wallet extensions installed, both write to `window.ethereum` and
 * whichever loads last wins — the user gets a random one and no say in it. That
 * is the problem EIP-6963 exists to solve, and its whole point is that a wallet
 * is NOT a MetaMask-shaped thing: Rabby, Frame, Coinbase Wallet, Brave's
 * built-in wallet and browser-native wallets all announce themselves the same
 * way. `window.ethereum` stays as a fallback for wallets that predate the
 * standard.
 */
const discovered = [];

export function wallets() {
  return discovered;
}

export function selected() {
  return discovered.find((d) => d.info.uuid === selectedUuid)?.provider ?? null;
}

let selectedUuid = null;

export function selectWallet(uuid) {
  selectedUuid = uuid;
}

/** The provider to use: an explicit choice, else the first discovered, else legacy. */
export function activeProvider() {
  return selected() ?? discovered[0]?.provider ?? window.ethereum ?? null;
}

export function activeWalletName() {
  const chosen = discovered.find((d) => d.info.uuid === selectedUuid);
  if (chosen) return chosen.info.name;
  return discovered[0]?.info.name ?? (window.ethereum ? "a browser wallet" : null);
}

/** Start discovery. Safe to call before any wallet has announced. */
export function discoverWallets(onChange) {
  const seen = new Set();
  const record = (detail) => {
    // The spec warns that a uuid can be reused by an imitator; dedupe on it so
    // the list cannot be flooded with clones of one wallet.
    if (!detail?.info?.uuid || seen.has(detail.info.uuid)) return;
    seen.add(detail.info.uuid);
    discovered.push(detail);
    onChange?.();
  };

  window.addEventListener("eip6963:announceProvider", (event) => record(event.detail));
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // Legacy wallets never announce. Give the standard ones a moment, then fall
  // back so a single-wallet user is not left staring at an empty picker.
  setTimeout(() => {
    if (!discovered.length && window.ethereum) onChange?.();
  }, 300);
}

function render(payload) {
  $("payload").value = JSON.stringify(payload, null, 2);
}

async function refreshWallet() {
  const provider = activeProvider();
  if (!provider) {
    $("wallet-status").textContent =
      "no wallet detected — install any EVM wallet, or open this page in one's built-in browser";
    $("wallet-status").className = "hint bad";
    renderWalletPicker();
    return;
  }
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    account = accounts?.[0] ?? null;
    const chainHex = await provider.request({ method: "eth_chainId" });
    currentChainId = Number(BigInt(chainHex));
    const name = activeWalletName();
    $("wallet-status").textContent = account
      ? `connected ${account.slice(0, 6)}…${account.slice(-4)} on chain ${currentChainId}${name ? ` via ${name}` : ""}`
      : `${name ?? "wallet"} detected but not connected`;
    $("wallet-status").className = account ? "hint ok-text" : "hint";
  } catch (error) {
    $("wallet-status").textContent = `could not read the wallet: ${error.message}`;
    $("wallet-status").className = "hint bad";
  }
  renderWalletPicker();
}

/** Show a picker only when there is an actual choice to make. */
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
    `<label>Wallet</label>` +
    discovered
      .map((d, i) => {
        const isActive = selectedUuid ? d.info.uuid === selectedUuid : i === 0;
        return `<button type="button" class="wallet-choice${isActive ? " active" : ""}" data-uuid="${escapeHtml(d.info.uuid)}">
          <img src="${escapeHtml(d.info.icon)}" alt="" width="20" height="20" />
          ${escapeHtml(d.info.name)}
        </button>`;
      })
      .join("");
  for (const btn of box.querySelectorAll(".wallet-choice")) {
    btn.addEventListener("click", async () => {
      selectWallet(btn.dataset.uuid);
      account = null;
      await refreshWallet();
    });
  }
}

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

// Deliberately NO "add chain" button. Robinhood Chain and the other common
// networks are already in any modern wallet, and "a site wants to add a network"
// is itself a drainer pattern -- teaching someone to click that prompt while
// they are on a security tool would be actively harmful. The page reads whatever
// chain the wallet is on instead.

for (const btn of document.querySelectorAll("[data-sample]")) {
  btn.addEventListener("click", () => {
    const chainId = currentChainId ?? 1;
    // Point the example at the address the sample is meaningful on. On Ethereum
    // that is real USDC; elsewhere no token exists at that address, so the
    // example says so by using a placeholder -- an example must not imply a real
    // contract exists on a chain it does not.
    const verifying =
      chainId === 1
        ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
        : "0x0000000000000000000000000000000000000001";
    if (btn.dataset.sample === "permit") render(unlimitedPermit(chainId, verifying));
    if (btn.dataset.sample === "harmless") render(harmlessMessage(chainId, verifying));
    if (btn.dataset.sample === "local") render(harmlessMessage(chainId, verifying));
  });
}

// Carry the payload over to ClearSign. A link alone would be useless -- the user
// would arrive at an empty box, which is exactly the dead end they hit. The
// payload travels in the URL fragment (never sent to a server), and ClearSign
// reads it on load. The signature travels too when there is one, so the signer
// can be recovered.
function syncHandoff(signature = null) {
  const raw = $("payload").value;
  const link = $("send-to-clearsign");
  try {
    JSON.parse(raw); // only pass along something valid
    const params = new URLSearchParams();
    params.set("payload", raw);
    if (signature) params.set("signature", signature);
    link.href = `./index.html#${params.toString()}`;
    link.removeAttribute("aria-disabled");
  } catch {
    link.href = "./index.html";
    link.setAttribute("aria-disabled", "true");
  }
}

$("copy-payload").addEventListener("click", async () => {
  const out = $("out");
  try {
    await navigator.clipboard.writeText($("payload").value);
    out.innerHTML = `<div class="card"><p class="dim">Payload copied. Paste it into <a href="./index.html">ClearSign</a>.</p></div>`;
  } catch {
    // Clipboard needs a secure context and permission; select it so the user can
    // copy by hand rather than being told it worked when it did not.
    const box = $("payload");
    box.focus();
    box.select();
    out.innerHTML = `<div class="card"><p class="dim">Could not reach the clipboard — the payload is selected above, copy it with Ctrl/Cmd+C.</p></div>`;
  }
});

$("payload").addEventListener("input", () => syncHandoff());

$("sign").addEventListener("click", async () => {
  const out = $("out");
  const provider = activeProvider();
  if (!provider) {
    out.innerHTML = `<div class="card"><p class="bad">No EVM wallet detected.</p></div>`;
    return;
  }
  let payload;
  try {
    payload = JSON.parse($("payload").value);
  } catch (error) {
    out.innerHTML = `<div class="card"><p class="bad">That is not valid JSON: ${escapeHtml(error.message)}</p></div>`;
    return;
  }

  const [from] = await provider.request({ method: "eth_requestAccounts" });
  // The signer is whoever is connected, so the payload's owner must be them or
  // the wallet may refuse. Replace the owner field rather than failing opaquely.
  if (payload?.message?.owner && /^0x[0-9a-fA-F]{40}$/.test(payload.message.owner)) {
    payload.message.owner = from;
    render(payload);
  }

  try {
    const signature = await provider.request({
      method: "eth_signTypedData_v4",
      params: [from, JSON.stringify(payload)],
    });
    out.innerHTML = `<div class="card">
      <p><span class="pill ok">signed</span> — nothing was sent on-chain.</p>
      <div class="kv"><span class="k">signature</span><span class="v mono">${escapeHtml(signature)}</span></div>
      <p class="hint">
        Your wallet showed you a summary, not this JSON. Clear it now:
        <strong>Check it in ClearSign →</strong> carries the payload (and the
        signature, so the signer is recovered) over for you.
      </p>
    </div>`;
    syncHandoff(signature);
  } catch (error) {
    out.innerHTML = `<div class="card"><p class="bad">Signing failed or was rejected: ${escapeHtml(error.message ?? String(error))}</p></div>`;
  }
});

// Populate something to look at immediately, then reflect the wallet's chain.
discoverWallets(() => {
  if (account) return; // already connected; re-rendering would fight the user
  refreshWallet();
});

refreshWallet().then(() => {
  if (!$("payload").value) {
    render(unlimitedPermit(currentChainId ?? 1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"));
  }
  // The initial payload was set programmatically, which does not fire `input`,
  // so build the handoff link once here too -- otherwise the button is dead for
  // anyone who does not touch the textarea.
  syncHandoff();
});

// Re-read state when the active wallet changes either of these.
function watchProvider(provider) {
  if (!provider?.on) return;
  provider.on("chainChanged", () => refreshWallet());
  provider.on("accountsChanged", () => refreshWallet());
}
watchProvider(activeProvider());
