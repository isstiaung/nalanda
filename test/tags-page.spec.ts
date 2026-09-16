// Route-level: a tag page pages through its items. A tag with hundreds of items used to load them all,
// which broke the page — D1 allows 100 bound parameters, and the loan lookup takes one per item.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary, createUser, PAGE_SIZE, setItemTags } from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

async function get(path: string, userId: number): Promise<Response> {
  const token = await createSessionToken(env.SESSION_SECRET, userId, Math.floor(Date.now() / 1000));
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('/tags/:name', () => {
  it('pages through a tag bigger than one page, counting the whole tag', async () => {
    const admin = await createUser(env.DB, { username: `u-${crypto.randomUUID().slice(0, 8)}`, passwordHash: 'pbkdf2$100000$x$y', role: 'admin', mustChangePassword: false });
    const books = await createLibrary(env.DB, `Books ${crypto.randomUUID().slice(0, 6)}`);
    const records = await createLibrary(env.DB, `Records ${crypto.randomUUID().slice(0, 6)}`);
    const total = PAGE_SIZE + 3;
    for (let i = 0; i < total; i++) {
      // padded so the alphabetical order matches the numbering, and the last three land on page 2
      const item = await createItem(env.DB, {
        libraryId: i % 2 ? books.id : records.id,
        mediaType: i % 2 ? 'book' : 'vinyl',
        title: `Tagged ${String(i).padStart(3, '0')}`,
        addedBy: admin.id,
      });
      await setItemTags(env.DB, item.id, ['big-tag']);
    }

    const first = await get('/tags/big-tag', admin.id);
    expect(first.status).toBe(200);
    const page1 = await first.text();
    expect(page1).toContain(`TAG · ${total} ITEMS`); // the count is the tag's, not the page's
    expect(page1).toContain('Tagged 000');
    expect(page1).toContain(`Tagged ${String(PAGE_SIZE - 1).padStart(3, '0')}`);
    expect(page1).not.toContain(`Tagged ${String(PAGE_SIZE).padStart(3, '0')}`);
    expect(page1).toContain('/tags/big-tag?page=2');

    const page2 = await (await get('/tags/big-tag?page=2', admin.id)).text();
    expect(page2).toContain(`Tagged ${String(total - 1).padStart(3, '0')}`);
    expect(page2).not.toContain('Tagged 000');
  });
});
