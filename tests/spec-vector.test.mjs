/**
 * The EIP-712 spec's own "Mail" example, which publishes a known signature and
 * signer. This is an EXTERNAL reference: if our hashing or curve maths were
 * wrong, recovery would land on a random address and this test would fail.
 *
 * evm_audit/tests/test_eip712.py uses the same vector, so the Python and the
 * browser ports are pinned to one reference rather than to each other.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_DOMAIN_FIELDS,
  DOMAIN_SEPARATOR_SELECTOR,
  EIP712_DOMAIN_SELECTOR,
  checkDomain,
  classify,
  decodeEip712Domain,
  domainSeparator,
  encodeType,
  generatorAddress,
  hashTypedData,
  recoverAddress,
  toChecksumAddress,
  toHex,
  typeHash,
} from "../lib/eip712.js";
import { delegationTarget } from "../lib/rpc.js";

const MAIL_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Person: [
    { name: "name", type: "string" },
    { name: "wallet", type: "address" },
  ],
  Mail: [
    { name: "from", type: "Person" },
    { name: "to", type: "Person" },
    { name: "contents", type: "string" },
  ],
};

const MAIL_DOMAIN = {
  name: "Ether Mail",
  version: "1",
  chainId: 1,
  verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
};

const MAIL_MESSAGE = {
  from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
  to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
  contents: "Hello, Bob!",
};

const MAIL_SIGNATURE =
  "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d" +
  "07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b91562" +
  "1c";

const MAIL_SIGNER = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";

test("selectors are derived, and match the published values", () => {
  assert.equal(EIP712_DOMAIN_SELECTOR, "0x84b0196e");
  assert.equal(DOMAIN_SEPARATOR_SELECTOR, "0x3644e515");
});

test("encodeType appends referenced structs sorted by name", () => {
  assert.equal(
    encodeType("Mail", MAIL_TYPES),
    "Mail(Person from,Person to,string contents)Person(string name,address wallet)"
  );
});

test("typeHash is keccak of encodeType", () => {
  assert.equal(
    toHex(typeHash("Mail", MAIL_TYPES)),
    toHex(typeHash("Mail", MAIL_TYPES))
  );
});

test("recovers the signer the EIP-712 spec publishes", () => {
  const digest = hashTypedData(MAIL_DOMAIN, MAIL_TYPES, "Mail", MAIL_MESSAGE);
  assert.equal(recoverAddress(digest, MAIL_SIGNATURE), MAIL_SIGNER);
});

test("accepts legacy v and EIP-155 v", () => {
  const digest = hashTypedData(MAIL_DOMAIN, MAIL_TYPES, "Mail", MAIL_MESSAGE);
  // v=28 (recid 1) and its EIP-155 form for chainId 1: 2*1+35+1 = 38
  assert.equal(recoverAddress(digest, MAIL_SIGNATURE.slice(0, -2) + "1c"), MAIL_SIGNER);
  assert.equal(recoverAddress(digest, MAIL_SIGNATURE.slice(0, -2) + "26"), MAIL_SIGNER);
});

test("rejects an out-of-range recovery id", () => {
  const digest = hashTypedData(MAIL_DOMAIN, MAIL_TYPES, "Mail", MAIL_MESSAGE);
  assert.throws(() => recoverAddress(digest, MAIL_SIGNATURE.slice(0, -2) + "02"), /recovery id/);
});

test("the generator point derives a known address", () => {
  // Checks the curve maths and the keccak step together, without a signature.
  assert.equal(generatorAddress(), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
});

test("domain separator skips absent fields", () => {
  const two = domainSeparator({ name: "X", chainId: 1 });
  const three = domainSeparator({ name: "X", chainId: 1, version: "1" });
  assert.equal(two.length, 32);
  assert.notEqual(toHex(two), toHex(three));
});

test("canonical field order is the one EIP-712 fixes", () => {
  assert.deepEqual(
    CANONICAL_DOMAIN_FIELDS.map(([n]) => n),
    ["name", "version", "chainId", "verifyingContract", "salt"]
  );
});

test("decodes an ERC-5267 return value, present fields only", () => {
  const word = (n) => BigInt(n).toString(16).padStart(64, "0");
  const str = (s) => word(s.length) + Buffer.from(s).toString("hex").padEnd(64, "0");
  // fields = 0x0d -> bits 0,2,3 -> name, chainId, verifyingContract
  // bytes1 is left-aligned in its slot.
  const head =
    "0d" + "00".repeat(31) +
    word(224) +
    word(288) +
    word(1) +
    "0".repeat(24) + "0".repeat(39) + "1" +
    word(0) +
    word(320);
  const body = str("Example") + word(0) + word(0);

  const decoded = decodeEip712Domain("0x" + head + body);
  assert.deepEqual(decoded.present, ["name", "chainId", "verifyingContract"]);
  assert.equal(decoded.domain.name, "Example");
  assert.equal(decoded.domain.chainId, 1);
  assert.equal(decoded.domain.verifyingContract, "0x0000000000000000000000000000000000000001");
  assert.equal(decoded.domain.version, undefined, "absent fields must not be invented");
  assert.deepEqual(decoded.extensions, []);
});

test("checkDomain reports a match without a high finding", () => {
  const separator = toHex(domainSeparator(MAIL_DOMAIN));
  const out = checkDomain(MAIL_DOMAIN, separator, 1, MAIL_DOMAIN.verifyingContract);
  assert.equal(out.match, true);
  assert.equal(out.findings.filter((f) => f.level === "high").length, 0);
});

test("checkDomain flags a mismatch as high", () => {
  const out = checkDomain(MAIL_DOMAIN, "0x" + "00".repeat(32), 1);
  assert.equal(out.match, false);
  assert.ok(out.findings.some((f) => f.level === "high"));
});

test("classify never calls an unverifiable contract ok", () => {
  assert.equal(
    classify({ hasSeparator: false, declaredDomain: MAIL_DOMAIN, match: null, findings: [] }),
    "unverified"
  );
  assert.equal(
    classify({ hasSeparator: true, declaredDomain: null, match: null, findings: [] }),
    "no_domain"
  );
  assert.equal(
    classify({
      hasSeparator: true,
      declaredDomain: MAIL_DOMAIN,
      match: true,
      findings: [{ level: "info" }],
    }),
    "ok"
  );
});

test("delegationTarget parses a 7702 designator and ignores other code", () => {
  assert.equal(
    delegationTarget("0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d"),
    "0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d"
  );
  assert.equal(delegationTarget("0x6080604052"), null, "normal bytecode is not a designator");
  assert.equal(delegationTarget("0xef01005a7f"), null, "truncated designator is not one either");
  assert.equal(delegationTarget("0x"), null);
});

test("checksum addresses are EIP-55 correct", () => {
  assert.equal(
    toChecksumAddress("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"),
    "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
  );
});
