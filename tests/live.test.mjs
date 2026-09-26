/**
 * Drives lib/inspect.js against LIVE mainnet. The spec-vector tests prove the
 * maths; this proves the orchestration — that a real contract with a real
 * separator comes back `ok`, and an unusable address comes back honestly.
 *
 * Network-dependent: needs a reachable RPC. Skips (does not fail) if none is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Rpc, delegationTarget } from "../lib/rpc.js";
import { inspectContract, inspectPayload } from "../lib/inspect.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AAVE = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";
const rpc = new Rpc();

let reachable = true;
try {
  await rpc.chainId();
} catch {
  reachable = false;
  console.warn("no RPC reachable from Node; live checks skipped");
}

test("USDC verifies when its deployed name/version are supplied", { skip: !reachable }, async () => {
  const result = await inspectContract(rpc, USDC, { name: "USD Coin", version: "2" });
  assert.equal(result.status, "ok");
  assert.equal(result.match, true);
  assert.equal(result.hasSeparator, true);
  assert.ok(!result.findings.some((f) => f.level === "high"));
});

test("a wrong name produces a loud mismatch, not a quiet pass", { skip: !reachable }, async () => {
  const result = await inspectContract(rpc, USDC, { name: "USDC", version: "2" });
  assert.equal(result.status, "mismatch");
  assert.equal(result.match, false);
  assert.ok(result.findings.some((f) => f.level === "high"));
});

test("Aave verifies with no help from the caller (ERC-5267)", { skip: !reachable }, async () => {
  const result = await inspectContract(rpc, AAVE, null);
  assert.equal(result.declarationSource, "ERC-5267 eip712Domain()");
  assert.equal(result.status, "ok");
  assert.equal(result.declaredDomain.name, "Aave token V3");
});

test("an EIP-7702 delegated account is reported as delegated, not clean", { skip: !reachable }, async () => {
  // This address's code is a 0xef0100 delegation designator, not a contract.
  // The right answer is "the code lives elsewhere", not a bland pass.
  const result = await inspectContract(rpc, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", null);
  assert.ok(["delegated", "no_contract"].includes(result.status), `got ${result.status}`);
  if (result.status === "delegated") {
    assert.match(result.delegationTarget, /^0x[0-9a-f]{40}$/);
    assert.ok(result.findings.some((f) => /EIP-7702/.test(f.message)));
  }
});

test("a separator with no name is unverified, not ok", { skip: !reachable }, async () => {
  const result = await inspectContract(rpc, USDC, null);
  assert.equal(result.status, "unverified");
  assert.equal(result.match, null);
});

test("payload domain is compared against the verifying contract", { skip: !reachable }, async () => {
  const payload = {
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
    domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC },
    message: {
      owner: "0x2222222222222222222222222222222222222222",
      spender: "0x1111111111111111111111111111111111111111",
      value: "1000",
      nonce: 0,
      deadline: 0,
    },
  };
  const result = await inspectPayload(rpc, payload, { checkOnchain: true });
  assert.ok(result.digest?.startsWith("0x"));
  assert.equal(result.onchainMatch, true);
  assert.ok(!result.findings.some((f) => f.level === "high"));
});

test("a payload with a fabricated domain is flagged against chain", { skip: !reachable }, async () => {
  const payload = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Permit: [{ name: "owner", type: "address" }],
    },
    primaryType: "Permit",
    domain: { name: "Definitely USDC", version: "2", chainId: 1, verifyingContract: USDC },
    message: { owner: "0x2222222222222222222222222222222222222222" },
  };
  const result = await inspectPayload(rpc, payload, { checkOnchain: true });
  assert.equal(result.onchainMatch, false);
  assert.ok(result.findings.some((f) => f.level === "high"));
});
