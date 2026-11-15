// Usage: node tools/hash-password.mjs 'your-long-password'
// Prints an scrypt hash for the ADMIN_PASSWORD_HASH secret. The password itself is never stored anywhere.
import { scryptSync, randomBytes } from 'node:crypto';

const pw = process.argv[2];
if (!pw || pw.length < 12) {
  console.error('Give a password of at least 12 characters.');
  process.exit(1);
}
// N=1024 keeps verification inside the Workers free plan CPU budget; login is also rate limited.
const N = 1024, r = 8, p = 1;
const salt = randomBytes(16);
const hash = scryptSync(pw, salt, 32, { N, r, p });
console.log(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`);
