// The sidebar's collapsible sections (ARCH.md §16 #62): three pinned links, then Library, Shelves, Reading, Lending,
// Sharing & connections and Settings, each a native <details>. The section holding the page is open; so are the ones
// this device's `nav` cookie names, and nothing else it says reaches the page. A closed section's header still shows
// what's unread, and the links a member can't use stay out, as before.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSubscription, notify, storeEntries, type NewRemoteActivity } from '../src/db/federation';
import { createLibrary, createUser } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import { navCookieSections, navPath, NAV_SECTIONS } from '../src/views/layout';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, setUpA, sqlAgo } from './federation-helpers';

type Instance = ReturnType<typeof instanceA>;
let fed: Instance; // connections on
const plain = () => instanceA(env); // no federation key

beforeEach(async () => {
  const keys = await makeKeys();
  fed = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
  answerOutbound(() => json({}, 404));
  await setUpA();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function person(role: 'admin' | 'member') {
  const user = await createUser(env.DB, { username: `${role}-${crypto.randomUUID().slice(0, 6)}`, passwordHash: 'pbkdf2$1$x$y', role, mustChangePassword: false });
  return { id: user.id, cookie: `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, user, Math.floor(Date.now() / 1000))}` };
}

const withNav = (cookie: string, nav: string) => `${cookie}; nav=${nav}`;

/** The rendered sidebar, taken apart: its pinned links, each section (id, open, header, links) and its foot. */
async function sidebar(instance: Instance, path: string, cookie: string) {
  const res = await instance.get(path, cookie);
  expect(res.status, path).toBe(200);
  const html = await res.text();
  const aside = html.slice(html.indexOf('<aside class="sidebar" id="sidebar">'), html.indexOf('</aside>') + '</aside>'.length);
  const hrefs = (part: string) => [...part.matchAll(/<a href="([^"]*)" class="nav-link/g)].map((m) => m[1] ?? '');
  const pinned = aside.slice(aside.indexOf('<div class="nav-pinned">'), aside.indexOf('<details'));
  const sections = [...aside.matchAll(/<details class="nav-section" data-nav="([^"]*)"( open="")?>([\s\S]*?)<\/details>/g)].map((m) => {
    const body = m[3] ?? '';
    const summary = body.slice(0, body.indexOf('</summary>') + '</summary>'.length);
    return { id: m[1] ?? '', open: !!m[2], summary, links: hrefs(body), body };
  });
  const foot = aside.slice(aside.indexOf('<div class="sidebar-foot">'));
  return { html, aside, pinned: hrefs(pinned), sections, foot, open: sections.filter((s) => s.open).map((s) => s.id) };
}

// ---------- the groups ----------

describe('sections', () => {
  it('pins Overview, Add items and Search outside every section, and groups the rest by what you are doing', async () => {
    const admin = await person('admin');
    const shelf = await createLibrary(env.DB, 'Books');
    const bar = await sidebar(fed, '/', admin.cookie);

    expect(bar.pinned).toEqual(['/', '/add', '/search']);
    expect(bar.sections.map((s) => [s.id, s.links])).toEqual([
      ['library', ['/tags', '/series', '/creators', '/publishers']],
      ['shelves', [`/libraries/${shelf.id}`]],
      ['reading', ['/wants', '/discover', '/goals', '/year-in-review']],
      ['lending', ['/loans', '/borrowed']],
      ['sharing', ['/shares', '/feed', '/notifications', '/recommendations', '/connections']],
      ['settings', ['/import', '/settings/users', '/trash', '/account']],
    ]);
    for (const s of bar.sections) for (const href of ['/', '/add', '/search']) expect(s.links, s.id).not.toContain(href);
    // each header is the section's eyebrow, named for people
    expect(bar.sections.map((s) => s.summary.match(/<span class="nav-eyebrow">([^<]*)<\/span>/)![1])).toEqual([
      'Library', 'Shelves', 'Reading', 'Lending', 'Sharing &amp; connections', 'Settings',
    ]);
    // the foot keeps who's signed in and Log out; Account moved into Settings
    expect(bar.foot).toContain('action="/auth/logout"');
    expect(bar.foot).not.toContain('href="/account"');
    // one navigation landmark for the lot, rather than one per heading
    expect(bar.aside.match(/<nav /g)).toHaveLength(1);
    expect(bar.aside).toContain('<nav class="nav" aria-label="Main">');
  });

  it('shows each shelf with its count, as before', async () => {
    const admin = await person('admin');
    const shelf = await createLibrary(env.DB, 'Records & more');
    const bar = await sidebar(plain(), '/', admin.cookie);
    const shelves = bar.sections.find((s) => s.id === 'shelves')!;
    expect(shelves.body).toContain(`<a href="/libraries/${shelf.id}" class="nav-link"><span>Records &amp; more</span><span class="nav-count">0</span></a>`);
  });

  it('leaves out a section with nothing in it: no shelves yet, or nothing to share for a member without connections', async () => {
    const member = await person('member');
    const bar = await sidebar(plain(), '/', member.cookie);
    expect(bar.sections.map((s) => s.id)).toEqual(['library', 'reading', 'lending', 'settings']);
  });
});

// ---------- which are open ----------

describe('open sections', () => {
  it("opens only the section holding the current page, and marks the page's link, with no cookie", async () => {
    const admin = await person('admin');
    const shelf = await createLibrary(env.DB, 'Books');
    const cases: [string, string | null, string][] = [
      ['/', null, '/'],
      ['/search', null, '/search'],
      ['/tags', 'library', '/tags'],
      ['/series', 'library', '/series'],
      ['/creators', 'library', '/creators'],
      ['/publishers', 'library', '/publishers'],
      [`/libraries/${shelf.id}`, 'shelves', `/libraries/${shelf.id}`],
      ['/wants', 'reading', '/wants'],
      ['/goals', 'reading', '/goals'],
      ['/loans', 'lending', '/loans'],
      ['/borrowed', 'lending', '/borrowed'],
      ['/shares', 'sharing', '/shares'],
      ['/connections', 'sharing', '/connections'],
      ['/import', 'settings', '/import'],
      ['/settings/users', 'settings', '/settings/users'],
      ['/account', 'settings', '/account'],
    ];
    for (const [path, section, link] of cases) {
      const bar = await sidebar(fed, path, admin.cookie);
      expect(bar.open, path).toEqual(section ? [section] : []);
      expect(bar.aside, path).toContain(`<a href="${link}" class="nav-link active" aria-current="page">`);
      expect(bar.aside.match(/aria-current="page"/g), path).toHaveLength(1);
    }
  });

  it("files a connected household's pages under Lending → Borrowed, and its feed settings under Connections", async () => {
    const admin = await person('admin');
    const peer = await makePeer('The Okafor Household');
    const connectionId = (await connectPeer(peer)).id;
    for (const path of [`/households/${connectionId}`, `/households/${connectionId}/views/1`]) {
      const bar = await sidebar(fed, path, admin.cookie);
      expect(bar.open, path).toEqual(['lending']);
      expect(bar.aside, path).toContain('<a href="/borrowed" class="nav-link active" aria-current="page">');
      expect(bar.aside.match(/aria-current="page"/g), path).toHaveLength(1);
    }
    // the feed settings are reached from Connections, and mark it
    const feed = await sidebar(fed, `/connections/${connectionId}/feed`, admin.cookie);
    expect(feed.open).toEqual(['sharing']);
    expect(feed.aside).toContain('<a href="/connections" class="nav-link active" aria-current="page">');
    expect(feed.aside.match(/aria-current="page"/g)).toHaveLength(1);
    expect(navPath(`/connections/${connectionId}/feed`)).toBe(`/connections/${connectionId}/feed`);
    expect(navPath('/households/7/views/2/items/9')).toBe('/borrowed');
    // only those: Connections itself, a look-alike, and anything else stay as they are
    expect(navPath('/connections')).toBe('/connections');
    expect(navPath('/connections/7/feedx')).toBe('/connections/7/feedx');
    expect(navPath('/householdsx')).toBe('/householdsx');
  });

  it('opens a section for a page beneath its link, but not for a look-alike path', async () => {
    const admin = await person('admin');
    const tagged = await sidebar(plain(), '/tags/fiction', admin.cookie);
    expect(tagged.open).toEqual(['library']);
    expect(tagged.aside).toContain('<a href="/tags" class="nav-link active" aria-current="page">');
    // /tagsfoo is not under /tags: nothing opens, and it 404s inside the app
    const res = await plain().get('/tagsfoo', admin.cookie);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<aside class="sidebar"');
    expect(html).not.toMatch(/<details class="nav-section" data-nav="[a-z]+" open="">/);
  });

  it('also opens the sections a valid nav cookie names, in any order', async () => {
    const admin = await person('admin');
    await createLibrary(env.DB, 'Books');
    expect((await sidebar(fed, '/tags', withNav(admin.cookie, 'settings.reading'))).open).toEqual(['library', 'reading', 'settings']);
    expect((await sidebar(fed, '/', withNav(admin.cookie, 'shelves'))).open).toEqual(['shelves']);
    // naming the current page's section changes nothing, and it can't be closed by leaving it out
    expect((await sidebar(fed, '/loans', withNav(admin.cookie, 'lending'))).open).toEqual(['lending']);
    expect((await sidebar(fed, '/loans', withNav(admin.cookie, 'reading'))).open).toEqual(['reading', 'lending']);
  });

  it('ignores anything else in the cookie, and never writes it into the page', async () => {
    const admin = await person('admin');
    await createLibrary(env.DB, 'Books');
    const bogus = [
      'LIBRARY', // ids are exact
      'library,reading', // not our separator
      '%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      '"><img src=x onerror=alert(1)>',
      `reading.${'x'.repeat(200)}`, // longer than any value of ours
      'constructor.__proto__.toString',
      'nav.sections',
      '%E0%A4%A', // not valid percent-encoding: must not fail the page
      '%',
    ];
    for (const value of bogus) {
      const bar = await sidebar(fed, '/', withNav(admin.cookie, value));
      expect(bar.open, value).toEqual([]);
      expect(bar.html, value).not.toContain('onerror');
      expect(bar.html, value).not.toContain('<script>alert');
      expect(bar.html, value).not.toContain('__proto__');
    }
    // a known id beside junk still counts: the junk is dropped, not the cookie
    expect((await sidebar(fed, '/', withNav(admin.cookie, 'evil.reading.<b>'))).open).toEqual(['reading']);
  });

  it('reads the cookie as a filter over the known ids', () => {
    expect(navCookieSections(undefined)).toEqual([]);
    expect(navCookieSections('')).toEqual([]);
    expect(navCookieSections('settings.library.library')).toEqual(['library', 'settings']);
    expect(navCookieSections(NAV_SECTIONS.join('.'))).toEqual([...NAV_SECTIONS]);
    expect(navCookieSections(`${NAV_SECTIONS.join('.')}.${'a'.repeat(60)}`)).toEqual([]); // past 100 characters
    expect(navCookieSections('reading..lending.')).toEqual(['reading', 'lending']);
  });
});

// ---------- unread ----------

describe('unread on a closed section', () => {
  const entry = (remoteId: number): NewRemoteActivity => {
    const item = JSON.stringify({
      id: remoteId, mediaType: 'book', title: `Book ${remoteId}`, creators: null, published: null, coverKey: null, rating: 8,
      review: null, reviewTruncated: false, inCollection: true, completedOn: null, stamp: '0123456789abcdef', progress: null,
    });
    return { remoteId, itemRemoteId: remoteId, itemStamp: '0123456789abcdef', kind: 'rated', publishedAt: sqlAgo(5), item, bytes: item.length };
  };

  async function unreadFor<T extends { id: number }>(me: T): Promise<T> {
    const peer = await makePeer('Riverbank library');
    const connectionId = (await connectPeer(peer)).id;
    const sub = await createSubscription(env.DB, { connectionId, viewId: 7, viewName: 'Reading', intervalMinutes: 60, retentionDays: 90, maxEntries: 500 });
    await storeEntries(env.DB, sub!.id, [entry(1), entry(2), entry(3)]);
    await notify(env.DB, { kind: 'comment', householdName: peer.name, subject: 'Piranesi', href: '/items/1' });
    await notify(env.DB, { kind: 'comment', householdName: peer.name, subject: 'Kindred', href: '/items/2' });
    return me;
  }

  it("sums the section's unread into its header, and keeps each link's own count and the phone bar's link", async () => {
    const me = await unreadFor(await person('member'));
    const bar = await sidebar(fed, '/', me.cookie);
    const sharing = bar.sections.find((s) => s.id === 'sharing')!;
    expect(sharing.open).toBe(false);
    expect(sharing.summary).toContain('<span class="nav-unread nav-summary-unread">5<span class="sr-only"> unread</span></span>');
    expect(sharing.summary).not.toContain('role="img"'); // jsx-a11y prefer-tag-over-role: the text reads it out instead
    expect(sharing.body).toContain('<span class="nav-unread" aria-label="3 unread">3</span>'); // Feed
    expect(sharing.body).toContain('<span class="nav-unread" aria-label="2 unread">2</span>'); // Notifications
    expect(bar.html).toContain('aria-label="2 unread notifications"'); // the phone's top bar, as before
    // no other header carries one
    for (const s of bar.sections.filter((x) => x.id !== 'sharing')) expect(s.summary, s.id).not.toContain('nav-unread');
  });

  it('caps the header at 99+, and shows nothing when nothing is unread', async () => {
    const me = await person('member');
    const peer = await makePeer('Riverbank library');
    await connectPeer(peer);
    expect((await sidebar(fed, '/', me.cookie)).sections.find((s) => s.id === 'sharing')!.summary).not.toContain('nav-unread');
    for (let i = 0; i < 120; i++) await notify(env.DB, { kind: 'comment', householdName: peer.name, subject: `Book ${i}`, href: '/items/1' });
    const summary = (await sidebar(fed, '/', me.cookie)).sections.find((s) => s.id === 'sharing')!.summary;
    expect(summary).toContain('<span class="nav-unread nav-summary-unread">99+<span class="sr-only"> unread</span></span>');
  });

  it('hides the header total only while the section is open, in CSS, so it follows a toggle with or without script', async () => {
    const css = await (await env.ASSETS.fetch('http://nalanda.test/app.css')).text();
    expect(css).toContain('.nav-section[open] .nav-summary-unread { display: none; }');
    // the only rule that hides it names [open]: a closed section's total is never hidden
    const hiding = [...css.matchAll(/([^{}]*\.nav-summary-unread[^{}]*)\{[^}]*display:\s*none/g)].map((m) => (m[1] ?? '').trim());
    expect(hiding).toEqual(['.nav-section[open] .nav-summary-unread']);
  });
});

// ---------- who sees what ----------

describe('links only some members see', () => {
  it('keeps admin-only and connection-only links gated, as before', async () => {
    const admin = await person('admin');
    const member = await person('member');
    const all = (bar: Awaited<ReturnType<typeof sidebar>>) => bar.sections.flatMap((s) => s.links);

    const plainMember = all(await sidebar(plain(), '/', member.cookie));
    for (const href of ['/shares', '/settings/users', '/feed', '/notifications', '/borrowed', '/recommendations', '/connections']) expect(plainMember, href).not.toContain(href);

    const plainAdmin = all(await sidebar(plain(), '/', admin.cookie));
    expect(plainAdmin).toEqual(expect.arrayContaining(['/shares', '/settings/users']));
    for (const href of ['/feed', '/notifications', '/borrowed', '/recommendations', '/connections']) expect(plainAdmin, href).not.toContain(href);

    const fedMember = all(await sidebar(fed, '/', member.cookie));
    expect(fedMember).toEqual(expect.arrayContaining(['/feed', '/notifications', '/borrowed', '/recommendations']));
    for (const href of ['/shares', '/settings/users', '/connections']) expect(fedMember, href).not.toContain(href);

    const fedAdmin = all(await sidebar(fed, '/', admin.cookie));
    expect(fedAdmin).toEqual(expect.arrayContaining(['/shares', '/settings/users', '/feed', '/notifications', '/borrowed', '/connections']));
  });

  it("doesn't let the cookie open a section the member can't see", async () => {
    const member = await person('member');
    const bar = await sidebar(plain(), '/', withNav(member.cookie, 'sharing.shelves'));
    expect(bar.sections.map((s) => s.id)).not.toContain('sharing');
    expect(bar.sections.map((s) => s.id)).not.toContain('shelves'); // no shelves yet
    expect(bar.html).not.toContain('href="/shares"');
  });
});

// ---------- without script ----------

describe('without JavaScript', () => {
  it('is plain <details>: a <summary> first in each, real links inside, and no script, handler or hidden state', async () => {
    const admin = await person('admin');
    await createLibrary(env.DB, 'Books');
    const bar = await sidebar(fed, '/tags', admin.cookie);
    expect(bar.sections).toHaveLength(6);
    for (const s of bar.sections) {
      expect(s.body.startsWith('<summary class="nav-summary">'), s.id).toBe(true);
      expect(s.body.match(/<summary/g), s.id).toHaveLength(1);
      expect(s.links.length, s.id).toBeGreaterThan(0);
    }
    expect(bar.aside).not.toMatch(/\son[a-z]+=/i);
    expect(bar.aside).not.toContain('<script');
    expect(bar.aside).not.toMatch(/\shidden[\s=>]/);
    expect(bar.aside).not.toContain('aria-expanded'); // <details> reports its own state; nothing to keep in step
  });
});

// ---------- the budget ----------

describe('the D1 budget', () => {
  async function calls(path: string, cookie: string) {
    const keys = await makeKeys();
    const budget = { left: 1000 };
    const counted = instanceA({ ...env, DB: budgeted(env.DB, budget), FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
    const res = await counted.get(path, cookie);
    expect(res.status).toBe(200);
    await res.text();
    return 1000 - budget.left;
  }

  it('costs a page what it did before the sections: the sidebar reads only what the layout already loads', async () => {
    const admin = await person('admin');
    await createLibrary(env.DB, 'Books');
    await unreadForAdmin(admin);
    const before = await calls('/tags', admin.cookie);
    expect(before).toBe(TAGS_PAGE_CALLS);
    expect(await calls('/tags', withNav(admin.cookie, NAV_SECTIONS.join('.')))).toBe(before);
    expect(await calls('/tags', withNav(admin.cookie, 'junk'))).toBe(before);
  });
});

/**
 * Measured with the layout before this change (origin/main at 1.5.0) on this test's household: five calls, the same
 * as now. The sections are drawn from the shelves and unread counts the layout already loads. Four since the shelves
 * and their counts became one statement (§16 #68).
 */
const TAGS_PAGE_CALLS = 4;

async function unreadForAdmin(me: { id: number }) {
  const peer = await makePeer('Riverbank library');
  await connectPeer(peer);
  await notify(env.DB, { kind: 'comment', householdName: peer.name, subject: 'Piranesi', href: '/items/1' });
  return me;
}
