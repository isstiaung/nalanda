// Markup behind the visual polish pass: the few places where a CSS fix needed the page to say something
// different — a class, a wrapper, a line of copy. The styling itself is checked by eye (screenshots); these
// pin the markup it depends on, so a later edit can't quietly undo it.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubscription, storeEntries } from '../src/db/federation';
import type { MediaType } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, sessionCookie, setUpA, sqlAgo } from './federation-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An instance with connections on, one active connection, and every outbound request answered 404. */
async function connected() {
  const keys = await makeKeys();
  const a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
  answerOutbound(() => json({}, 404));
  await setUpA();
  const peer = await makePeer('Riverbank library');
  const { id } = await connectPeer(peer);
  return { a, connectionId: id, peer };
}

/** A followed view of theirs with `count` finished entries, a minute apart and newest `startMinutesAgo` ago. */
async function followWithEntries(
  connectionId: number,
  count: number,
  opts: { startMinutesAgo?: number; coverKey?: string | null; mediaType?: MediaType } = {},
) {
  const sub = await createSubscription(env.DB, {
    connectionId,
    viewId: 7,
    viewName: 'Finished this year',
    intervalMinutes: 60,
    retentionDays: 90,
    maxEntries: 500,
  });
  const entries = Array.from({ length: count }, (_, i) => {
    const item = JSON.stringify({
      id: 100 + i,
      mediaType: opts.mediaType ?? 'book',
      title: `Their book ${i}`,
      creators: null,
      published: null,
      coverKey: opts.coverKey ?? null,
      rating: null,
      review: null,
      reviewTruncated: false,
      inCollection: true,
      completedOn: null,
      stamp: (100 + i).toString(16).padStart(16, 'a'),
      progress: null,
    });
    return {
      remoteId: i + 1,
      itemRemoteId: 100 + i,
      itemStamp: (100 + i).toString(16).padStart(16, 'a'),
      kind: 'finished' as const,
      publishedAt: sqlAgo((opts.startMinutesAgo ?? 5) + (count - i)),
      item,
      bytes: item.length,
    };
  });
  await storeEntries(env.DB, sub!.id, entries);
  return sub!;
}

describe('row actions', () => {
  it('draws Purge as a danger action, like Unfollow beside it', async () => {
    const { a, connectionId } = await connected();
    await createSubscription(env.DB, {
      connectionId,
      viewId: 7,
      viewName: 'Finished this year',
      intervalMinutes: 60,
      retentionDays: 90,
      maxEntries: 500,
    });
    const html = await (await a.get(`/connections/${connectionId}/feed`, await sessionCookie('admin'))).text();
    expect(html).toMatch(/<button class="btn-danger" type="submit">\s*Purge/);
    expect(html).toMatch(/<button class="btn-danger" type="submit">\s*Unfollow/);
    // the per-view Save stays a plain secondary button
    expect(html).toMatch(/<button class="btn" type="submit">\s*Save/);
  });

  it('leaves the per-view storage column to wider screens — the page head carries the total', async () => {
    const { a, connectionId } = await connected();
    await createSubscription(env.DB, {
      connectionId,
      viewId: 7,
      viewName: 'Finished this year',
      intervalMinutes: 60,
      retentionDays: 90,
      maxEntries: 500,
    });
    const html = await (await a.get(`/connections/${connectionId}/feed`, await sessionCookie('admin'))).text();
    expect(html).toContain('<th class="hide-sm">Stored</th>');
    expect(html).toContain('<td class="num hide-sm">');
    expect(html).toMatch(/FEED · 0 ENTRIES · [^<]+ STORED/); // the total stays in the head, on every screen
  });
});

describe('connections rhythm', () => {
  it('sets each row’s actions in one flex row, not word-spaced inline forms', async () => {
    const { a } = await connected();
    const html = await (await a.get('/connections', await sessionCookie('admin'))).text();
    expect(html).toMatch(/<td class="actions-cell"><div class="inline-form">(?:(?!<\/td>).)*Disconnect/s);
  });

  it('frames an import-sized burst with its count and date in mono', async () => {
    const { a, connectionId } = await connected();
    await followWithEntries(connectionId, 7);
    const html = await (await a.get('/feed', await sessionCookie('member'))).text();
    expect(html).toMatch(/<details class="feed-burst"><summary><strong>Riverbank library<\/strong> <span class="mono">· 7 books · \d{4}-\d{2}-\d{2}<\/span><\/summary>/);
  });

  it('shows fewer entries than a burst as ordinary cards (negative control)', async () => {
    const { a, connectionId } = await connected();
    await followWithEntries(connectionId, 3);
    const html = await (await a.get('/feed', await sessionCookie('member'))).text();
    expect(html).not.toContain('feed-burst');
    expect(html.match(/<article class="feed-card">/g)).toHaveLength(3);
  });
});

describe('mobile bar', () => {
  it('hangs the wordmark from its headstroke, as the sidebar brand does', async () => {
    const html = await (await instanceA(env).get('/', await sessionCookie('member'))).text();
    const bar = html.slice(html.indexOf('<header class="mobile-bar">'), html.indexOf('</header>'));
    expect(bar).toContain('<div class="mobile-brand"><div class="brand-rule"></div><div class="brand-name">Nalanda</div></div>');
    expect(html.match(/class="brand-rule"/g)).toHaveLength(2); // the sidebar's and the bar's, nowhere else
  });
});
