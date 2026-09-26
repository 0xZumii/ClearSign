/**
 * The test trigger asks a real wallet to sign. That makes its copy load-bearing:
 * a page that produces signature prompts must not read as "this is harmless",
 * because the whole point of ClearSign is that a signature IS authorisation.
 *
 * These tests read index.html and sign.html as text and assert the words carry
 * both halves of that message. They are cheap, and they fail loudly if someone
 * later trims the caveats for brevity.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const sign = await readFile(new URL("../sign.html", import.meta.url), "utf8");
const signJs = await readFile(new URL("../sign.js", import.meta.url), "utf8");
const appJs = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("the trigger is labelled as a test, not as an ordinary example", () => {
  assert.match(index, /id="open-trigger"/);
  assert.match(index, /make a real signing prompt/i);
  assert.match(index, /test trigger/i);
});

test("the trigger explains what it is for, and what it cannot do", () => {
  // Both halves must be present: no transaction, but still authorisation.
  assert.match(index, /sends no transaction and spends no gas/i);
  assert.match(index, /a signature is still authorisation/i);
  assert.match(index, /example contracts/i);
  // And why it exists at all: dapps gate the signing step.
  assert.match(index, /gate the signing step behind eligibility/i);
});

test("the trigger page repeats the caveat before any wallet interaction", () => {
  assert.match(sign, /Nothing here moves funds/i);
  assert.match(sign, /only ever sign payloads you understand/i);
});

test("the trigger only asks for typed-data signing, never a transaction", () => {
  // A red flag would be eth_sendTransaction or eth_sign. Nothing here may.
  assert.doesNotMatch(signJs, /eth_sendTransaction/);
  assert.doesNotMatch(signJs, /method:\s*["']eth_sign["']/);
  assert.match(signJs, /eth_signTypedData_v4/);
});

test("the trigger never asks the wallet to add a chain", () => {
  // Robinhood Chain and the common networks are already in modern wallets, and
  // "a site wants to add a network" is itself a drainer pattern. A security tool
  // must not teach that prompt.
  assert.doesNotMatch(signJs, /wallet_addEthereumChain/);
  assert.doesNotMatch(sign, /Add Robinhood Chain/i);
  assert.match(sign, /never asks you\s+to add a chain/i);
});

test("Robinhood Chain is still documented as a recognised chain", () => {
  // It is a real chain and the user hit it, so it is named -- in app.js's chain
  // list and in the help text -- without offering to add it.
  assert.match(index, /4663/);
  assert.match(appJs, /4663/);
});

test("the chain-mismatch explanation is present where a user will look", () => {
  assert.match(index, /matches the[\s\S]*?chainId[\s\S]*?payload/i);
  assert.match(sign, /chainId[\s\S]*?not the chain your wallet is on/i);
});
