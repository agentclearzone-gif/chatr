/*
 * Solves the login bot-check puzzle off the main thread: find a nonce so that
 * SHA-256(salt + nonce) starts with `difficulty` zero bits. Compact SHA-256 below;
 * the salt + nonce always fits in one 64-byte block, so each attempt is a single compression.
 */
'use strict';
const K = new Uint32Array(64), H0 = new Uint32Array(8);
(() => {
  const frac = x => ((x - Math.floor(x)) * 4294967296) >>> 0;
  let n = 0;
  for (let p = 2; n < 64; p++) {
    let prime = true;
    for (let i = 2; i * i <= p; i++) if (p % i === 0) { prime = false; break; }
    if (!prime) continue;
    if (n < 8) H0[n] = frac(Math.sqrt(p));
    K[n++] = frac(Math.cbrt(p));
  }
})();
const W = new Uint32Array(64);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256 of a byte array; returns the 8 state words. */
function sha256(msg) {
  const len = msg.length;
  const blocks = (len + 9 + 63) >> 6;
  const buf = new Uint8Array(blocks * 64);
  buf.set(msg);
  buf[len] = 0x80;
  const bits = len * 8;
  buf[buf.length - 4] = bits >>> 24; buf[buf.length - 3] = bits >>> 16; buf[buf.length - 2] = bits >>> 8; buf[buf.length - 1] = bits;
  let h0 = H0[0], h1 = H0[1], h2 = H0[2], h3 = H0[3], h4 = H0[4], h5 = H0[5], h6 = H0[6], h7 = H0[7];
  for (let off = 0; off < buf.length; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      W[t] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let t = 16; t < 64; t++) {
      const a = W[t - 15], b = W[t - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return new Uint32Array([h0, h1, h2, h3, h4, h5, h6, h7]);
}

function solve(salt, difficulty) {
  const pre = Array.from(salt, ch => ch.charCodeAt(0)); // salt is ASCII
  const shift = 32 - difficulty;
  for (let n = 0; ; n++) {
    const s = String(n);
    const msg = new Uint8Array(pre.length + s.length);
    msg.set(pre);
    for (let i = 0; i < s.length; i++) msg[pre.length + i] = s.charCodeAt(i);
    if ((sha256(msg)[0] >>> shift) === 0) return s;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { sha256, solve };
else self.onmessage = e => self.postMessage({ nonce: solve(e.data.salt, e.data.difficulty) });
