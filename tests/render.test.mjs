/**
 * Guards the credibility invariant: the rendered page must never present an
 * unverified result as a pass.
 *
 * This is the one rule the whole tool rests on. A "paste an address, see if it
 * is safe" page would be easier to build and worth less, because the honest
 * answer is usually "I could not see enough to judge". These tests pin that by
 * rendering real result shapes through the same code path the page uses and
 * asserting on the output text.
 *
 * app.js is DOM wiring, so this loads it into a minimal fake DOM rather than a
 * browser. Nothing here touches the network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// --- a DOM small enough to reason about -----------------------------------
class FakeEl {
  constructor(id) {
    this.id = id;
    this.value = "";
    this.checked = true;
    this._html = "";
    this.textContent = "";
    this.className = "";
    this.classList = { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); } };
    this.dataset = {};
    this._listeners = {};
  }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  click() { for (const fn of this._listeners.click ?? []) fn(); }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  get innerText() {
    return this._html
      .replace(/<[^>]+>/g, " ")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }
  setAttribute() {}
}

const ids = [
  "rpc-url", "rpc-apply", "rpc-status", "address", "inspect",
  "exp-name", "exp-version", "contract-out", "payload", "signature",
  "check-payload", "check-onchain", "check-spenders", "check-liveness", "payload-out",
  "sample-drain", "sample-safe", "open-trigger", "close-trigger", "trigger-note",
];

function makeDom() {
  const els = Object.fromEntries(ids.map((id) => [id, new FakeEl(id)]));
  const tabs = ["contract", "payload"].map((name) => {
    const el = new FakeEl(`tab-${name}`);
    el.dataset.tab = name;
    return el;
  });
  const panels = ["contract", "payload"].map((name) => new FakeEl(`panel-${name}`));

  globalThis.document = {
    getElementById: (id) => els[id] ?? null,
    querySelectorAll: (sel) =>
      sel === ".tab" ? tabs : sel === ".panel" ? panels : [],
  };
  globalThis.location = { search: "", hash: "" };
  globalThis.URLSearchParams = URLSearchParams;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  globalThis.AbortController = AbortController;
  return els;
}

const { Rpc } = await import("../lib/rpc.js");
const { selector } = await import("../lib/keccak.js");
const ALLOWANCE_SELECTOR = selector("allowance(address,address)");
const NONCES_SELECTOR = selector("nonces(address)");

// Import app.js once, against one DOM. app.js binds its handlers to the elements
// that exist at import time, so every test must drive those same objects rather
// than a fresh fake document.
const els = makeDom();
await import("../app.js");

function resetOut() {
  els["contract-out"].innerHTML = "";
  els["contract-out"].textContent = "";
  els["address"].value = "";
  els["exp-name"].value = "";
  els["exp-version"].value = "";
}

/**
 * Render a contract result the way the page does, without a network: stub the
 * Rpc methods and drive the real click handler on the real element.
 */
async function renderContract(scenario) {
  const original = {
    getCode: Rpc.prototype.getCode,
    chainId: Rpc.prototype.chainId,
    callContract: Rpc.prototype.callContract,
  };
  Rpc.prototype.getCode = async () => scenario.code ?? "0x6001";
  Rpc.prototype.chainId = async () => scenario.chainId ?? 1;
  Rpc.prototype.callContract = async (_to, data) => {
    if (data.startsWith("0x3644e515")) return scenario.separator ?? "0x";
    if (data.startsWith("0x84b0196e")) return scenario.declaration ?? "0x";
    return "0x";
  };
  try {
    resetOut();
    els["address"].value = scenario.address ?? "0x" + "11".repeat(20);
    els["exp-name"].value = scenario.name ?? "";
    els["exp-version"].value = scenario.version ?? "";
    els["inspect"].click();
    // The handler is async; drain its microtasks before reading the output.
    await new Promise((r) => setTimeout(r, 0));
    return els["contract-out"].innerText;
  } finally {
    Object.assign(Rpc.prototype, original);
  }
}

test("an unverified contract never renders as a pass", async () => {
  const text = await renderContract({ separator: "0x" + "ab".repeat(32) });
  assert.match(text, /cannot verify/i);
  assert.doesNotMatch(text, /domain is consistent/i);
});

test("a contract with no domain is not presented as a pass either", async () => {
  const text = await renderContract({});
  assert.match(text, /no eip-712 domain found/i);
  assert.doesNotMatch(text, /domain is consistent/i);
});

test("an EOA is reported as no contract, and never as clean", async () => {
  const text = await renderContract({ code: "0x" });
  assert.match(text, /no contract here/i);
  assert.doesNotMatch(text, /domain is consistent/i);
});

test("a 7702 delegation shows the target and does not imply a check", async () => {
  const target = "5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d";
  const text = await renderContract({ code: "0xef0100" + target });
  assert.match(text, /EIP-7702 delegated/i);
  assert.match(text, new RegExp(`0x${target}`));
  assert.doesNotMatch(text, /domain is consistent/i);
});

test("a genuine match is the only thing that renders as a pass", async () => {
  // USD Coin's separator is bound to its own address, so the fixture must use
  // that address — otherwise the domain genuinely does not hash to the value,
  // which is exactly what the previous version of this test was hitting.
  const text = await renderContract({
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    separator: "0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335",
    name: "USD Coin",
    version: "2",
  });
  assert.match(text, /domain is consistent/i);
  assert.doesNotMatch(text, /cannot verify/i);
});

test("a consistent domain still carries the 'not an endorsement' caveat", async () => {
  // The false-flag risk: a green-ish result must never read as a safety verdict,
  // because a drainer's domain is perfectly consistent.
  const text = await renderContract({
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    separator: "0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335",
    name: "USD Coin",
    version: "2",
  });
  assert.match(text, /does NOT mean the contract is trustworthy/i);
  assert.match(text, /still a drain/i);
});

async function renderPayload(payload, options = {}) {
  const original = {
    chainId: Rpc.prototype.chainId,
    callContract: Rpc.prototype.callContract,
    getCode: Rpc.prototype.getCode,
    getTransactionCount: Rpc.prototype.getTransactionCount,
    getBalance: Rpc.prototype.getBalance,
  };
  Rpc.prototype.chainId = async () => options.chainIdReturns ?? 1;
  Rpc.prototype.callContract = async (_to, data) => {
    // Permit-liveness reads, matched by their derived selectors.
    const sel = String(data).slice(0, 10);
    if (sel === ALLOWANCE_SELECTOR) return options.liveness?.allowanceReturns ?? "0x";
    if (sel === NONCES_SELECTOR) {
      const n = options.liveness?.nonceReturns;
      return n === undefined ? "0x" : "0x" + BigInt(n).toString(16).padStart(64, "0");
    }
    return options.separator ?? "0x";
  };
  Rpc.prototype.getCode = async () =>
    options.noCode === false ? "0x" + "60".repeat(options.codeSize ?? 100) : "0x";
  Rpc.prototype.getTransactionCount = async () => options.txCount ?? 0;
  Rpc.prototype.getBalance = async () => options.balance ?? 0n;
  try {
    els["payload-out"].innerHTML = "";
    els["payload"].value = JSON.stringify(payload);
    els["signature"].value = "";
    els["check-onchain"].checked = Boolean(options.checkOnchain);
    els["check-spenders"].checked = Boolean(options.inspectSpenders);
    els["check-liveness"].checked = Boolean(options.checkLiveness);
    els["check-payload"].click();
    await new Promise((r) => setTimeout(r, 0));
    return els["payload-out"].innerText;
  } finally {
    Object.assign(Rpc.prototype, original);
  }
}

const DRAIN_PAYLOAD = {
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
    owner: "0x2222222222222222222222222222222222222222",
    spender: "0x1111111111111111111111111111111111111111",
    // 2^256-1: the classic drain.
    value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    nonce: "0",
    deadline: "0",
  },
};

test("an unlimited Permit is flagged even though its domain is consistent", async () => {
  const text = await renderPayload(DRAIN_PAYLOAD, {
    separator: "0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335",
    checkOnchain: true,
  });
  assert.match(text, /UNLIMITED/);
  assert.match(text, /authorisation, not a payment/i);
  // ...and it must not fall through to the reassuring message.
  assert.doesNotMatch(text, /No domain mismatch and no drain-shaped fields/i);
});

test("a drain payload shows the fields it authorises", async () => {
  const text = await renderPayload(DRAIN_PAYLOAD);
  assert.match(text, /what this signature authorises/i);
  assert.match(text, /value/);
  assert.match(text, /spender/);
});

test("bootstrapping the generator address stays out of the payload path", async () => {
  // A plain, harmless payload: no unlimited value, no authorisation type.
  const benign = {
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Mail: [{ name: "contents", type: "string" }],
    },
    primaryType: "Mail",
    domain: { name: "App" },
    message: { contents: "hello" },
  };
  const text = await renderPayload(benign);
  assert.match(text, /No domain mismatch and no drain-shaped fields/i);
  assert.doesNotMatch(text, /UNLIMITED/);
});

test("the same name at the wrong address is a mismatch, not a pass", async () => {
  // The same "USD Coin" domain pointed at a different contract must not verify:
  // the separator is bound to the address, and that is the whole mechanism.
  const text = await renderContract({
    address: "0x" + "11".repeat(20),
    separator: "0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335",
    name: "USD Coin",
    version: "2",
  });
  assert.match(text, /INCOMPATIBLE/);
  assert.doesNotMatch(text, /domain is consistent/i);
});

test("a fresh EOA receiving unlimited authority is shown, facts not verdicts", async () => {
  // The shape that matters, and the one a domain check cannot see: a perfectly
  // consistent domain granting infinite authority to an address with no code
  // and no history. Every fact here is checkable against the same node.
  const text = await renderPayload(DRAIN_PAYLOAD, {
    separator: "0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335",
    checkOnchain: true,
    inspectSpenders: true,
    noCode: true,
    txCount: 0,
    balance: 0n,
  });
  assert.match(text, /who receives this authority/i);
  assert.match(text, /no — plain account/i);
  assert.match(text, /never sent a transaction/i);
  assert.match(text, /UNLIMITED/);
  // It must not claim to KNOW this is a drainer. Facts, not a verdict.
  assert.doesNotMatch(text, /\bis a drainer\b/i);
  assert.doesNotMatch(text, /\bconfirmed scam\b/i);
});

test("a known, active contract spender reads calmly", async () => {
  const text = await renderPayload(DRAIN_PAYLOAD, {
    inspectSpenders: true,
    noCode: false,
    codeSize: 8000,
    txCount: 1, // realistic: a router is called, it does not call
    balance: 10n ** 18n,
  });
  assert.match(text, /yes \(8000 bytes\)/i);
  assert.doesNotMatch(text, /never sent a transaction/i);
  assert.doesNotMatch(text, /small enough to be a forwarder/i);
  // The tx-count caveat must be present for a contract, since a low count is
  // normal there and would otherwise mislead.
  assert.match(text, /counts only transactions it originated/i);
});

test("a tiny forwarder spender is called out as small, not as malicious", async () => {
  const text = await renderPayload(DRAIN_PAYLOAD, {
    inspectSpenders: true,
    noCode: false,
    codeSize: 45,
  });
  assert.match(text, /small enough to be a forwarder/i);
  assert.doesNotMatch(text, /\bis a drainer\b/i);
});

test("an unspent, never-expiring permit is called out as a standing permission", async () => {
  // The scenario the whole check exists for: not a drain happening now, but a
  // signature the attacker can hold and submit whenever they like. deadline is
  // uint256 max -- EIP-2612's documented way to make a permit that never expires.
  const payload = JSON.parse(JSON.stringify(DRAIN_PAYLOAD));
  payload.message.deadline = (2n ** 256n - 1n).toString();
  const text = await renderPayload(payload, {
    checkLiveness: true,
    liveness: { nonceReturns: "0", allowanceReturns: "0" },
  });
  assert.match(text, /can this be used against you later/i);
  assert.match(text, /NOT yet used — still executable/i);
  assert.match(text, /never \(deadline = uint256 max\)/i);
  assert.match(text, /has NOT been submitted yet/i);
  assert.match(text, /it never expires/i);
});

test("an already-expired permit does not claim it can still be used", async () => {
  const payload = JSON.parse(JSON.stringify(DRAIN_PAYLOAD));
  payload.message.deadline = "1"; // 1970; long past
  const text = await renderPayload(payload, {
    checkLiveness: true,
    liveness: { nonceReturns: "0", allowanceReturns: "0" },
  });
  assert.match(text, /deadline has passed/i);
  assert.doesNotMatch(text, /at any time/i);
});

test("an already-spent permit is reported as no longer executable", async () => {
  const text = await renderPayload(DRAIN_PAYLOAD, {
    checkLiveness: true,
    liveness: { nonceReturns: "7", allowanceReturns: "0" },
  });
  assert.match(text, /already used/i);
  assert.match(text, /no longer executable/i);
  assert.doesNotMatch(text, /still executable/i);
});

test("a live unlimited allowance is flagged independently of the signature", async () => {
  const text = await renderPayload(DRAIN_PAYLOAD, {
    checkLiveness: true,
    liveness: { nonceReturns: "7", allowanceReturns: (2n ** 256n - 1n).toString() },
  });
  assert.match(text, /UNLIMITED allowance/i);
  assert.match(text, /does not need the signature/i);
});

test("a finite future deadline is dated, not treated as unlimited", async () => {
  const soon = String(Math.floor(Date.now() / 1000) + 86400 * 3);
  const payload = JSON.parse(JSON.stringify(DRAIN_PAYLOAD));
  payload.message.deadline = soon;
  const text = await renderPayload(payload, {
    checkLiveness: true,
    liveness: { nonceReturns: "0", allowanceReturns: "0" },
  });
  assert.match(text, /in the future/i);
  assert.doesNotMatch(text, /never \(deadline/i);
});

test("liveness is skipped when the payload is not an authorisation type", async () => {
  const benign = {
    types: { EIP712Domain: [{ name: "name", type: "string" }], Mail: [{ name: "contents", type: "string" }] },
    primaryType: "Mail",
    domain: { name: "App" },
    message: { contents: "hello" },
  };
  const text = await renderPayload(benign, { checkLiveness: true });
  assert.doesNotMatch(text, /can this be used against you later/i);
});

test("a never-expiring deadline is not misread as an unlimited spend", async () => {
  // Regression: deadline = uint256 max means "never expires", not "whole
  // balance". Reading a timestamp as a money amount is a false alarm on the
  // most alarming possible line.
  const payload = JSON.parse(JSON.stringify(DRAIN_PAYLOAD));
  payload.message.deadline = (2n ** 256n - 1n).toString();
  const text = await renderPayload(payload, { checkLiveness: true, liveness: { nonceReturns: "0" } });
  assert.doesNotMatch(text, /UNLIMITED at 'deadline'/i);
  // The value field still is a spend limit, so it must still be flagged.
  assert.match(text, /UNLIMITED at 'value'/i);
});

test("an unlimited field is recognised by name, not by magnitude alone", async () => {
  const payload = JSON.parse(JSON.stringify(DRAIN_PAYLOAD));
  payload.types.Permit.push({ name: "expiry", type: "uint256" });
  payload.message.expiry = (2n ** 256n - 1n).toString();
  const text = await renderPayload(payload, {});
  assert.doesNotMatch(text, /UNLIMITED at 'expiry'/i);
});

test("a chain mismatch is flagged before any other reassurance", async () => {
  // The bug a real user hit: a valid non-Ethereum endpoint (Robinhood Chain)
  // against a mainnet payload. Every other read would describe a different
  // contract, so this must be loud and must not coexist with a reassuring line.
  const text = await renderPayload(DRAIN_PAYLOAD, {
    chainIdReturns: 4663,
    checkOnchain: true,
    separator: "0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335",
  });
  assert.match(text, /WRONG CHAIN/);
  assert.match(text, /endpoint is on chain 4663/i);
  assert.match(text, /payload says 1/i);
  assert.doesNotMatch(text, /matches the payload/i);
});

test("a matching chain is stated positively", async () => {
  const text = await renderPayload(DRAIN_PAYLOAD, {
    chainIdReturns: 1,
    checkOnchain: true,
    separator: "0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335",
  });
  assert.match(text, /chain 1 — matches the payload/i);
  assert.doesNotMatch(text, /WRONG CHAIN/);
});

test("a wrong name renders as incompatible, loudly", async () => {
  const text = await renderContract({
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    separator: "0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335",
    name: "Not USDC",
    version: "2",
  });
  assert.match(text, /INCOMPATIBLE/);
  assert.doesNotMatch(text, /domain is consistent/i);
});
