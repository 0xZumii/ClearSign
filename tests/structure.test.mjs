/**
 * The page structure, after it collapsed under its own weight.
 *
 * Everything used to be on one page: a tab strip, an RPC panel, a trigger
 * drawer and two explainer sections, all competing. The fix was three views
 * with one job each. These tests hold that structure, because the failure mode
 * was quiet: each addition was individually reasonable and the sum was unusable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const appJs = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("there are three views, and the tool is the default", () => {
  assert.match(index, /id="view-check"/);
  assert.match(index, /id="view-learn"/);
  assert.match(index, /id="view-test"/);
  // Check is active on load -- a visitor should land on the thing that works.
  assert.match(index, /id="view-check" class="view active"/);
});

test("the navigation sits in the header, next to the source link", () => {
  const headerEnd = index.indexOf("</header>");
  const navPos = index.indexOf('class="site-nav"');
  const sourcePos = index.indexOf('class="navbtn source"');
  assert.ok(navPos > 0 && navPos < headerEnd, "nav must be inside the header");
  assert.ok(sourcePos > navPos, "source should follow the view buttons");
  assert.match(index, /data-view="check"/);
  assert.match(index, /data-view="learn"/);
  assert.match(index, /data-view="test"/);
});

test("the payload box is the first thing on the Check view", () => {
  // The regression the user hit: nothing to paste. The box must be present and
  // visible without opening a disclosure or switching tabs.
  const checkStart = index.indexOf('id="view-check"');
  const payloadPos = index.indexOf('id="payload"');
  const rpcPos = index.indexOf('id="rpc-url"');
  assert.ok(payloadPos > checkStart, "payload box belongs to the Check view");
  assert.ok(payloadPos < rpcPos, "payload comes before the RPC field");
  assert.match(index, /id="payload"[^>]*rows="/);
});

test("all sample data lives in Learn, and Test keeps only the signing cases", () => {
  const learnStart = index.indexOf('id="view-learn"');
  const testStart = index.indexOf('id="view-test"');
  const drainPos = index.indexOf('id="sample-drain"');
  assert.ok(drainPos > learnStart && drainPos < testStart, "loadable examples belong to Learn");
  assert.match(index, /data-sample="permit"/);
  assert.match(index, /data-sample="harmless"/);
});

test("loading an example switches to Check and runs it", () => {
  assert.match(appJs, /function loadExample/);
  assert.match(appJs, /showView\("check"\)/);
  assert.match(appJs, /\$\("check-payload"\)\.click\(\)/);
});

test("Test hands the request to Check rather than to a second page", () => {
  // The separate sign.html page is gone; a second page was most of the mess.
  assert.match(appJs, /function sendToCheck/);
  assert.match(index, /id="send-to-check"/);
  assert.doesNotMatch(index, /sign\.html/);
  assert.doesNotMatch(index, /\.\/sign/);
});

test("the RPC field is pastable but tucked away, and still validates", () => {
  // It was liked, then hidden too well, then hoisted above the tool. It belongs
  // in the Check view, available, below the thing people came to use.
  assert.match(index, /id="rpc-url"/);
  assert.match(index, /id="rpc-apply"/);
  assert.match(appJs, /is not an endpoint/);
});

test("the test trigger cannot send a transaction", () => {
  assert.doesNotMatch(appJs, /eth_sendTransaction/);
  assert.doesNotMatch(appJs, /method:\s*["']eth_sign["']/);
  assert.match(appJs, /eth_signTypedData_v4/);
});

test("every wallet, not one vendor", () => {
  assert.match(appJs, /eip6963:announceProvider/);
  assert.doesNotMatch(appJs, /install MetaMask/i);
  assert.match(appJs, /install any EVM wallet/i);
});

test("the page says plainly what it cannot do", () => {
  assert.match(index, /not a safety score/i);
  assert.match(index, /EVM chains/i);
  assert.match(index, /cannot verify.*is not a pass/is);
});

// --- carried over from the retired sign.html/sign.js suites ------------------
// The Test view replaced a separate trigger page. The guarantees those suites
// held are about behaviour, not about a filename, so they move here.

test("the Test view states what signing does and does not do, before any wallet use", () => {
  const testStart = index.indexOf('id="view-test"');
  const connectPos = index.indexOf('id="connect"');
  const caveatPos = index.indexOf("Nothing here moves funds");
  assert.ok(caveatPos > testStart && caveatPos < connectPos, "the caveat precedes the wallet button");
  assert.match(index, /signature\s+<em>is<\/em>\s+authorisation/i);
  assert.match(index, /example contracts/i);
  // And why the view exists: real dapps gate the signing step.
  assert.match(index, /gate the signing step behind eligibility/i);
});

test("no path through the page tells the user to install one vendor", () => {
  assert.doesNotMatch(appJs, /install MetaMask/i);
  assert.match(appJs, /install any EVM wallet/i);
  const vendors = ["Rabby", "Frame", "Coinbase", "MetaMask", "Brave"];
  // The copy should read as vendor-neutral, so name more than one of them or
  // none -- naming exactly one implies that is the expected wallet.
  const named = vendors.filter((v) => index.includes(v) || appJs.includes(v));
  assert.ok(named.length === 0 || named.length > 1, `only named: ${named.join(", ")}`);
});

test("window.ethereum stays a fallback, never the first choice", () => {
  // Preferring it would reintroduce the race EIP-6963 fixes.
  assert.match(appJs, /discovered\[0\]\?\.provider \?\? window\.ethereum/);
});
