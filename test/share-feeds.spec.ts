// Atom and RSS for share links (ARCH.md §16 #86): a link's newest additions as a feed — the page's whitelist in
// another shape, dated by the addition and never by a read; a gift list's newest wants; cached with the page and
// gone with the token.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addPastRead, createItem, createLibrary, createShare, setItemTags, setWant } from '../src/db/queries';
import type { NewItem } from '../src/db/schema';
import { atomFeed, entryHtml, rfc3339, rfc822, rssFeed, xmlEscape } from '../src/lib/feeds';
import { newShareToken } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import { as, member } from './member-helpers';

const ORIGIN = 'http://nalanda.test';

async function shelf() {
  const lib = await createLibrary(env.DB, 'Books');
  const item = (values: Partial<NewItem>) => createItem(env.DB, { libraryId: lib.id, mediaType: 'book', details: '{}', title: 'x', ...values });
  return { lib, item };
}
const added = (id: number, at: string) => env.DB.prepare('UPDATE items SET added_at = ?1 WHERE id = ?2').bind(at, id).run();
const get = async (path: string) => {
  const res = await as(null, path);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text(), cache: res.headers.get('x-cache') };
};

describe('the XML', () => {
  it('escapes every character that could break it, and writes the dates both ways', () => {
    expect(xmlEscape(`Tom & Jerry's <"Book">`)).toBe('Tom &amp; Jerry&#39;s &lt;&quot;Book&quot;&gt;');
    expect(rfc3339('2026-10-01 11:28:05')).toBe('2026-10-01T00:00:00Z'); // the day: a feed never says the time of day
    expect(rfc3339('2026-10-01 11:28:05', true)).toBe('2026-10-01T11:28:05Z');
    expect(rfc3339('2026-10-01')).toBe('2026-10-01T00:00:00Z');
    expect(rfc3339('nonsense')).toBe('1970-01-01T00:00:00Z');
    expect(rfc822('2026-10-01 11:28:05')).toBe('Thu, 01 Oct 2026 11:28:05 GMT'); // RSS keeps what it is given; the route gives days
    // what XML 1.0 forbids even escaped is taken out, so one pasted control character can't break the whole feed
    expect(xmlEscape('a\u000bb\u0000c\u001fd\te\nf\uFFFEg' + '\uD800' + 'h')).toBe('abcd\te\nfgh');
    const html = entryHtml({ image: 'http://x/covers/k', title: 'A <Title>', creators: 'Someone & Co', rating: 8, review: 'Good <3' });
    expect(html).toBe('<p><img src="http://x/covers/k" alt="Cover of A &lt;Title&gt;"></p><p>Someone &amp; Co</p><p>Rated 8/10</p><p>Good &lt;3</p>');
    const meta = { title: 'T & T', link: 'http://x/share/t', self: 'http://x/share/t/feed.atom', updated: '2026-10-01T11:28:05Z', description: 'd' };
    const entry = { id: 'http://x/share/t/items/1', title: 'E <1>', link: 'http://x/share/t/items/1', updated: '2026-10-01T11:28:05Z', summary: 's', html: '<p>h</p>', image: null };
    const atom = atomFeed(meta, [entry]);
    expect(atom).toContain('<title>T &amp; T</title>');
    expect(atom).toContain('<content type="html">&lt;p&gt;h&lt;/p&gt;</content>');
    expect(atom).toContain('<link rel="self" type="application/atom+xml" href="http://x/share/t/feed.atom"/>');
    const rss = rssFeed(meta, [entry]);
    expect(rss).toContain('<guid isPermaLink="true">http://x/share/t/items/1</guid>');
    expect(rss).toContain('<pubDate>Thu, 01 Oct 2026 11:28:05 GMT</pubDate>');
    expect(rss).toContain('<description>&lt;p&gt;h&lt;/p&gt;</description>');
  });
});

describe('a share link’s feed', () => {
  it('lists the newest additions among the link’s items, as the page shows them, and nothing the page would not', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const newest = await item({ title: 'Newest & <best>', creators: 'Ursula K. Le Guin', coverKey: 'cover-key-1', rating: 9, review: 'A marvel', notes: 'private note', location: 'loft shelf', copies: 2, status: 'completed', completedOn: '2026-09-30' });
    const older = await item({ title: 'Older', creators: 'Someone' });
    const unread = await item({ title: 'Unread, filtered out', status: 'not_started' });
    const elsewhere = await createItem(env.DB, { libraryId: (await createLibrary(env.DB, 'Games')).id, mediaType: 'boardgame', details: '{}', title: 'On another shelf' });
    await added(newest.id, '2026-09-28 10:00:00');
    await added(older.id, '2026-09-01 10:00:00');
    await added(unread.id, '2026-09-29 10:00:00');
    await added(elsewhere.id, '2026-09-30 12:00:00');
    await addPastRead(env.DB, newest.id, { status: 'completed', beganOn: null, endedOn: '2026-09-30' }, ravi.id);
    await setItemTags(env.DB, newest.id, ['secret-tag']);
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Done & shared', libraryId: lib.id, status: 'completed' });
    const atom = await get(`/share/${token}/feed.atom`);
    expect(atom.status).toBe(200);
    expect(atom.type).toBe('application/atom+xml; charset=utf-8');
    expect(atom.body).toContain('<title>Done &amp; shared</title>');
    expect(atom.body).toContain(`<link href="${ORIGIN}/share/${token}"/>`);
    expect(atom.body).toContain('<title>Newest &amp; &lt;best&gt;</title>');
    expect(atom.body).toContain(`<id>${ORIGIN}/share/${token}/items/${newest.id}</id>`);
    expect(atom.body).toContain('<updated>2026-09-28T00:00:00Z</updated>'); // the day it was added — never the time, never when it was read
    expect(atom.body).not.toContain('T10:00:00Z');
    expect(atom.body).toContain('<summary>Ursula K. Le Guin · Rated 9/10</summary>');
    expect(atom.body).toContain(xmlEscape(`<p><img src="${ORIGIN}/covers/cover-key-1" alt="Cover of Newest &amp; &lt;best&gt;"></p>`));
    expect(atom.body).toContain(xmlEscape('<p>A marvel</p>'));
    // only the link's items: the unread one and the other shelf's are out, and the filtered view holds
    expect(atom.body).not.toContain('Unread, filtered out');
    expect(atom.body).not.toContain('On another shelf');
    // nothing private, and no reading
    for (const secret of ['private note', 'loft shelf', 'secret-tag', 'ravi', 'copies', 'completedOn', '2026-09-30', 'Finished', 'read']) expect(atom.body).not.toContain(secret);
    const rss = await get(`/share/${token}/feed.rss`);
    expect(rss.type).toBe('application/rss+xml; charset=utf-8');
    expect(rss.body).toContain('<pubDate>Mon, 28 Sep 2026 00:00:00 GMT</pubDate>');
    expect(rss.body).toContain(`<guid isPermaLink="true">${ORIGIN}/share/${token}/items/${newest.id}</guid>`);
    // the page points a reader at both
    const page = (await get(`/share/${token}`)).body;
    expect(page).toContain(`<link rel="alternate" type="application/atom+xml" title="Done &amp; shared — Atom" href="/share/${token}/feed.atom"/>`);
    expect(page).toContain(`href="/share/${token}/feed.rss"`);
  });

  it('carries twenty at most, newest first', async () => {
    const { lib, item } = await shelf();
    for (let i = 0; i < 25; i++) {
      const it = await item({ title: `Book ${String(i).padStart(2, '0')}` });
      await added(it.id, `2026-09-${String(1 + (i % 28)).padStart(2, '0')} 10:00:00`);
    }
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Many', libraryId: lib.id });
    const body = (await get(`/share/${token}/feed.atom`)).body;
    expect(body.match(/<entry>/g)).toHaveLength(20);
    expect(body.indexOf('Book 24')).toBeLessThan(body.indexOf('Book 23')); // the 25th, added on the 25th, first
    expect(body).not.toContain('Book 00'); // the oldest five are out
  });

  it('is a gift list’s newest wants, dated by the want, and goes with the token', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const wanted = await item({ title: 'Wanted first', copies: 0 });
    const wantedLater = await item({ title: 'Wanted later', copies: 0 });
    await item({ title: 'Not wanted', copies: 0 });
    await setWant(env.DB, wanted.id, ravi.id, true);
    await setWant(env.DB, wantedLater.id, ravi.id, true);
    await env.DB.prepare("UPDATE wants SET created_at = '2026-09-01 09:00:00' WHERE item_id = ?1").bind(wanted.id).run();
    await env.DB.prepare("UPDATE wants SET created_at = '2026-09-20 09:00:00' WHERE item_id = ?1").bind(wantedLater.id).run();
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Want list', libraryId: null, wantUserId: ravi.id, sort: 'title' });
    const body = (await get(`/share/${token}/feed.atom`)).body;
    expect(body).toContain('<title>A want list</title>'); // names off: never a username
    expect(body).not.toContain('ravi');
    // every entry dated by the day of the newest want: the list's last change, never when each was wanted
    expect(body.match(/<updated>2026-09-20T00:00:00Z<\/updated>/g)).toHaveLength(3); // the feed's, and both entries'
    expect(body).not.toContain('2026-09-01');
    expect(body.indexOf('Wanted later')).toBeLessThan(body.indexOf('Wanted first'));
    expect(body).not.toContain('Not wanted');
    expect(body).toContain('A want list shared from a Nalanda home library');
    // an unknown token is nothing; the second read is the cache's
    expect((await get(`/share/${newShareToken()}/feed.atom`)).status).toBe(404);
    expect((await get(`/share/${token}/feed.rss`)).cache).toBe('miss');
    expect((await get(`/share/${token}/feed.rss`)).cache).toBe('hit');
    clearSharePageCache();
    expect((await get(`/share/${token}/feed.rss`)).cache).toBe('miss');
  });

  it('tells search engines not to index it, in a header — a feed has no <head> for the page’s meta tag', async () => {
    const { lib, item } = await shelf();
    const book = await item({ title: 'Public book' });
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Our shelf', libraryId: lib.id });
    for (const path of [`/share/${token}/feed.atom`, `/share/${token}/feed.rss`, `/share/${token}`, `/share/${token}/items/${book.id}`]) {
      const res = await as(null, path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex');
      expect(res.headers.get('x-cache'), path).toBe('miss');
      // the cache hands the header back with the page
      expect((await as(null, path)).headers.get('x-robots-tag'), path).toBe('noindex');
    }
    expect(await (await as(null, `/share/${token}`)).text()).toContain('<meta name="robots" content="noindex"/>'); // and the page keeps its own
  });
});
