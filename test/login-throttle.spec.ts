// Login throttling (ARCH.md §8): ten failed password checks in ten minutes from one address, or at one account from
// anywhere, and the next is refused with 429 before the password is looked at — the right one included. The attempt
// is counted in the statement that checks the count, so a burst in parallel stops at ten too, and a password that
// turns out right takes its row back. The same counter guards the current-password check under Account.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createUser, LOGIN_ATTEMPT_LIMIT } from '../src/db/queries';
import app from '../src/index';
import { DUMMY_HASH, hashPassword } from '../src/lib/auth';
import { as, member, rows } from './member-helpers';

const ORIGIN = 'http://nalanda.test';
const TOO_MANY = 'Too many attempts';
const WRONG = 'Wrong username or password.';

async function login(username: string, password: string, ip = '203.0.113.9') {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}/auth/login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
      body: new URLSearchParams({ username, password }).toString(),
      redirect: 'manual',
    }),
    env,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, text, location: res.headers.get('location') };
}

const attempts = (where = '1=1', ...binds: unknown[]) =>
  rows<{ ip: string; username: string }>(`SELECT ip, username FROM login_attempts WHERE ${where} ORDER BY rowid`, ...binds);

const ravi = async () =>
  createUser(env.DB, { username: 'ravi', passwordHash: await hashPassword('correct horse'), role: 'admin', mustChangePassword: false });

describe('the login throttle', () => {
  it('stops a burst of parallel wrong guesses at the limit: the rest are 429 and never reach the password check', async () => {
    await ravi();
    const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => login('ravi', `guess-${i}`)));
    const verified = burst.filter((r) => r.status === 200 && r.text.includes(WRONG));
    const throttled = burst.filter((r) => r.status === 429 && r.text.includes(TOO_MANY));
    expect(verified.length).toBe(LOGIN_ATTEMPT_LIMIT);
    expect(throttled.length).toBe(30 - LOGIN_ATTEMPT_LIMIT);
    expect(await attempts()).toHaveLength(LOGIN_ATTEMPT_LIMIT); // a refused guess is not recorded either
  });

  it('holds exactly at ten one after another, and the lockout page says so with 429 and no field at fault', async () => {
    await ravi();
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) {
      const res = await login('ravi', `guess-${i}`);
      expect(res.status, `guess ${i}`).toBe(200);
      expect(res.text).toContain(WRONG);
    }
    const locked = await login('ravi', 'guess-10');
    expect(locked.status).toBe(429);
    expect(locked.text).toContain(TOO_MANY);
    expect(locked.text).not.toContain('aria-invalid'); // nothing typed is wrong: it is about waiting
    expect(await attempts()).toHaveLength(LOGIN_ATTEMPT_LIMIT);
  });

  it('refuses the right password too while the address is locked out', async () => {
    await createUser(env.DB, { username: 'asha', passwordHash: await hashPassword('correct horse'), role: 'admin', mustChangePassword: false });
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) await login('asha', `guess-${i}`, '203.0.113.1');
    const locked = await login('asha', 'correct horse', '203.0.113.1');
    expect(locked.status).toBe(429);
    expect(locked.location).toBeNull();
    // and nobody else from that address signs in until the failures age out
    await createUser(env.DB, { username: 'dev', passwordHash: await hashPassword('correct horse'), role: 'member', mustChangePassword: false });
    expect((await login('dev', 'correct horse', '203.0.113.1')).status).toBe(429);
    // the failures aged out: the same password signs in
    await env.DB.prepare("UPDATE login_attempts SET attempted_at = datetime('now', '-11 minutes')").run();
    expect((await login('asha', 'correct horse', '203.0.113.1')).status).toBe(302);
  });

  it('counts an account’s failures from every address together, and one address’s failures against the accounts it named', async () => {
    await createUser(env.DB, { username: 'asha', passwordHash: await hashPassword('correct horse'), role: 'admin', mustChangePassword: false });
    await createUser(env.DB, { username: 'dev', passwordHash: await hashPassword('correct horse'), role: 'member', mustChangePassword: false });
    // guesses at asha spread over ten addresses: no address reaches ten, the account does
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) expect((await login('asha', `guess-${i}`, `198.51.100.${i}`)).status).toBe(200);
    const fromElsewhere = await login('asha', 'correct horse', '198.51.100.200');
    expect(fromElsewhere.status).toBe(429);
    expect(fromElsewhere.text).toContain(TOO_MANY);
    // another account is untouched, from any of those addresses
    const dev = await login('dev', 'correct horse', '198.51.100.3');
    expect(dev.status).toBe(302);
    expect(dev.location).toBe('/');
    expect(await attempts('username = ?1', 'asha')).toHaveLength(LOGIN_ATTEMPT_LIMIT);
  });

  it('takes back the row of a password that was right, so logging in counts towards nobody’s ten', async () => {
    await createUser(env.DB, { username: 'asha', passwordHash: await hashPassword('correct horse'), role: 'admin', mustChangePassword: false });
    for (let i = 0; i < 12; i++) expect((await login('asha', 'correct horse', '203.0.113.7')).status, `login ${i}`).toBe(302);
    expect(await attempts()).toEqual([]);
    expect((await login('asha', 'wrong', '203.0.113.7')).status).toBe(200);
    expect(await attempts()).toEqual([{ ip: '203.0.113.7', username: 'asha' }]);
  });

  it('answers an unknown username as it answers a wrong password: the same page, the same row, the same work', async () => {
    await createUser(env.DB, { username: 'asha', passwordHash: await hashPassword('correct horse'), role: 'admin', mustChangePassword: false });
    const known = await login('asha', 'wrong-password', '203.0.113.1');
    const unknown = await login('nobody-here', 'wrong-password', '203.0.113.2');
    expect(unknown.status).toBe(known.status);
    expect(unknown.text).toBe(known.text);
    expect(await attempts()).toEqual([
      { ip: '203.0.113.1', username: 'asha' },
      { ip: '203.0.113.2', username: 'nobody-here' },
    ]);
    // the stand-in hash an unknown name is checked against costs what a real one does: pbkdf2, 100k iterations
    expect(DUMMY_HASH.startsWith('pbkdf2$100000$')).toBe(true);
    // and ten guesses at a name nobody has lock that name out like any other, with no word on whether it exists
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT - 1; i++) await login('nobody-here', `guess-${i}`, `198.51.100.${i}`);
    const locked = await login('nobody-here', 'guess-x', '198.51.100.50');
    expect(locked.status).toBe(429);
  });
});

describe('the current-password check under Account', () => {
  const change = (who: Awaited<ReturnType<typeof member>>, current: string, ip = '203.0.113.9') =>
    as(who, '/account/password', { body: { current, next: 'new password 1', confirm: 'new password 1' }, ip });

  it('counts against the same limit, by address and by account, and refuses past it with 429', async () => {
    const ravi = await member('ravi');
    await env.DB.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(await hashPassword('correct horse'), ravi.id).run();
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) {
      const res = await change(ravi, `guess-${i}`);
      expect(res.status, `guess ${i}`).toBe(200);
      expect(await res.text()).toContain('Current password is wrong.');
    }
    expect(await attempts()).toHaveLength(LOGIN_ATTEMPT_LIMIT);
    // the eleventh guess — right or wrong — is refused before it is checked
    const locked = await change(ravi, 'correct horse');
    expect(locked.status).toBe(429);
    const body = await locked.text();
    expect(body).toContain(TOO_MANY);
    expect(body).toContain('role="alert"');
    expect(body).not.toContain('aria-invalid'); // about waiting, not about what was typed
    expect(locked.headers.get('set-cookie')).toBeNull();
    expect(await rows('SELECT must_change_password AS must FROM users WHERE id = ?1', ravi.id)).toEqual([{ must: 0 }]);
    expect((await rows<{ g: number }>('SELECT session_generation AS g FROM users WHERE id = ?1', ravi.id))[0]!.g).toBe(0); // nothing changed, nobody signed out
    // the account is locked out of login too, from anywhere: the guesses were at its password
    expect((await login('ravi', 'correct horse', '198.51.100.1')).status).toBe(429);
    // aged out, the right password changes it, and the row that was right is taken back
    await env.DB.prepare("UPDATE login_attempts SET attempted_at = datetime('now', '-11 minutes')").run();
    expect((await change(ravi, 'correct horse')).status).toBe(302);
    expect(await attempts("attempted_at > datetime('now', '-10 minutes')")).toEqual([]);
  });

  it('shares the address’s count with login', async () => {
    const ravi = await member('ravi');
    await env.DB.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(await hashPassword('correct horse'), ravi.id).run();
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) await login('someone', `guess-${i}`, '203.0.113.5');
    expect((await change(ravi, 'whatever', '203.0.113.5')).status).toBe(429);
    expect((await change(ravi, 'whatever', '203.0.113.6')).status).toBe(200); // another address: checked, and wrong
  });
});
