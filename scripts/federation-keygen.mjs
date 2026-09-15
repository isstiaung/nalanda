// Generates this instance's identity for connections: an Ed25519 keypair, printed as the
// private JWK to store as the FEDERATION_PRIVATE_KEY secret (docs/proposals/connections.md §4).
// Nothing is written to disk.
const { subtle } = globalThis.crypto;

const keys = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const jwk = await subtle.exportKey('jwk', keys.privateKey);
const secret = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d });

// Same fingerprint as src/federation/keys.ts: first 128 bits of SHA-256 over the raw public key.
const digest = new Uint8Array(await subtle.digest('SHA-256', Buffer.from(jwk.x, 'base64url')));
const fingerprint = [...digest.slice(0, 16)]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')
  .match(/.{4}/g)
  .join(' ');

console.log(`Federation identity generated.

  Public key fingerprint: ${fingerprint}

Production — store it as a runtime secret, pasting the key below when prompted:
  npx wrangler secret put FEDERATION_PRIVATE_KEY

Local development — add this line to .dev.vars:
  FEDERATION_PRIVATE_KEY='${secret}'

The key:
${secret}

Keep a copy somewhere safe. It is not in the database and not in backups; losing it means
reconnecting with every household you're connected to.`);
