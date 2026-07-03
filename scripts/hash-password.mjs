// Generates a password hash in the app's format (WebCrypto PBKDF2) for CLI recovery —
// see runbooks/accounts-and-access.md (admin lockout).
//   node scripts/hash-password.mjs 'new-password-here'
const password = process.argv[2];
if (!password) {
  console.error("usage: node scripts/hash-password.mjs 'new-password'");
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
  'deriveBits',
]);
const bits = new Uint8Array(
  await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256),
);
const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

console.log(`pbkdf2$100000$${b64url(salt)}$${b64url(bits)}`);
