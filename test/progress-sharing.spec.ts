// Whether reading progress reaches a public share page: off by default, on only by an admin's choice,
// and even then only for a book marked in progress. Connections never get it through this path.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Item } from '../src/db/schema';
import {
  addProgress,
  createItem,
  createLibrary,
  createShare,
  createUser,
  getSiteSettings,
  updateSiteSettings,
} from '../src/db/queries';
import { toConnectionItem } from '../src/federation/items';
import { SESSION_COOKIE } from '../src/lib/auth';
import { sessionTokenFor } from './session-helpers';
import { newShareToken, toPublicItem } from '../src/lib/share';
import app from '../src/index';

const reading: Item = {
  id: 1,
  libraryId: 1,
  mediaType: 'book',
  title: 'The Dispossessed',
  creators: 'Ursula K. Le Guin',
  isbn13: null,
  isbn10Upc: null,
  publisher: null,
  published: null,
  description: null,
  length: 387,
  progressPage: 203,
  coverKey: null,
  status: 'in_progress',
  rating: null,
  review: null,
  notes: null,
  location: null,
  copies: 1,
  beganOn: '2026-09-20',
  completedOn: null,
  readCount: 0,
  rereading: false,
  details: '{}',
  addedBy: null,
  addedAt: '2026-09-20 10:00:00',
  updatedAt: '2026-09-28 10:00:00',
  seriesId: null,
  seriesNumber: null,
};

describe('the whitelist', () => {
  it('leaves progress out unless asked', () => {
    expect('progress' in toPublicItem(reading)).toBe(false);
    expect('progress' in toPublicItem(reading, { progress: false })).toBe(false);
  });

  it('includes it for a book in progress when asked', () => {
    expect(toPublicItem(reading, { progress: true }).progress).toEqual({ page: 203, length: 387, percent: 52 });
  });

  it('never for a finished, unstarted, unpaged or non-book item', () => {
    for (const change of [
      { status: 'completed' as const },
      { status: 'not_started' as const },
      { progressPage: null },
      { mediaType: 'vinyl' as const },
    ]) {
      expect('progress' in toPublicItem({ ...reading, ...change }, { progress: true })).toBe(false);
    }
  });

  it('never reaches connections through the item whitelist', () => {
    expect(Object.keys(toConnectionItem(reading)).filter((k) => /progress/i.test(k))).toEqual([]);
  });
});

describe('site settings', () => {
  it('defaults to off with no row, and round-trips', async () => {
    // share pages private, connections included — the answer the household gave when this was designed
    expect(await getSiteSettings(env.DB)).toEqual({ progressOnShares: false, progressToConnections: true, namesOnShares: false, namesToConnections: false });
    await updateSiteSettings(env.DB, { progressOnShares: true });
    expect(await getSiteSettings(env.DB)).toEqual({ progressOnShares: true, progressToConnections: true, namesOnShares: false, namesToConnections: false });
    await updateSiteSettings(env.DB, { progressToConnections: false });
    // updating one setting leaves the other as it was
    expect(await getSiteSettings(env.DB)).toEqual({ progressOnShares: true, progressToConnections: false, namesOnShares: false, namesToConnections: false });
  });
});

async function request(path: string, init: { userId?: number; body?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: 'http://nalanda.test' };
  if (init.userId) {
    const token = await sessionTokenFor(init.userId);
    headers.cookie = `${SESSION_COOKIE}=${token}`;
  }
  if (init.body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, {
      method: init.body ? 'POST' : 'GET',
      headers,
      body: init.body ? new URLSearchParams(init.body).toString() : undefined,
      redirect: 'manual',
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seed() {
  const lib = await createLibrary(env.DB, 'Public shelf');
  const book = await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'The Dispossessed', length: 300, details: '{}' });
  await addProgress(env.DB, book.id, 150, null); // also moves it to in progress
  const share = await createShare(env.DB, { token: newShareToken(), name: 'Our shelf', libraryId: lib.id });
  const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
  const member = await createUser(env.DB, { username: 'kid', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false });
  return { book, share, admin, member };
}

describe('the public item page', () => {
  it('shows no progress by default', async () => {
    const { book, share } = await seed();
    const html = await (await request(`/share/${share.token}/items/${book.id}`)).text();
    expect(html).toContain('The Dispossessed');
    expect(html).not.toContain('p. 150');
    expect(html).not.toContain('progress-track');
  });

  it('shows it once an admin turns it on, and hides it again when turned off', async () => {
    const { book, share, admin } = await seed();

    expect((await request('/shares/settings', { userId: admin.id, body: { progressOnShares: 'on' } })).status).toBe(302);
    const on = await (await request(`/share/${share.token}/items/${book.id}`)).text();
    expect(on).toContain('p. 150');
    expect(on).toContain('50%');

    // an unchecked box submits nothing at all
    await request('/shares/settings', { userId: admin.id, body: {} });
    expect(await (await request(`/share/${share.token}/items/${book.id}`)).text()).not.toContain('p. 150');
  });

  it('is an admin decision', async () => {
    const { member } = await seed();
    const res = await request('/shares/settings', { userId: member.id, body: { progressOnShares: 'on' } });
    expect(res.status).toBe(403);
    expect((await getSiteSettings(env.DB)).progressOnShares).toBe(false);
  });
});
