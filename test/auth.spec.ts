import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  hashPassword,
  tempPassword,
  verifyPassword,
  verifySessionToken,
} from '../src/lib/auth';

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

  it('verifies its own tokens', async () => {
    const token = await createSessionToken('secret', 42, now);
    expect(await verifySessionToken('secret', token, now + 60)).toBe(42);
  });

  it('rejects tampering, wrong secrets, and expiry', async () => {
    const token = await createSessionToken('secret', 42, now);
    expect(await verifySessionToken('other-secret', token, now)).toBeNull();
    expect(await verifySessionToken('secret', `${token}x`, now)).toBeNull();
    expect(await verifySessionToken('secret', token.replace(/^./, 'Q'), now)).toBeNull();
    expect(await verifySessionToken('secret', token, now + 60 * 60 * 24 * 31)).toBeNull();
    expect(await verifySessionToken('secret', undefined, now)).toBeNull();
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
