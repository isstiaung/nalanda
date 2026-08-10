// Route-level: /shares is the "what is public right now" screen. It is admin-only,
// and the item count beside each link has to be the count that link actually exposes.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary, createShare, createUser } from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import { newShareToken } from '../src/lib/share';
import app from '../src/index';

async function seedUser(role: 'admin' | 'member') {
  return createUser(env.DB, {
    username: `u-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: 'pbkdf2$100000$x$y',
    role,
    mustChangePassword: false,
  });
}

async function getShares(userId: number): Promise<Response> {
  const token = await createSessionToken(env.SESSION_SECRET, userId, Math.floor(Date.now() / 1000));
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request('http://nalanda.test/shares', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('/shares', () => {
  it('is admin-only — publishing is not a member power', async () => {
    const member = await seedUser('member');
    expect((await getShares(member.id)).status).toBe(403);

    const admin = await seedUser('admin');
    expect((await getShares(admin.id)).status).toBe(200);
  });

  it('counts what each link exposes, not what its shelf holds', async () => {
    const admin = await seedUser('admin');
    const lib = await createLibrary(env.DB, `Shelf ${crypto.randomUUID().slice(0, 6)}`);
    for (const status of ['completed', 'completed', 'not_started'] as const) {
      await createItem(env.DB, {
        libraryId: lib.id,
        mediaType: 'book',
        title: `T-${crypto.randomUUID().slice(0, 6)}`,
        status,
        addedBy: admin.id,
      });
    }
    const share = await createShare(env.DB, {
      token: newShareToken(),
      name: 'Finished only',
      libraryId: lib.id,
      status: 'completed',
    });

    const html = await (await getShares(admin.id)).text();
    expect(html).toContain('Finished only');
    expect(html).toContain(share.token);
    // two of the three items are completed — the filtered view exposes only those
    const row = html.slice(html.indexOf('Finished only'));
    expect(row).toMatch(/<td class="num">2<\/td>/);
  });
});
