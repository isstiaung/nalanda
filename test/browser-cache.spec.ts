// What the browser itself may keep (ARCH.md §16 #48 keeps the service worker from keeping anything): every answer
// served behind the session is no-store, so Back or a restored tab on a shared device after a logout shows nothing of
// a signed-in page — notes, locations, borrowers, a minted password — and logout clears the origin's cache. Public
// pages are served before the session middleware and cache as they always did.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, createShare } from '../src/db/queries';
import { newShareToken } from '../src/lib/share';
import { as, book, member } from './member-helpers';

describe('the browser’s cache', () => {
  it('keeps no signed-in answer: pages, partials and the Members page with a minted password are no-store', async () => {
    const admin = await member('admin', 'admin');
    const dee = await member('dee');
    const item = await book(admin, { notes: 'private' });
    for (const path of ['/', `/items/${item.id}`, '/account', '/loans', '/settings/users']) {
      const res = await as(admin, path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
    const partial = await as(admin, `/items/${item.id}`, { htmx: true });
    expect(partial.headers.get('cache-control')).toBe('no-store');
    const minted = await as(admin, `/settings/users/${dee.id}/reset`, { body: {} });
    expect(minted.status).toBe(200);
    expect(await minted.text()).toContain('Temporary password for');
    expect(minted.headers.get('cache-control')).toBe('no-store');
  });

  it('logout clears the origin’s cache along with the cookie', async () => {
    const admin = await member('admin', 'admin');
    const out = await as(admin, '/auth/logout', { body: {} });
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('/login');
    expect(out.headers.get('clear-site-data')).toBe('"cache"');
    expect(out.headers.get('set-cookie')).toMatch(/nalanda_session=;/);
  });

  it('leaves the public pages as they were: a share page is not no-store, and still comes from its cache', async () => {
    await member('admin', 'admin'); // an instance that is set up, so /login is the login page and not a redirect to setup
    const shelf = await createLibrary(env.DB, 'Shelf');
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'View', libraryId: shelf.id });
    const res = await as(null, `/share/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBeNull();
    expect(res.headers.get('x-cache')).toBe('miss');
    const again = await as(null, `/share/${token}`);
    expect(again.headers.get('x-cache')).toBe('hit');
    expect(again.headers.get('cache-control')).toBeNull();
    // the login page is public too
    const login = await as(null, '/login');
    expect(login.status).toBe(200);
    expect(login.headers.get('cache-control')).toBeNull();
  });
});
