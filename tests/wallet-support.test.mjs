/**
 * Wallet support must not be MetaMask-shaped.
 *
 * With two wallet extensions installed, both write to window.ethereum and
 * whichever loads last wins — the user gets an arbitrary wallet and no say. The
 * fix is EIP-6963, whose entire purpose is discovering MULTIPLE injected
 * wallets, and whose existence is the evidence that "wallet" is not a synonym
 * for one vendor.
 *
 * These drive sign.js against a fake window, so the discovery and selection
 * logic is tested without a browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const signJs = await readFile(new URL("../sign.js", import.meta.url), "utf8");
const signHtml = await readFile(new URL("../sign.html", import.meta.url), "utf8");

test("discovery uses the EIP-6963 events, not a vendor check", () => {
  assert.match(signJs, /eip6963:announceProvider/);
  assert.match(signJs, /eip6963:requestProvider/);
});

test("it names several wallets, not one", () => {
  // The user's point: lots of people dislike any single wallet. The copy must
  // not read as though one vendor is the expected path.
  assert.match(signHtml, /Rabby/);
  assert.match(signHtml, /Coinbase/);
  assert.match(signHtml, /Frame/);
  assert.match(signHtml, /any EVM wallet/i);
});

test("no instruction tells the user to install one specific wallet", () => {
  // The old status line said "install MetaMask". That is both wrong and
  // alienating to the people this is meant to help.
  assert.doesNotMatch(signJs, /install MetaMask/i);
  assert.match(signJs, /install any EVM wallet/i);
});

test("window.ethereum survives only as a documented fallback", () => {
  // Legacy wallets never announce. Dropping window.ethereum entirely would
  // break them; using it FIRST would reintroduce the race this fixes.
  assert.match(signJs, /window\.ethereum` stays as a fallback/);
  assert.match(signJs, /`window\.ethereum` stays as a fallback/);
  const uses = signJs.match(/window\.ethereum/g) ?? [];
  assert.ok(uses.length <= 5, `window.ethereum referenced ${uses.length} times; it should be the fallback only`);
  assert.match(signJs, /return selected\(\) \?\? discovered\[0\]\?\.provider \?\? window\.ethereum/);
});

test("duplicate announcements are ignored", () => {
  // The spec warns a uuid can be reused by an imitator trying to flood the list.
  assert.match(signJs, /seen\.has\(detail\.info\.uuid\)/);
});

test("the picker appears only when there is a real choice", () => {
  // A picker with one option is noise, not agency.
  assert.match(signJs, /if \(discovered\.length < 2\)/);
  assert.match(signHtml, /id="wallet-picker"/);
});
