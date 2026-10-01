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

/**
 * A session secret that can sign anything: set, and not blank. Missing, empty and whitespace-only all count as
 * none — an empty key makes WebCrypto throw, and a blank one would sign cookies anyone could forge. Without one
 * nobody can be signed in, and setup and login say so before writing anything.
 */
export function hasSessionSecret(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.trim() !== '';
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/**
 * A new account's session key (§16 #56): 16 random bytes, base64url. User ids are reused — SQLite gives a new row
 * max(id)+1, so removing the newest member frees theirs for the next one made — but a key never is, so a cookie that
 * names an id and a key only ever signs in the account it was made for. Anything else that must name one account
 * across time, rather than an id that may later be someone else's, derives from `accountIdentity()`.
 */
export function newSessionKey(): string {
  return b64url.encode(crypto.getRandomValues(new Uint8Array(16)));
}

// What a key looks like: 22 characters from newSessionKey(), 32 hex digits from migration 0029's backfill. Anything
// else — the '' the column's default leaves on a row inserted without one — signs nobody in.
const SESSION_KEY = /^[A-Za-z0-9_-]{22,64}$/;

/** Whether an account has a usable key. One without (inserted by hand, or restored from an older backup) gets one when
 * its password next signs in (`ensureSessionKey()`); until then no cookie signs it in. */
export function isSessionKey(key: string): boolean {
  return SESSION_KEY.test(key);
}

/** An account as a session names it: its id, and the key that tells it from anyone given that id before or after. */
export type AccountRef = { id: number; sessionKey: string };

/**
 * An account as a cookie is made for it (§16 #70): the identity, and which generation of its sessions this is. Absent
 * means 0, the generation every account starts in — a row inserted before the column, a stamp that needs no generation.
 */
export type SessionRef = AccountRef & { sessionGeneration?: number };

/** The id, key and generation a genuine cookie names — still to be checked against the user row, by `sessionMatches()`. */
export type Session = { userId: number; key: string; generation: number };

/**
 * One account and no other, ever: its id and its key. For anything derived from who someone is that must not carry
 * over to whoever is given the same id later — a session, or an HMAC stamp over `"<purpose>:" + accountIdentity(user)`.
 */
export function accountIdentity(user: AccountRef): string {
  if (!SESSION_KEY.test(user.sessionKey)) throw new Error('this account has no session key');
  return `${user.id}:${user.sessionKey}`;
}

export async function createSessionToken(secret: string, user: SessionRef, nowSeconds: number): Promise<string> {
  if (!hasSessionSecret(secret)) throw new Error('SESSION_SECRET is not set');
  if (!SESSION_KEY.test(user.sessionKey)) throw new Error('this account has no session key');
  // `g` only from 1 on: a cookie made in generation 0 is as it always was, byte for byte
  const g = user.sessionGeneration ?? 0;
  const payload = b64url.encode(
    enc.encode(JSON.stringify({ u: user.id, k: user.sessionKey, ...(g > 0 ? { g } : {}), e: nowSeconds + SESSION_TTL_SECONDS })),
  );
  const sig = b64url.encode(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${sig}`;
}

/**
 * Whose scans a device's offline queue holds (ARCH.md §16 #48): an opaque stamp per account, written into every
 * signed-in page. A page signed in as someone else finds a different stamp and empties the queue before anything
 * shows it, and adding from the review list must carry the stamp of whoever is signed in now. An HMAC, so the stamp
 * says nothing about the account; its message ("scan-queue:<id>:<key>") has colons, which a session payload —
 * base64url — never does, so no stamp is ever a valid session signature. It names the account, not its id
 * (`accountIdentity()`, §16 #56): a member added after one was removed may be given their id, and must not find the
 * removed member's scans on a shared phone, nor add them.
 */
export async function scanQueueOwner(secret: string, user: AccountRef): Promise<string> {
  const message = `scan-queue:${accountIdentity(user)}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message));
  return b64url.encode(new Uint8Array(sig).slice(0, 16));
}

/**
 * Which account a gift-list publish form was made for (§16 #53): an HMAC over "gift-list:" + accountIdentity(), as the
 * scan queue's stamp is over its own purpose. The form names the member by id, and ids are reused (§16 #56): a form
 * left open while that member was removed and someone new was given the id must publish nothing, not the newcomer's list.
 */
export async function giftListStamp(secret: string, user: AccountRef): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`gift-list:${accountIdentity(user)}`));
  return b64url.encode(new Uint8Array(sig).slice(0, 16));
}

/**
 * The id and key of a genuine, unexpired token; null otherwise. Always null without a session secret, and for a token
 * with no key — every cookie signed before keys existed (§16 #56), so upgrading signs everyone out once. A session
 * returned here may still name an account that is gone, or an id that is someone else's now: `sessionMatches()`
 * against the user row decides.
 */
export async function verifySessionToken(
  secret: string | undefined,
  token: string | undefined,
  nowSeconds: number,
): Promise<Session | null> {
  if (!token || !hasSessionSecret(secret)) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64url.decode(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64url.decode(payload))) as { u?: unknown; k?: unknown; g?: unknown; e?: unknown };
    if (typeof data.u !== 'number' || !Number.isInteger(data.u) || typeof data.e !== 'number') return null;
    if (typeof data.k !== 'string' || !SESSION_KEY.test(data.k)) return null;
    // no `g` is generation 0 — every cookie from before generations (§16 #70), still good until its account moves on
    if (data.g !== undefined && (typeof data.g !== 'number' || !Number.isInteger(data.g) || data.g < 0)) return null;
    if (data.e < nowSeconds) return null;
    return { userId: data.u, key: data.k, generation: data.g ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Whether a genuine session belongs to this user row, now: same id, same key, and the row's current generation. A
 * removed member's cookie names their key, and whoever is given their id next has another, so it signs in nobody; a
 * cookie from before "Sign out other devices", a password change or a reset names an earlier generation (§16 #70), and
 * signs in nobody either. A plain comparison is enough: only a cookie whose HMAC checked out gets here, and its holder
 * can already read what is inside it — the key is no secret, it is just never reused, and the generation is a count.
 */
export function sessionMatches(session: Session | null, user: SessionRef | null): boolean {
  if (!session || !user) return false;
  return (
    user.id === session.userId &&
    SESSION_KEY.test(user.sessionKey) &&
    user.sessionKey === session.key &&
    (user.sessionGeneration ?? 0) === session.generation
  );
}

/** Unambiguous alphabet (no 0/O/1/l/I) for admin-issued temp passwords. */
export function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
