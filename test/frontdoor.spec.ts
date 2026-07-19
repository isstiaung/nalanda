// Route-level: the HOME_SHARE_TOKEN front door — anonymous "/" redirects to the
// configured share; signed-in users keep the dashboard; stale tokens degrade to /login.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, createShare, createUser } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import { newShareToken } from '../src/lib/share';
import app from '../src/index';

async function getRoot(bindings: Bindings, cookie?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request('http://nalanda.test/', { headers: cookie ? { cookie } : {} }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedUser() {
  return createUser(env.DB, {
    username: `u-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: 'pbkdf2$100000$x$y',
    role: 'admin',
    mustChangePassword: false,
  });
}

describe('front door (HOME_SHARE_TOKEN)', () => {
  it('redirects anonymous "/" to the configured share', async () => {
    await seedUser();
    const lib = await createLibrary(env.DB, 'Front shelf');
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Our library', libraryId: lib.id });

    const res = await getRoot({ ...env, HOME_SHARE_TOKEN: share.token });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/share/${share.token}`);
  });

  it('without the secret, anonymous "/" still goes to /login', async () => {
    await seedUser();
    const res = await getRoot(env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('a stale token (rotated/deleted share) falls back to /login instead of a dead share page', async () => {
    await seedUser();
    const res = await getRoot({ ...env, HOME_SHARE_TOKEN: newShareToken() });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('signed-in users keep their dashboard', async () => {
    const user = await seedUser();
    const lib = await createLibrary(env.DB, 'Front shelf');
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Our library', libraryId: lib.id });
    const session = await createSessionToken(env.SESSION_SECRET, user.id, Math.floor(Date.now() / 1000));

    const res = await getRoot({ ...env, HOME_SHARE_TOKEN: share.token }, `${SESSION_COOKIE}=${session}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Overview');
  });
});
