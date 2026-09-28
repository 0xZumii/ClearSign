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

test("an ERC-5267 contract checks with the address alone", () => {
  // The question that prompted this: do you need the name, or just the CA?
  // Modern contracts publish their domain, so the address is enough.
  const learnOrCheck = index.indexOf('id="view-check"');
  const addrPos = index.indexOf('id="address"');
  assert.ok(addrPos > learnOrCheck);
  assert.match(index, /Just paste the address and press Inspect/i);
  // Name/version must read as conditional, not required.
  assert.match(index, /only if asked for/i);
});

test("a contract that cannot be verified says where the name comes from", () => {
  // "Cannot verify" with no next step is a dead end.
  assert.match(appJs, /predates ERC-5267/);
  assert.match(appJs, /name\(\)<\/code> on the token/);
});

test("a payload never reaches the URL on its own", () => {
  // It used to live in the fragment so a second page could read it. That put a
  // request containing an address and an unlimited spender into the address bar
  // and browser history. The in-memory handoff made it unnecessary.
  assert.doesNotMatch(appJs, /location\.hash\s*=[^=]*payload/i);
  assert.doesNotMatch(appJs, /params\.set\("payload"\)[\s\S]{0,80}location\.hash/);
  // And any stale fragment is cleared on load.
  assert.match(appJs, /history\.replaceState/);
});

test("sharing is explicit and warns what the link contains", () => {
  // Sharing is genuinely useful, so it exists -- but it must never be silent
  // about carrying the spender address.
  assert.match(appJs, /share-payload/);
  assert.match(appJs, /It contains the whole request/i);
  assert.match(appJs, /treat the link\s+itself as sensitive/i);
  assert.match(index, /id="share-payload"/);
});

test("only wallets that can answer an EVM call are listed", () => {
  // Temple announces an Ethereum provider because it is a multichain wallet for
  // Tezos AND EVM -- that is what the spec asks of it. But a wallet sitting on
  // Tezos cannot sign Ethereum typed data, so offering it produces a choice that
  // fails on click.
  assert.match(appJs, /const admits/);
  assert.match(appJs, /provider\.request\(\{ method: "eth_chainId" \}\)/);
  // The spec says rdns is self-attested and must not drive feature detection,
  // so there must be no name allowlist.
  assert.doesNotMatch(appJs, /io\.metamask|com\.rabby|"temple"/i);
});

test("a wallet that never answers does not stall the list", () => {
  assert.match(appJs, /setTimeout\(\(\) => done\(false\), 1500\)/);
});

test("the picker explains why an owned wallet may be absent", () => {
  // Otherwise a missing Temple or Phantom reads as a bug rather than as
  // "that one is on another chain".
  assert.match(appJs, /Only wallets currently on an EVM network are listed/);
  assert.match(appJs, /switch it to an EVM network/i);
});

test("the mark is wired as both header logo and favicon", async () => {
  const readFile = (await import("node:fs/promises")).readFile;
  assert.match(index, /<img class="brand-mark" src="\.\/logo\.svg"/);
  assert.match(index, /rel="icon"[^>]*href="\.\/favicon\.svg"/);

  // Both assets must exist and be well-formed XML: an SVG is XML, and a single
  // "--" inside a comment makes it unparseable and renders nothing at all.
  for (const name of ["logo.svg", "favicon.svg"]) {
    const svg = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<\/svg>\s*$/);
    // Strip comments, then assert none of the survivors contain a double hyphen.
    const comments = svg.match(/<!--[\s\S]*?-->/g) ?? [];
    for (const c of comments) {
      assert.doesNotMatch(c.slice(4, -3), /--/, `${name}: "--" inside an XML comment`);
    }
  }
});

test("there is no checkmark in the mark, and here is why", async () => {
  const readFile = (await import("node:fs/promises")).readFile;
  const svg = await readFile(new URL("../logo.svg", import.meta.url), "utf8");
  // The tool refuses to say "safe"; a tick would claim it at brand level.
  assert.doesNotMatch(svg, /polyline/i);
  assert.match(svg, /why there is no checkmark/i);
});

test("the favicon is a reduced variant, because the detail does not survive", async () => {
  const readFile = (await import("node:fs/promises")).readFile;
  const favicon = await readFile(new URL("../favicon.svg", import.meta.url), "utf8");
  const logo = await readFile(new URL("../logo.svg", import.meta.url), "utf8");
  // The full mark's dotted tail renders at 0.38 device px at 16px -- a smear.
  assert.match(favicon, /Reduced mark/);
  assert.doesNotMatch(favicon, /stroke-dasharray/, "the favicon must not use dashes");
  assert.match(logo, /stroke-dasharray/, "the full mark keeps them");
});

test("the Learn tab leads with three answers, not a wall", () => {
  // The concern: length turns off the people who need it most. Three short
  // answers first; depth is available but collapsed.
  assert.match(index, /The three answers/i);
  assert.match(index, /Will the contract accept it\?/i);
  assert.match(index, /What does it authorize\?/i);
  assert.match(index, /Can it be used against you later\?/i);
});

test("depth is available but collapsed by default", () => {
  const learn = index.slice(index.indexOf('id="view-learn"'), index.indexOf('id="view-test"'));
  const more = (learn.match(/<details class="more">/g) ?? []).length;
  assert.ok(more >= 4, `expected several collapsed sections, found ${more}`);
  // None of them may start open, or the wall is back.
  assert.doesNotMatch(learn, /<details class="more" open>/);
});

test("the way back lives on Check, not on Learn", () => {
  // Reported bug: it was placed on Learn, where it does nothing, instead of on
  // the page the example sends you to.
  const checkStart = index.indexOf('id="view-check"');
  const learnStart = index.indexOf('id="view-learn"');
  const resetPos = index.indexOf('id="sample-reset"');
  assert.ok(resetPos > checkStart && resetPos < learnStart, "reset belongs to the Check view");
  assert.match(index, /id="back-to-learn" hidden/);
});

test("the way back stays hidden for someone who pasted their own request", () => {
  // It is navigation for a specific path, not permanent clutter.
  assert.match(appJs, /\$\("back-to-learn"\)\.hidden = false/);
  assert.match(appJs, /\$\("back-to-learn"\)\.hidden = true/);
  assert.match(appJs, /Any deliberate navigation hides it/);
});

test("the Learn tab covers hygiene beyond any single signature", () => {
  // The user asked for this: the habits that protect you when a check is fooled.
  assert.match(index, /Habits that matter more than any single check/i);
  assert.match(index, /burner/i);
  assert.match(index, /Revoke regularly/i);
  assert.match(index, /One wallet per job/i);
  // And the honest framing that neither replaces the other.
  assert.match(index, /no\s+substitute for this/i);
});

test("the Learn tab answers how long a permission stays open", () => {
  assert.match(index, /How long is a permission open for\?/i);
  assert.match(index, /Never expires/i);
  assert.match(index, /Already expired/i);
  assert.match(index, /allowance <em>right now<\/em>/i);
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
// held are about behavior, not about a filename, so they move here.

test("the Test view states what signing does and does not do, before any wallet use", () => {
  const testStart = index.indexOf('id="view-test"');
  const connectPos = index.indexOf('id="connect"');
  const caveatPos = index.indexOf("Nothing here moves funds");
  assert.ok(caveatPos > testStart && caveatPos < connectPos, "the caveat precedes the wallet button");
  assert.match(index, /signature\s+<em>is<\/em>\s+authorization/i);
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
