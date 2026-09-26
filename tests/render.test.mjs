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
  get innerText() { return this._html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
  setAttribute() {}
}

const ids = [
  "rpc-url", "rpc-apply", "rpc-status", "address", "inspect",
  "exp-name", "exp-version", "contract-out", "payload", "signature",
  "check-payload", "check-onchain", "payload-out",
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
  globalThis.location = { search: "" };
  globalThis.URLSearchParams = URLSearchParams;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  globalThis.AbortController = AbortController;
  return els;
}

const { Rpc } = await import("../lib/rpc.js");

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
  const original = { chainId: Rpc.prototype.chainId, callContract: Rpc.prototype.callContract };
  Rpc.prototype.chainId = async () => 1;
  Rpc.prototype.callContract = async () => options.separator ?? "0x";
  try {
    els["payload-out"].innerHTML = "";
    els["payload"].value = JSON.stringify(payload);
    els["signature"].value = "";
    els["check-onchain"].checked = Boolean(options.checkOnchain);
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
