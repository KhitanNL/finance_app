// Usage: node tools/hash-password.mjs 'your-long-password'
// Prints an scrypt hash for the ADMIN_PASSWORD_HASH secret. The password itself is never stored anywhere.
import { scryptSync, randomBytes } from 'node:crypto';

const pw = process.argv[2];
// At least 12 characters; ALLOW_SHORT_PASSWORD=1 accepts 8 or more (login is rate limited to 5 tries per 15 minutes).
const min = process.env.ALLOW_SHORT_PASSWORD === '1' ? 8 : 12;
if (!pw || pw.length < min) {
  console.error(`Give a password of at least ${min} characters.`);
  process.exit(1);
}
// N=1024 keeps verification inside the Workers free plan CPU budget; login is also rate limited.
const N = 1024, r = 8, p = 1;
const salt = randomBytes(16);
const hash = scryptSync(pw, salt, 32, { N, r, p });
console.log(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`);
