// Minimal scrypt (RFC 7914) for Cloudflare Workers, using WebCrypto PBKDF2-HMAC-SHA256.
// Produces the same output as Node's crypto.scrypt, so tools/hash-password.mjs hashes verify here.
async function pbkdf2(pw, salt, len) {
  const key = await crypto.subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1 }, key, len * 8));
}
function salsa208(B) {
  const x = new Uint32Array(B);
  const R = (a, b) => (a << b) | (a >>> (32 - b));
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) >>> 0;
}
function blockMix(B, Y, r) {
  const X = B.slice((2 * r - 1) * 16, 2 * r * 16);
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
    salsa208(X);
    Y.set(X, (i % 2 ? r + (i >> 1) : i >> 1) * 16);
  }
}
export async function scrypt(password, salt, N, r, p, dkLen) {
  const pw = typeof password === 'string' ? new TextEncoder().encode(password) : password;
  const B = await pbkdf2(pw, salt, p * 128 * r);
  const words = 32 * r;
  for (let k = 0; k < p; k++) {
    const X = new Uint32Array(B.buffer.slice(k * 128 * r, (k + 1) * 128 * r));
    const V = new Uint32Array(words * N), Y = new Uint32Array(words);
    for (let i = 0; i < N; i++) { V.set(X, i * words); blockMix(X, Y, r); X.set(Y); }
    for (let i = 0; i < N; i++) {
      const j = X[(2 * r - 1) * 16] & (N - 1);
      for (let w = 0; w < words; w++) X[w] ^= V[j * words + w];
      blockMix(X, Y, r); X.set(Y);
    }
    new Uint8Array(B.buffer).set(new Uint8Array(X.buffer), k * 128 * r);
  }
  return pbkdf2(pw, B, dkLen);
}
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
// Stored format: scrypt$N$r$p$saltBase64$hashBase64
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, s, h] = parts;
  const want = unb64(h);
  const got = await scrypt(String(password || ''), unb64(s), +N, +r, +p, want.length);
  let diff = got.length ^ want.length;
  for (let i = 0; i < want.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
