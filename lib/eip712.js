/**
 * EIP-712 hashing, ERC-5267 decoding, and secp256k1 recovery — browser port.
 *
 * This is a direct port of evm_audit/eip712.py. The two are pinned to the same
 * external reference: the EIP-712 spec's own "Mail" example, which publishes a
 * known signature and signer. tests/spec-vector.test.mjs recovers that address
 * here, and tests/test_eip712.py recovers it in Python. If either port drifts,
 * one of those tests fails — the reference is not this file, and not the Python.
 *
 * Pure: no network, no DOM. Everything below is a function of its inputs.
 */

import { keccak256, selector } from "./keccak.js";

// ERC-5267 eip712Domain() and EIP-2612 DOMAIN_SEPARATOR(). Derived, not hardcoded.
export const EIP712_DOMAIN_SELECTOR = selector("eip712Domain()");
export const DOMAIN_SEPARATOR_SELECTOR = selector("DOMAIN_SEPARATOR()");

/** EIP-712 domain fields, in the order the spec fixes them. */
export const CANONICAL_DOMAIN_FIELDS = [
  ["name", "string"],
  ["version", "string"],
  ["chainId", "uint256"],
  ["verifyingContract", "address"],
  ["salt", "bytes32"],
];

const UINT256 = 1n << 256n;

// ---------------------------------------------------------------------------
// hex / bytes helpers
// ---------------------------------------------------------------------------
export function parseHex(text) {
  let s = String(text ?? "").replace(/[\s_]/g, "");
  if (s.slice(0, 2).toLowerCase() === "0x") s = s.slice(2);
  if (s.length % 2) s = "0" + s;
  if (s && !/^[0-9a-fA-F]+$/.test(s)) throw new Error("input is not valid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function toHex(bytes) {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function utf8(text) {
  return new TextEncoder().encode(String(text));
}

/** Big-endian 32-byte word from a BigInt, reduced mod 2^256. */
function word(value) {
  let n = BigInt(value) % UINT256;
  if (n < 0n) n += UINT256;
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function wordFromBytes(bytes, padTo = 32) {
  const out = new Uint8Array(padTo);
  out.set(bytes.slice(0, padTo));
  return out;
}

/** Normalize an address-or-BigInt to a 160-bit BigInt. */
function toBigIntValue(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") {
    const s = value.trim();
    return BigInt(s.startsWith("0x") || s.startsWith("0X") ? s : s);
  }
  throw new Error(`cannot read an integer from ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// EIP-712 encoding
// ---------------------------------------------------------------------------
function fieldsOf(types, name) {
  const raw = types[name];
  if (raw === undefined) throw new Error(`type '${name}' is not defined`);
  return raw.map((f) => [f.type, f.name]);
}

function baseType(typeName) {
  return typeName.replace(/\[[0-9]*\]/g, "");
}

function collectDependencies(name, types, seen) {
  for (const [typeName] of fieldsOf(types, name)) {
    const base = baseType(typeName);
    if (base !== name && types[base] !== undefined && !seen.has(base)) {
      seen.add(base);
      collectDependencies(base, types, seen);
    }
  }
}

function oneType(name, types) {
  const members = fieldsOf(types, name)
    .map(([t, n]) => `${t} ${n}`)
    .join(",");
  return `${name}(${members})`;
}

/** EIP-712 encodeType: primary type, then referenced structs sorted by name. */
export function encodeType(primary, types) {
  const deps = new Set();
  collectDependencies(primary, types, deps);
  let out = oneType(primary, types);
  for (const name of [...deps].sort()) out += oneType(name, types);
  return out;
}

export function typeHash(primary, types) {
  return keccak256(utf8(encodeType(primary, types)));
}

function encodeValue(typeName, value, types) {
  if (typeName === "string") return keccak256(utf8(value));
  if (typeName === "bytes") return keccak256(parseHex(value));
  if (typeName === "bool") return word(value ? 1n : 0n);
  if (typeName === "address") return word(toBigIntValue(value) & ((1n << 160n) - 1n));
  if (typeName.startsWith("uint") || typeName.startsWith("int")) {
    return word(toBigIntValue(value));
  }
  if (/^bytes\d+$/.test(typeName)) {
    const n = parseInt(typeName.slice(5), 10);
    return wordFromBytes(parseHex(value), n);
  }
  if (typeName.endsWith("]")) {
    const inner = typeName.slice(0, typeName.lastIndexOf("["));
    if (!Array.isArray(value)) throw new Error(`array type ${typeName} needs a list value`);
    return keccak256(concatBytes(...value.map((v) => encodeValue(inner, v, types))));
  }
  if (types[typeName] !== undefined) return hashStruct(typeName, types, value);
  throw new Error(`unsupported EIP-712 type '${typeName}'`);
}

export function hashStruct(primary, types, data) {
  const parts = [typeHash(primary, types)];
  for (const [typeName, fieldName] of fieldsOf(types, primary)) {
    if (data == null || !(fieldName in data)) {
      throw new Error(
        `value for '${primary}.${fieldName}' is missing; the declared type does not match the data`
      );
    }
    parts.push(encodeValue(typeName, data[fieldName], types));
  }
  return keccak256(concatBytes(...parts));
}

/** EIP-712 domain separator. `order` pins field order (e.g. from a bitmask). */
export function domainSeparator(domain, types = null, order = null) {
  if (types && types.EIP712Domain) return hashStruct("EIP712Domain", types, domain);
  const declared = order
    ? order.map((k) => {
        const found = CANONICAL_DOMAIN_FIELDS.find(([n]) => n === k);
        if (!found) throw new Error(`unknown domain field '${k}'`);
        return { name: k, type: found[1] };
      })
    : CANONICAL_DOMAIN_FIELDS.filter(([n]) => n in domain).map(([name, type]) => ({ name, type }));
  return hashStruct("EIP712Domain", { EIP712Domain: declared }, domain);
}

/** The 32-byte digest a signer signs: keccak256(0x1901 || domainSeparator || hashStruct(message)). */
export function hashTypedData(domain, types, primaryType, message) {
  const dom = domainSeparator(domain, types);
  const msg = hashStruct(primaryType, types, message);
  return keccak256(concatBytes(Uint8Array.from([0x19, 0x01]), dom, msg));
}

// ---------------------------------------------------------------------------
// ERC-5267 eip712Domain() decoding
// ---------------------------------------------------------------------------
function readWord(data, index) {
  const start = index * 32;
  return data.slice(start, start + 32);
}

function wordToBigInt(w) {
  let n = 0n;
  for (const b of w) n = (n << 8n) | BigInt(b);
  return n;
}

function readBytesAt(data, offset) {
  if (offset + 32 > data.length) throw new Error("dynamic offset past end of return data");
  const length = Number(wordToBigInt(readWord(data, offset / 32)));
  const start = offset + 32;
  if (start + length > data.length) throw new Error("dynamic payload past end of return data");
  return data.slice(start, start + length);
}

function readStringAt(data, offset) {
  return new TextDecoder().decode(readBytesAt(data, offset));
}

/**
 * Decode the ERC-5267 eip712Domain() return value.
 * `fields` is a BITMASK over CANONICAL_DOMAIN_FIELDS (bit i => field i present),
 * not an array. Values for absent fields are unspecified and are not read.
 */
export function decodeEip712Domain(returnHex) {
  const data = parseHex(returnHex);
  if (data.length < 7 * 32) throw new Error("eip712Domain() return data is too short");
  const fields = data[0];
  const values = {
    name: readStringAt(data, Number(wordToBigInt(readWord(data, 1)))),
    version: readStringAt(data, Number(wordToBigInt(readWord(data, 2)))),
    chainId: Number(wordToBigInt(readWord(data, 3))),
    verifyingContract: toHex(readWord(data, 4).slice(12)),
    salt: toHex(readWord(data, 5)),
  };
  const present = CANONICAL_DOMAIN_FIELDS.filter((_, i) => fields & (1 << i)).map(([n]) => n);
  const domain = {};
  for (const key of present) domain[key] = values[key];

  const extensions = [];
  const extOffset = Number(wordToBigInt(readWord(data, 6)));
  if (extOffset) {
    const count = Number(wordToBigInt(readWord(data, extOffset / 32)));
    for (let i = 0; i < count; i++) {
      extensions.push(Number(wordToBigInt(readWord(data, extOffset / 32 + 1 + i))));
    }
  }
  return { fieldsByte: fields, present, domain, extensions };
}

// ---------------------------------------------------------------------------
// secp256k1 public-key recovery (no dependency)
// ---------------------------------------------------------------------------
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];

function mod(a, m = P) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

/** Modular inverse via the extended Euclidean algorithm (no Fermat shortcut). */
export function modInv(a, m = P) {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error("no modular inverse exists");
  return mod(old_s, m);
}

function pointAdd(p, q) {
  if (p === null) return q;
  if (q === null) return p;
  if (p[0] === q[0] && mod(p[1] + q[1]) === 0n) return null;
  const lam =
    p[0] === q[0] && p[1] === q[1]
      ? mod(3n * p[0] * p[0] * modInv(2n * p[1]))
      : mod((q[1] - p[1]) * modInv(q[0] - p[0]));
  const x = mod(lam * lam - p[0] - q[0]);
  const y = mod(lam * (p[0] - x) - p[1]);
  return [x, y];
}

function pointMul(k, point) {
  let result = null;
  let addend = point;
  let n = k;
  while (n > 0n) {
    if (n & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    n >>= 1n;
  }
  return result;
}

function publicKeyToAddress(point) {
  if (point === null) throw new Error("cannot derive an address from an invalid public key");
  const raw = concatBytes(word(point[0]), word(point[1]));
  return toChecksumAddress(toHex(keccak256(raw).slice(12)));
}

/** EIP-55 mixed-case checksum. */
export function toChecksumAddress(address) {
  const addr = address.replace(/^0x/i, "").toLowerCase();
  const digest = Array.from(keccak256(utf8(addr)), (b) => b.toString(16).padStart(2, "0")).join("");
  let out = "0x";
  for (let i = 0; i < addr.length; i++) {
    out += parseInt(digest[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  }
  return out;
}

/** Recover the signer address from a 65-byte r||s||v signature. */
export function recoverAddress(digest, signature) {
  const sig = typeof signature === "string" ? parseHex(signature) : signature;
  if (sig.length !== 65) throw new Error(`signature must be 65 bytes, got ${sig.length}`);
  const r = wordToBigInt(sig.slice(0, 32));
  const s = wordToBigInt(sig.slice(32, 64));
  const v = sig[64];
  if (!(r > 0n && r < N && s > 0n && s < N)) throw new Error("r or s is out of range for secp256k1");

  let recid;
  if (v >= 35) recid = (v - 35) % 2;
  else if (v === 27 || v === 28) recid = v - 27;
  else if (v === 0 || v === 1) recid = v;
  else throw new Error(`unrecognised recovery id / v value: ${v}`);

  const x = r + BigInt(Math.floor(recid / 2)) * N;
  if (x >= P) throw new Error("recovered x is not on the curve");
  const ySq = mod(x ** 3n + 7n);
  let y = modPow(ySq, (P + 1n) / 4n, P);
  if (mod(y * y) !== ySq) throw new Error("point is not on secp256k1");
  if ((y & 1n) !== BigInt(recid & 1)) y = P - y;

  const z = mod(wordToBigInt(digest), N);
  let negZ = pointMul(z, G);
  if (negZ) negZ = [negZ[0], mod(-negZ[1])];
  const numerator = pointAdd(pointMul(s, [x, y]), negZ);
  return publicKeyToAddress(pointMul(modInv(r, N), numerator));
}

function modPow(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/** Derive the address for the generator point — a known constant, used in tests. */
export function generatorAddress() {
  return publicKeyToAddress(G);
}

// ---------------------------------------------------------------------------
// Comparison helpers (pure; the caller fetches the on-chain values)
// ---------------------------------------------------------------------------
function norm32(value) {
  const raw = String(value).replace(/^0x/i, "");
  return "0x" + raw.padStart(64, "0").toLowerCase();
}

/**
 * Compare a declared domain against on-chain facts. Returns findings in the
 * same vocabulary as the CLI, so the two surfaces report identically.
 */
export function checkDomain(declared, onchainSeparator, nodeChainId = null, address = null) {
  const findings = [];
  const recomputed = toHex(domainSeparator(declared));
  let match = null;

  if (onchainSeparator) {
    match = recomputed === norm32(onchainSeparator);
    findings.push(
      match
        ? {
            level: "info",
            message:
              "The declared EIP-712 domain hashes to the contract's on-chain DOMAIN_SEPARATOR(). Wallets that sign this domain will be verified.",
          }
        : {
            level: "high",
            message:
              "The declared EIP-712 domain does NOT hash to the contract's DOMAIN_SEPARATOR(). Signatures a wallet produces from this domain will be rejected on-chain. This is the silent EIP-712 failure.",
          }
    );
  } else {
    findings.push({
      level: "notable",
      message:
        "The contract declares an EIP-712 domain but exposes no DOMAIN_SEPARATOR() to check it against, so it cannot be verified here.",
    });
  }

  if (nodeChainId != null && declared.chainId != null && Number(declared.chainId) !== Number(nodeChainId)) {
    findings.push({
      level: "high",
      message: `Declared chainId ${declared.chainId} does not match this chain (${nodeChainId}). Signatures are bound to the wrong chain, or the domain was copied from another deployment.`,
    });
  }
  if (address && declared.verifyingContract && String(declared.verifyingContract).toLowerCase() !== address.toLowerCase()) {
    findings.push({
      level: "notable",
      message: `Declared verifyingContract ${declared.verifyingContract} is not the queried address ${address}. Confirm that is intended.`,
    });
  }

  return {
    recomputedSeparator: recomputed,
    onchainSeparator: onchainSeparator ? norm32(onchainSeparator) : null,
    match,
    findings,
  };
}

/** Reduce a result to one auditable outcome — mirrors evm_audit.discovery.classify. */
export function classify(result) {
  if (result.hasSeparator !== true) {
    return result.declaredDomain == null ? "no_domain" : "unverified";
  }
  if (result.match === true) {
    return result.findings.some((f) => f.level === "high") ? "mismatch" : "ok";
  }
  if (result.match === false) return "mismatch";
  return result.declaredDomain == null ? "no_domain" : "uncompared";
}
