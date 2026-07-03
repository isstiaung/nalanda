// Password hashing (WebCrypto PBKDF2 — never a JS hashing library, see CLAUDE.md)
// and stateless HMAC-signed session cookies.

const ITERATIONS = 100_000; // workerd caps PBKDF2 at 100k; native-speed, fits CPU budget
const enc = new TextEncoder();

export const SESSION_COOKIE = 'nalanda_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export const b64url = {
  encode(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array {
    const std = s.replaceAll('-', '+').replaceAll('_', '/');
    const bin = atob(std.padEnd(Math.ceil(std.length / 4) * 4, '='));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  },
};

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64url.encode(salt)}$${b64url.encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterStr || !saltB64 || !hashB64) return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) return false;
  const expected = b64url.decode(hashB64);
  const actual = await pbkdf2(password, b64url.decode(saltB64), iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function createSessionToken(secret: string, userId: number, nowSeconds: number): Promise<string> {
  const payload = b64url.encode(enc.encode(JSON.stringify({ u: userId, e: nowSeconds + SESSION_TTL_SECONDS })));
  const sig = b64url.encode(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${sig}`;
}

/** Returns the user id for a valid, unexpired token; null otherwise. */
export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  nowSeconds: number,
): Promise<number | null> {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64url.decode(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64url.decode(payload))) as { u?: unknown; e?: unknown };
    if (typeof data.u !== 'number' || typeof data.e !== 'number') return null;
    if (data.e < nowSeconds) return null;
    return data.u;
  } catch {
    return null;
  }
}

/** Unambiguous alphabet (no 0/O/1/l/I) for admin-issued temp passwords. */
export function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
