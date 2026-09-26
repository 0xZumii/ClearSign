/**
 * Keccak-256 — the pre-standard variant Ethereum uses.
 *
 * Function selectors are keccak256(signature)[:4]. `crypto.subtle.digest("SHA3-256")`
 * is NOT Keccak-256 (NIST changed the padding), so we implement it here.
 * Zero dependencies, runs identically in the browser and in Node.
 *
 * This is a direct port of evm_audit/keccak.py so the two tools agree. Selectors
 * are DERIVED at runtime, never hardcoded — tests/decode.test.js proves the
 * derived values match selectors already published on-chain.
 *
 * Lanes are 64-bit, so BigInt is required: JS bitwise operators truncate to 32.
 */

const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets indexed [x][y].
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const RATE = 136; // 1088-bit rate for Keccak-256

function rotl(x, n) {
  const r = BigInt(n) % 64n;
  if (r === 0n) return x & MASK;
  return ((x << r) | (x >> (64n - r))) & MASK;
}

function keccakF(a) {
  for (const rc of RC) {
    // theta
    const c = [];
    for (let x = 0; x < 5; x++) c.push(a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4]);
    const d = [];
    for (let x = 0; x < 5; x++) d.push(c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x][y] ^= d[x];

    // rho + pi
    const b = Array.from({ length: 5 }, () => new Array(5).fill(0n));
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) b[y][(2 * x + 3 * y) % 5] = rotl(a[x][y], ROT[x][y]);

    // chi
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        a[x][y] = b[x][y] ^ (((~b[(x + 1) % 5][y]) & MASK) & b[(x + 2) % 5][y]);

    // iota
    a[0][0] ^= rc;
  }
}

/** @param {Uint8Array} data @returns {Uint8Array} 32-byte digest */
export function keccak256(data) {
  const padlen = RATE - (data.length % RATE);
  const padded = new Uint8Array(data.length + padlen);
  padded.set(data);
  if (padlen === 1) {
    padded[data.length] = 0x81;
  } else {
    padded[data.length] = 0x01;
    padded[padded.length - 1] = 0x80;
  }

  const state = Array.from({ length: 5 }, () => new Array(5).fill(0n));
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      state[i % 5][Math.floor(i / 5)] ^= lane;
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i % 5][Math.floor(i / 5)];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

/**
 * Derive a 4-byte selector from an ABI signature, e.g. "approve(address,uint256)".
 * @param {string} signature
 * @returns {string} 0x-prefixed 4-byte selector
 */
export function selector(signature) {
  const digest = keccak256(new TextEncoder().encode(signature));
  return "0x" + [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Same digest, full 32 bytes, hex. Useful for EIP-712 and storage slots. */
export function keccak256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return "0x" + [...keccak256(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
