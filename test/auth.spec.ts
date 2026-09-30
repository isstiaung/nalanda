import { describe, expect, it } from 'vitest';
import {
  accountIdentity,
  b64url,
  createSessionToken,
  hashPassword,
  isSessionKey,
  newSessionKey,
  sessionMatches,
  tempPassword,
  verifyPassword,
  verifySessionToken,
} from '../src/lib/auth';

/** A token signed with the real secret over any payload: what the code would accept if it only checked the HMAC. */
async function signedPayload(secret: string, data: unknown): Promise<string> {
  const enc = new TextEncoder();
  const payload = b64url.encode(enc.encode(JSON.stringify(data)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${payload}.${b64url.encode(await crypto.subtle.sign('HMAC', key, enc.encode(payload)))}`;
}

describe('password hashing', () => {
  it('round-trips and rejects wrong passwords', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('pbkdf2$100000$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$999999999$AA$BB')).toBe(false);
  });
});

describe('session tokens', () => {
  const now = 1_800_000_000;

  const ann = { id: 42, sessionKey: newSessionKey() };

  it('verifies its own tokens, naming the id and the key', async () => {
    const token = await createSessionToken('secret', ann, now);
    expect(await verifySessionToken('secret', token, now + 60)).toEqual({ userId: 42, key: ann.sessionKey });
  });

  it('rejects tampering, wrong secrets, and expiry', async () => {
    const token = await createSessionToken('secret', ann, now);
    expect(await verifySessionToken('other-secret', token, now)).toBeNull();
    expect(await verifySessionToken('secret', `${token}x`, now)).toBeNull();
    expect(await verifySessionToken('secret', token.replace(/^./, 'Q'), now)).toBeNull();
    expect(await verifySessionToken('secret', token, now + 60 * 60 * 24 * 31)).toBeNull();
    expect(await verifySessionToken('secret', undefined, now)).toBeNull();
  });

  // §16 #56: every cookie signed before keys existed is {u, e}. Genuine, unexpired — and it signs nobody in.
  it('rejects a genuine old-format token, which has no key', async () => {
    const old = await signedPayload('secret', { u: 42, e: now + 3600 });
    expect(await verifySessionToken('secret', old, now)).toBeNull();
  });

  it('rejects a genuine token whose key is the wrong shape: empty, short, long, or not a string', async () => {
    for (const k of ['', 'short', 'x'.repeat(65), 'has spaces in it 0123456789', 42, null, ['a'.repeat(22)]]) {
      const token = await signedPayload('secret', { u: 42, k, e: now + 3600 });
      expect(await verifySessionToken('secret', token, now), JSON.stringify(k)).toBeNull();
    }
    const fractional = await signedPayload('secret', { u: 42.5, k: ann.sessionKey, e: now + 3600 });
    expect(await verifySessionToken('secret', fractional, now)).toBeNull();
  });

  it('matches a session to its own account only: same id and same key', async () => {
    const session = await verifySessionToken('secret', await createSessionToken('secret', ann, now), now);
    expect(sessionMatches(session, ann)).toBe(true);
    // the same id, given to someone else later, with a key of their own
    expect(sessionMatches(session, { id: 42, sessionKey: newSessionKey() })).toBe(false);
    // another id holding the same key
    expect(sessionMatches(session, { id: 43, sessionKey: ann.sessionKey })).toBe(false);
    // a row with no usable key never matches, even a session naming that same nothing
    expect(sessionMatches({ userId: 42, key: '' }, { id: 42, sessionKey: '' })).toBe(false);
    expect(sessionMatches(null, ann)).toBe(false);
    expect(sessionMatches(session, null)).toBe(false);
  });

  it('refuses to sign a token for an account with no usable key', async () => {
    await expect(createSessionToken('secret', { id: 42, sessionKey: '' }, now)).rejects.toThrow();
    await expect(createSessionToken('secret', { id: 42, sessionKey: 'short' }, now)).rejects.toThrow();
  });
});

describe('session keys', () => {
  it('are 16 random bytes, base64url, never the same twice', () => {
    const keys = Array.from({ length: 200 }, newSessionKey);
    for (const k of keys) {
      expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(b64url.decode(k)).toHaveLength(16);
      expect(isSessionKey(k)).toBe(true);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('include the 32 hex digits migration 0029 gives existing accounts, and never the empty default', () => {
    expect(isSessionKey('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isSessionKey('')).toBe(false);
  });

  it('name one account across time: accountIdentity differs for the same id with another key', () => {
    const before = { id: 7, sessionKey: newSessionKey() };
    const after = { id: 7, sessionKey: newSessionKey() };
    expect(accountIdentity(before)).not.toBe(accountIdentity(after));
    expect(accountIdentity(before)).toBe(`7:${before.sessionKey}`);
    expect(() => accountIdentity({ id: 7, sessionKey: '' })).toThrow();
  });
});

describe('temp passwords', () => {
  it('generates 12 unambiguous characters', () => {
    const p = tempPassword();
    expect(p).toHaveLength(12);
    expect(/^[a-zA-Z2-9]+$/.test(p)).toBe(true);
    expect(/[0O1lI]/.test(p)).toBe(false);
  });
});
