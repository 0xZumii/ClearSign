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

function render(payload) {
  $("payload").value = JSON.stringify(payload, null, 2);
}

async function refreshWallet() {
  if (!window.ethereum) {
    $("wallet-status").textContent = "no wallet detected — install MetaMask, or open this in a wallet browser";
    $("wallet-status").className = "hint bad";
    return;
  }
  const accounts = await window.ethereum.request({ method: "eth_accounts" });
  account = accounts?.[0] ?? null;
  const chainHex = await window.ethereum.request({ method: "eth_chainId" });
  currentChainId = Number(BigInt(chainHex));
  $("wallet-status").textContent = account
    ? `connected ${account.slice(0, 6)}…${account.slice(-4)} on chain ${currentChainId}`
    : "wallet detected but not connected";
  $("wallet-status").className = account ? "hint ok-text" : "hint";
}

$("connect").addEventListener("click", async () => {
  if (!window.ethereum) return refreshWallet();
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
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
  if (!window.ethereum) {
    out.innerHTML = `<div class="card"><p class="bad">No wallet detected.</p></div>`;
    return;
  }
  let payload;
  try {
    payload = JSON.parse($("payload").value);
  } catch (error) {
    out.innerHTML = `<div class="card"><p class="bad">That is not valid JSON: ${escapeHtml(error.message)}</p></div>`;
    return;
  }

  const [from] = await window.ethereum.request({ method: "eth_requestAccounts" });
  // The signer is whoever is connected, so the payload's owner must be them or
  // the wallet may refuse. Replace the owner field rather than failing opaquely.
  if (payload?.message?.owner && /^0x[0-9a-fA-F]{40}$/.test(payload.message.owner)) {
    payload.message.owner = from;
    render(payload);
  }

  try {
    const signature = await window.ethereum.request({
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
refreshWallet().then(() => {
  if (!$("payload").value) {
    render(unlimitedPermit(currentChainId ?? 1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"));
  }
  // The initial payload was set programmatically, which does not fire `input`,
  // so build the handoff link once here too -- otherwise the button is dead for
  // anyone who does not touch the textarea.
  syncHandoff();
});

if (window.ethereum?.on) {
  window.ethereum.on("chainChanged", () => refreshWallet());
  window.ethereum.on("accountsChanged", () => refreshWallet());
}
