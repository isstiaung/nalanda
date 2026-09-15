// This instance's signing identity for connections (docs/proposals/connections.md §4).
//
// Connections are enabled exactly when FEDERATION_PRIVATE_KEY holds a valid Ed25519 private
// JWK. Unset — or set to something that doesn't parse — and every connections route 404s and no
// connections UI renders, so an instance that never opts in behaves as it always has.
import { b64url } from '../lib/auth';

export type PublicJwk = { kty: 'OKP'; crv: 'Ed25519'; x: string };

export type Identity = {
  privateKey: CryptoKey;
  publicJwk: PublicJwk;
  /** Human-comparable: the first 128 bits of SHA-256 over the raw public key, in groups of four. */
  fingerprint: string;
};

const ED25519 = { name: 'Ed25519' } as const;
const enc = new TextEncoder();

// Parsed once per isolate per secret value. The promise is cached, so concurrent requests
// share a single import.
const identities = new Map<string, Promise<Identity | null>>();

export function loadIdentity(secret: string | undefined): Promise<Identity | null> {
  if (!secret) return Promise.resolve(null);
  let pending = identities.get(secret);
  if (!pending) {
    pending = parseIdentity(secret);
    identities.set(secret, pending);
  }
  return pending;
}

async function parseIdentity(secret: string): Promise<Identity | null> {
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(secret) as Record<string, unknown>;
  } catch {
    console.error('FEDERATION_PRIVATE_KEY is not valid JSON; connections stay disabled.');
    return null;
  }
  const x = jwk.x;
  const d = jwk.d;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !isKeyBytes(x) || !isKeyBytes(d)) {
    console.error('FEDERATION_PRIVATE_KEY is not an Ed25519 private JWK; connections stay disabled.');
    return null;
  }
  const publicJwk: PublicJwk = { kty: 'OKP', crv: 'Ed25519', x };
  try {
    const privateKey = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x, d }, ED25519, false, [
      'sign',
    ]);
    // WebCrypto doesn't promise to check that `x` belongs to `d`. A mismatched pair would sign
    // with one key while publishing another, so prove they agree once, here.
    const publicKey = await importPublicKey(publicJwk);
    const probe = enc.encode('nalanda identity self-check');
    const signature = await crypto.subtle.sign(ED25519, privateKey, probe);
    if (!publicKey || !(await crypto.subtle.verify(ED25519, publicKey, signature, probe))) {
      console.error('FEDERATION_PRIVATE_KEY: public and private parts do not match; connections stay disabled.');
      return null;
    }
    return { privateKey, publicJwk, fingerprint: await fingerprint(publicJwk) };
  } catch {
    console.error('FEDERATION_PRIVATE_KEY could not be imported; connections stay disabled.');
    return null;
  }
}

export function isPublicJwk(value: unknown): value is PublicJwk {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.kty === 'OKP' && v.crv === 'Ed25519' && isKeyBytes(v.x);
}

export async function importPublicKey(jwk: unknown): Promise<CryptoKey | null> {
  if (!isPublicJwk(jwk)) return null;
  try {
    return await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, ED25519, false, ['verify']);
  } catch {
    return null;
  }
}

export async function fingerprint(jwk: PublicJwk): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', b64url.decode(jwk.x)));
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return (hex.match(/.{4}/g) ?? []).join(' ');
}

/** 32 bytes as unpadded base64url — the size of both halves of an Ed25519 key. */
function isKeyBytes(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    return b64url.decode(value).length === 32;
  } catch {
    return false;
  }
}
