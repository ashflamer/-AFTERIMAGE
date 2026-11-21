'use strict';

// PIXEL CIPHER LAB — server engine.
// AES-128 (ECB/CBC) implemented from scratch, plus ciphertext-block
// analysis for the "ECB leaks the picture" demo. No dependencies beyond
// Node core `crypto` (used only for randomHex).

const crypto = require('crypto');

// Standard AES S-box.
const SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
const BLOCK = 16;

// PKCS#7 padding. Always appends 1–16 bytes; a 16-byte input gains a
// whole extra block of 0x10.
function pad(data) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const padLen = BLOCK - (input.length % BLOCK) || BLOCK;
  const out = new Uint8Array(input.length + padLen);
  out.set(input, 0);
  out.fill(padLen, input.length);
  return out;
}

// GF(2^8) multiply.
function gmul(a, b) {
  let p = 0;
  let x = a & 0xff;
  let y = b & 0xff;
  for (let i = 0; i < 8; i++) {
    if (y & 1) p ^= x;
    const hi = x & 0x80;
    x = (x << 1) & 0xff;
    if (hi) x ^= 0x1b;
    y >>= 1;
  }
  return p;
}

// AES-128 key expansion. Returns Uint8Array(176).
function expandKey(key16) {
  const key = key16 instanceof Uint8Array ? key16 : Uint8Array.from(key16);
  const w = new Uint8Array(176);
  w.set(key.subarray(0, 16), 0);
  let base = 16;
  let rconIndex = 0;
  while (base < 176) {
    let t0 = w[base - 4];
    let t1 = w[base - 3];
    let t2 = w[base - 2];
    let t3 = w[base - 1];
    if (base % 16 === 0) {
      // RotWord + SubWord + Rcon (Rcon index starts at 0).
      const s0 = SBOX[t1] ^ RCON[rconIndex];
      const s1 = SBOX[t2];
      const s2 = SBOX[t3];
      const s3 = SBOX[t0];
      rconIndex += 1;
      t0 = s0; t1 = s1; t2 = s2; t3 = s3;
    }
    const t = [t0, t1, t2, t3];
    for (let i = 0; i < 4; i++) {
      w[base + i] = w[base - 16 + i] ^ t[i];
    }
    base += 4;
  }
  return w;
}

function addRoundKey(state, w, round) {
  const off = round * 16;
  for (let i = 0; i < 16; i++) state[i] ^= w[off + i];
}

function subBytes(state) {
  for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];
}

// Column-major state: state[c*4 + r].
function shiftRows(state) {
  const out = new Uint8Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[c * 4 + r] = state[((c + r) % 4) * 4 + r];
    }
  }
  return out;
}

function mixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
    state[i]     = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
    state[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
    state[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
    state[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
  }
}

// Encrypt a single 16-byte block. `roundKeys` is the output of expandKey.
function encryptBlock(block16, roundKeys) {
  const state = Uint8Array.from(block16);
  addRoundKey(state, roundKeys, 0);
  for (let round = 1; round <= 9; round++) {
    subBytes(state);
    const shifted = shiftRows(state);
    state.set(shifted);
    mixColumns(state);
    addRoundKey(state, roundKeys, round);
  }
  subBytes(state);
  const shifted = shiftRows(state);
  state.set(shifted);
  addRoundKey(state, roundKeys, 10);
  return state;
}

// Receives ALREADY PADDED data (multiple of 16 bytes). Does not pad.
function encryptECB(padded, key16) {
  const input = padded instanceof Uint8Array ? padded : Uint8Array.from(padded);
  const w = expandKey(key16);
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 16) {
    out.set(encryptBlock(input.subarray(i, i + 16), w), i);
  }
  return out;
}

// Receives ALREADY PADDED data (multiple of 16 bytes). Does not pad.
function encryptCBC(padded, key16, iv16) {
  const input = padded instanceof Uint8Array ? padded : Uint8Array.from(padded);
  const iv = iv16 instanceof Uint8Array ? iv16 : Uint8Array.from(iv16);
  const w = expandKey(key16);
  const out = new Uint8Array(input.length);
  const prev = Uint8Array.from(iv.subarray(0, 16));
  const x = new Uint8Array(16);
  for (let i = 0; i < input.length; i += 16) {
    for (let j = 0; j < 16; j++) x[j] = input[i + j] ^ prev[j];
    const c = encryptBlock(x, w);
    out.set(c, i);
    prev.set(c);
  }
  return out;
}

function hexToBytes(str32) {
  const zero = () => new Uint8Array(16);
  if (typeof str32 !== 'string' || !/^[0-9a-fA-F]{32}$/.test(str32)) return zero();
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(str32.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function randomHex() {
  return crypto.randomBytes(16).toString('hex');
}

function blockKey(block, offset) {
  let key = '';
  for (let i = 0; i < 16; i++) key += block[offset + i] + ',';
  return key;
}

function analyzeSide(bytes, totalBlocks) {
  const seen = new Set();
  const dupMap = new Uint8Array(totalBlocks);
  let repeats = 0;
  for (let b = 0; b < totalBlocks; b++) {
    const key = blockKey(bytes, b * 16);
    if (seen.has(key)) {
      dupMap[b] = 1;
      repeats += 1;
    } else {
      seen.add(key);
    }
  }
  const uniqueCipher = seen.size;
  const leakPct = +(100 * repeats / totalBlocks).toFixed(2);
  return { uniqueCipher, repeats, leakPct, dupMap };
}

function analyze(paddedPlain, ecbCipher, cbcCipher) {
  const plain = paddedPlain instanceof Uint8Array ? paddedPlain : Uint8Array.from(paddedPlain);
  const ecb = ecbCipher instanceof Uint8Array ? ecbCipher : Uint8Array.from(ecbCipher);
  const cbc = cbcCipher instanceof Uint8Array ? cbcCipher : Uint8Array.from(cbcCipher);
  const totalBlocks = Math.floor(plain.length / 16);
  const plainSeen = new Set();
  for (let b = 0; b < totalBlocks; b++) {
    plainSeen.add(blockKey(plain, b * 16));
  }
  const uniquePlain = plainSeen.size;
  const ecbStats = analyzeSide(ecb, totalBlocks);
  const cbcStats = analyzeSide(cbc, totalBlocks);
  return {
    totalBlocks,
    uniquePlain,
    ecb: ecbStats,
    cbc: cbcStats,
  };
}

function histogram(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const counts = new Uint32Array(256);
  for (let i = 0; i < input.length; i++) counts[input[i]] += 1;
  return counts;
}

function selfTest() {
  const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
  const block = hexToBytes('00112233445566778899aabbccddeeff');
  const cipher = bytesToHex(encryptBlock(block, expandKey(key)));
  const expected = '69c4e0d86a7b0430d8cdb78070b4c55a';
  if (cipher !== expected) {
    throw new Error(`AES self-test failed: expected ${expected}, got ${cipher}`);
  }
  return true;
}

module.exports = {
  pad,
  expandKey,
  encryptBlock,
  encryptECB,
  encryptCBC,
  hexToBytes,
  bytesToHex,
  randomHex,
  analyze,
  histogram,
};

module.exports.selfTest = selfTest;
