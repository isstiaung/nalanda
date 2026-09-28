// Markup behind the visual polish pass: the few places where a CSS fix needed the page to say something
// different — a class, a wrapper, a line of copy. The styling itself is checked by eye (screenshots); these
// pin the markup it depends on, so a later edit can't quietly undo it.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubscription, storeEntries } from '../src/db/federation';
import { createItem, createLibrary, createLoan, createShare } from '../src/db/queries';
import type { MediaType } from '../src/db/schema';
import app from '../src/index';
import { CommentForm } from '../src/routes/comments';
import { CandidateCard } from '../src/views/components';
import { newShareToken } from '../src/lib/share';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
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

describe('primary and secondary buttons', () => {
  const plain = instanceA(env);

  it('keeps a form’s own action primary — Lend, Look up, a comment — and row actions secondary', async () => {
    const shelf = await createLibrary(env.DB, 'Books');
    const free = await createItem(env.DB, { libraryId: shelf.id, title: 'On the shelf', copies: 2 });
    await createLoan(env.DB, { itemId: free.id, borrower: 'Meera' });
    const cookie = await sessionCookie('member');
    const item = await (await plain.get(`/items/${free.id}`, cookie)).text();
    expect(item).toContain('<button type="submit">Lend</button>');
    expect(item).toMatch(/<button type="submit" class="btn">\s*Mark returned/);
    expect(await (await plain.get('/add', cookie)).text()).toContain('<button type="submit">Look up</button>');
    expect(String(await CommentForm({ action: '/feed/comments', fields: {}, label: 'Send' }))).toContain(
      '<button type="submit">Send</button>',
    );
    const loans = await (await plain.get('/loans', cookie)).text();
    expect(loans).toMatch(/<button type="submit" class="btn">\s*Mark returned/);
  });

  it('makes each settings form’s one action primary too — Record, Rename, and the Save buttons', async () => {
    const shelf = await createLibrary(env.DB, 'Books');
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'A book', mediaType: 'book', copies: 1 });
    const admin = await sessionCookie('admin');
    expect(await (await plain.get(`/items/${book.id}`, admin)).text()).toContain('<button type="submit">Record</button>');
    const shelfPage = await (await plain.get(`/libraries/${shelf.id}`, admin)).text();
    expect(shelfPage).toContain('<button type="submit">Rename</button>');
    expect(shelfPage).toMatch(/<button type="submit" class="btn">\s*Apply/); // the toolbar's Apply stays secondary
    expect(await (await plain.get('/shares', admin)).text()).toContain('<button type="submit">Save</button>');

    const { a } = await connected();
    const connections = await (await a.get('/connections', await sessionCookie('admin'))).text();
    expect(connections.match(/<button type="submit">Save<\/button>/g)).toHaveLength(2); // library name, progress sharing
  });
});

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

describe('Borrowed on a phone', () => {
  it('sets Withdraw and Remove in the .inline-form row the phone rule stacks, like every other row action', async () => {
    const { a, connectionId } = await connected();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO borrow_requests (activity_id, connection_id, incoming, their_item_id, their_item_stamp, their_view_id, item_title, requester_name, status)
         VALUES ('urn:uuid:ui-polish-1', ?1, 0, 70, 'aaaaaaaaaaaaa070', 7, 'Gilead', 'me', 'pending')`,
      ).bind(connectionId),
      env.DB.prepare(
        `INSERT INTO borrowed_items (connection_id, request_activity_id, their_item_id, title, borrowed_on, returned_on)
         VALUES (?1, 'urn:uuid:ui-polish-2', 71, 'Beloved', '2026-07-01', '2026-07-29')`,
      ).bind(connectionId),
    ]);
    const html = await (await a.get('/borrowed', await sessionCookie('member'))).text();
    expect(html).toMatch(/<td class="actions-cell"><div class="inline-form"><form method="post" action="\/borrow-requests\/\d+\/withdraw"/);
    expect(html).toMatch(/<td class="actions-cell"><div class="inline-form"><form method="post" action="\/borrowed\/\d+\/remove"/);
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

  it('starts the menu button collapsed and names the drawer it controls (app.js keeps aria-expanded in step)', async () => {
    const html = await (await instanceA(env).get('/', await sessionCookie('member'))).text();
    expect(html).toContain(
      '<button type="button" id="nav-toggle" class="btn-quiet" aria-label="Menu" aria-controls="sidebar" aria-expanded="false">',
    );
    expect(html).toContain('<aside class="sidebar" id="sidebar">');
  });
});

describe('404 pages', () => {
  const plain = instanceA(env);

  it('renders inside the app, with status 404, for a signed-in reader', async () => {
    const cookie = await sessionCookie('member');
    for (const path of ['/no-such-page', '/items/999999', '/libraries/999999']) {
      const res = await plain.get(path, cookie);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toContain('text/html');
      const html = await res.text();
      expect(html, path).toContain('<aside class="sidebar"');
      expect(html, path).toContain('<h1>Not found</h1>');
      expect(html, path).toContain('href="/app.css"');
    }
  });

  it('answers a missing file — script, stylesheet, icon — in plain text, not with a page', async () => {
    const cookie = await sessionCookie('member');
    for (const path of ['/vendor/htmx-missing.min.js', '/no-such.css', '/icons/nope.png', '/vendor/fonts/gone.woff2']) {
      const res = await plain.get(path, cookie);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toContain('text/plain');
      expect(await res.text(), path).toBe('Not found');
    }
  });

  it('answers a missing file in plain text for a signed-out visitor too, instead of sending it to log in', async () => {
    // a <script> or <img> on a page a signed-out visitor sees (login, share pages) asks without a session
    for (const path of ['/vendor/htmx-missing.min.js', '/no-such.css', '/icons/nope.png', '/vendor/fonts/gone.woff2', '/gone.webmanifest']) {
      const res = await plain.get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('location'), path).toBeNull();
      expect(await res.text(), path).toBe('Not found');
    }
  });

  it('keeps a page whose path ends like a file — a tag named “node.js” — a page, and /export.csv behind login (negative control)', async () => {
    const shelf = await createLibrary(env.DB, 'Books');
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'Learning Node', copies: 1 });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tags (name) VALUES ('node.js')"),
      env.DB.prepare("INSERT INTO item_tags (item_id, tag_id) SELECT ?1, id FROM tags WHERE name = 'node.js'").bind(book.id),
    ]);
    const signedIn = await plain.get('/tags/node.js', await sessionCookie('member'));
    expect(signedIn.status).toBe(200);
    expect(await signedIn.text()).toContain('Learning Node');
    for (const path of ['/tags/node.js', '/export.csv', '/federation/export.json']) {
      const res = await plain.get(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location'), path).toMatch(/\/(login|setup)$/);
    }
  });

  it('keeps real pages whose path holds a dot — a tag like “vol.2” — as pages (negative control)', async () => {
    const shelf = await createLibrary(env.DB, 'Books');
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'Tagged', copies: 1 });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tags (name) VALUES ('vol.2')"),
      env.DB.prepare("INSERT INTO item_tags (item_id, tag_id) SELECT ?1, id FROM tags WHERE name = 'vol.2'").bind(book.id),
    ]);
    const res = await plain.get('/tags/vol.2', await sessionCookie('member'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Tagged');
  });

  it('still sends a signed-out visitor to log in, not to a page that says what exists (negative control)', async () => {
    const res = await plain.get('/no-such-page');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\/(login|setup)$/);
  });

  it('keeps the plain-text 404 for htmx partials, JSON endpoints and connections’ machine routes', async () => {
    const cookie = await sessionCookie('member');
    const direct = async (path: string, headers: Record<string, string> = {}) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`https://a.example${path}`, { headers: { cookie, ...headers } }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const plainText = async (res: Response) => {
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toBe('Not found');
    };
    await plainText(await direct('/items/999999', { 'hx-request': 'true' }));
    await plainText(await direct('/api/no-such-endpoint'));
    // a machine route on an instance without connections: no session, plain text
    await plainText(await plain.get('/federation/views'));
  });

  it('frames a dead share link like a share page, and says nothing about what it was', async () => {
    const shelf = await createLibrary(env.DB, 'Secret shelf name');
    const other = await createLibrary(env.DB, 'Other shelf');
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Secret view name', libraryId: shelf.id });
    const outside = await createItem(env.DB, { libraryId: other.id, title: 'Secret outside title', copies: 1 });

    const unknown = await plain.get(`/share/${newShareToken()}`);
    const notInView = await plain.get(`/share/${token}/items/${outside.id}`);
    const noItem = await plain.get(`/share/${token}/items/999999`);
    for (const res of [unknown, notInView, noItem]) {
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/html');
    }
    const [a, b, c] = await Promise.all([unknown.text(), notInView.text(), noItem.text()]);
    expect(a).toContain('class="share-shell"');
    expect(a).toContain('This link has been changed or removed.');
    expect(a).toContain('<meta name="robots" content="noindex"/>');
    // one fixed page: an unknown token, an item outside the view and a missing item can't be told apart
    expect(b).toBe(a);
    expect(c).toBe(a);
    for (const secret of ['Secret shelf name', 'Secret view name', 'Secret outside title', 'Other shelf', token]) {
      expect(b).not.toContain(secret);
    }
    expect(b).not.toMatch(/href="\/(?!share\/|app\.css|logo\.svg|covers\.js)/); // no link into the app
  });

  it('does the same D1 work for a missing item as for one outside the view, so timing can’t tell them apart', async () => {
    const shelf = await createLibrary(env.DB, 'Shared');
    const other = await createLibrary(env.DB, 'Private');
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'View', libraryId: shelf.id });
    const inside = await createItem(env.DB, { libraryId: shelf.id, title: 'Inside', copies: 1 });
    const outside = await createItem(env.DB, { libraryId: other.id, title: 'Outside', copies: 1 });
    const calls = async (path: string) => {
      const budget = { left: 1000 };
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`https://a.example${path}`), { ...env, DB: budgeted(env.DB, budget) } as Bindings, ctx);
      await waitOnExecutionContext(ctx);
      return { status: res.status, calls: 1000 - budget.left };
    };
    const missing = await calls(`/share/${token}/items/999999`);
    const notInView = await calls(`/share/${token}/items/${outside.id}`);
    const junkId = await calls(`/share/${token}/items/not-a-number`);
    const found = await calls(`/share/${token}/items/${inside.id}`);
    expect([missing.status, notInView.status, junkId.status, found.status]).toEqual([404, 404, 404, 200]);
    expect(missing.calls).toBe(notInView.calls);
    expect(junkId.calls).toBe(notInView.calls);
    expect(found.calls).toBe(notInView.calls); // a hit does no more than a miss, either
    // an unknown token has no view to protect: it stops after the one lookup
    expect((await calls(`/share/${newShareToken()}/items/${inside.id}`)).calls).toBe(1);
  });

  it('answers share paths no route matches with the share 404, not a login redirect', async () => {
    const shelf = await createLibrary(env.DB, 'Shared');
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Secret view name', libraryId: shelf.id });
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'Secret title', copies: 1 });
    const reference = await (await plain.get(`/share/${newShareToken()}`)).text();
    for (const path of ['/share', '/share/', `/share/${token}/items/${book.id}/extra`, `/share/${token}/nonsense`]) {
      const res = await plain.get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('location'), path).toBeNull();
      const html = await res.text();
      expect(html, path).toContain('class="share-shell"');
      expect(html, path).toBe(reference); // the same fixed page as any other dead link
    }
  });

  it('leaves the admin’s /shares page, which only shares a prefix, behind the session (negative control)', async () => {
    const res = await plain.get('/shares');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\/(login|setup)$/);
  });

  it('serves a live share link as before (negative control)', async () => {
    const shelf = await createLibrary(env.DB, 'Shelf');
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Public view', libraryId: shelf.id });
    const res = await plain.get(`/share/${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>Public view</h1>');
  });
});

describe('an empty shelf', () => {
  const plain = instanceA(env);

  it('says it is empty and offers the ways to fill it, without a toolbar of filters to try', async () => {
    const shelf = await createLibrary(env.DB, 'Films');
    const html = await (await plain.get(`/libraries/${shelf.id}`, await sessionCookie('member'))).text();
    expect(html).toContain(
      'Nothing on this shelf yet — <a href="/add">add items</a> or <a href="/import">import a CSV</a>.',
    );
    expect(html).not.toContain('No items match these filters.');
    expect(html).not.toContain('class="toolbar"');
  });

  it('still blames the filters when a filter is what emptied the list (negative control)', async () => {
    const shelf = await createLibrary(env.DB, 'Books');
    await createItem(env.DB, { libraryId: shelf.id, title: 'Piranesi', copies: 1 });
    const cookie = await sessionCookie('member');
    for (const query of ['q=zzzz', 'type=vinyl', 'status=abandoned', 'owned=0']) {
      const html = await (await plain.get(`/libraries/${shelf.id}?${query}`, cookie)).text();
      expect(html, query).toContain('No items match these filters.');
      expect(html, query).toContain('class="toolbar"');
      expect(html, query).not.toContain('Nothing on this shelf yet');
    }
  });

  it('treats an empty shelf searched by name as filtered, keeping the toolbar to clear it', async () => {
    const shelf = await createLibrary(env.DB, 'Films');
    const html = await (await plain.get(`/libraries/${shelf.id}?q=anything`, await sessionCookie('member'))).text();
    expect(html).toContain('No items match these filters.');
    expect(html).toContain('class="toolbar"');
  });
});

describe('a household that can’t be reached', () => {
  it('says so in a notice, with a sub-line that doesn’t just repeat the name', async () => {
    const { a, connectionId } = await connected();
    vi.unstubAllGlobals();
    answerOutbound(() => json({}, 503)); // their library is down
    const member = await sessionCookie('member');
    const shelf = await (await a.get(`/households/${connectionId}/views/7`, member)).text();
    expect(shelf).toContain('<article class="notice">Couldn’t reach Riverbank library just now.');
    expect(shelf).toContain('RIVERBANK LIBRARY · UNREACHABLE');

    const item = await (await a.get(`/households/${connectionId}/views/7/items/70`, member)).text();
    expect(item).toMatch(/<div class="page-head"><div><h1>Riverbank library<\/h1><span class="sub">UNREACHABLE<\/span>/);
    expect(item).toContain('<article class="notice">Couldn’t reach Riverbank library just now.');
    expect(item).toContain('← back to the shelf');
  });

  it('tells a shelf they stopped sharing apart from one it couldn’t reach (negative control)', async () => {
    const { a, connectionId } = await connected(); // every outbound request answered 404
    vi.unstubAllGlobals();
    answerOutbound((req) => (new URL(req.url).pathname === '/federation/shelf' ? json({ error: 'not shared' }, 404) : json({}, 404)));
    const html = await (await a.get(`/households/${connectionId}/views/7`, await sessionCookie('member'))).text();
    expect(html).toContain('RIVERBANK LIBRARY · NO LONGER SHARED');
    expect(html).not.toContain('UNREACHABLE');
  });

  it('shows a failed pull as its own line under the view name', async () => {
    const { a, connectionId } = await connected();
    const sub = await followWithEntries(connectionId, 0);
    await env.DB.prepare('UPDATE feed_subscriptions SET last_error = ?1, last_pulled_at = datetime(\'now\') WHERE id = ?2')
      .bind('Couldn’t reach them.', sub.id)
      .run();
    const html = await (await a.get(`/connections/${connectionId}/feed`, await sessionCookie('admin'))).text();
    expect(html).toContain('<strong>Finished this year</strong><small class="muted pull-error">Couldn’t reach them.</small>');
    expect(html).toContain('<article class="notice">Couldn’t reach Riverbank library just now.');
  });
});

// Cover images that fail to load swap to the same media-icon box as a missing cover. public/covers.js does the
// swapping in the browser (checked there by eye); these pin what it needs: every cover <img> carries its icon, and
// every page that shows covers loads the script.
// the script itself, as shipped — read at build time, like the inline-handler guard reads src/
const coversJs = Object.values(import.meta.glob('../public/covers.js', { query: '?raw', import: 'default', eager: true }))[0] as string;

describe('broken-cover fallback', () => {
  it('sweeps at start-up only images that were requested and failed, with no inline handler anywhere', () => {
    expect(coversJs).toContain("img.complete && img.naturalWidth === 0 && img.currentSrc");
    expect(coversJs).toMatch(/addEventListener\(\s*'error'[\s\S]*?true/); // capture phase: error doesn't bubble
    expect(coversJs).not.toMatch(/\.onerror\s*=|setAttribute\(\s*['"]onerror/i); // no handler property or attribute
  });

  const plain = instanceA(env);
  const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100'; // a cover key with no object behind it
  const coverImgs = (html: string) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);

  it('marks every cover the app renders — cards, table thumbs, the item page — with its media icon', async () => {
    const shelf = await createLibrary(env.DB, 'Games');
    const game = await createItem(env.DB, { libraryId: shelf.id, title: 'Azul', mediaType: 'boardgame', coverKey: KEY, copies: 1 });
    const cookie = await sessionCookie('member');
    for (const path of [`/libraries/${shelf.id}?view=grid`, `/libraries/${shelf.id}`, `/items/${game.id}`, '/']) {
      const html = await (await plain.get(path, cookie)).text();
      const imgs = coverImgs(html);
      expect(imgs.length, path).toBeGreaterThan(0);
      for (const img of imgs) expect(img, path).toContain('data-fallback="🎲"');
      expect(html, path).toContain('<script src="/covers.js" defer=""></script>');
    }
  });

  it('keeps the plain fallback, and no image, for an item that never had a cover (negative control)', async () => {
    const shelf = await createLibrary(env.DB, 'Books');
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'Coverless', copies: 1 });
    const html = await (await plain.get(`/items/${book.id}`, await sessionCookie('member'))).text();
    expect(coverImgs(html)).toEqual([]);
    expect(html).toContain('<div class="cover-fallback" aria-hidden="true">📖</div>');
  });

  it('marks add-flow results', async () => {
    const html = String(
      await CandidateCard({
        candidate: { mediaType: 'vinyl', title: 'Blue', coverUrl: 'https://covers.example/blue.jpg', details: {}, provider: 'discogs' },
        libraries: [],
      }),
    );
    expect(coverImgs(html)).toEqual([expect.stringContaining('data-fallback="💿"')]);
  });

  it('marks public share pages, and loads the script there too', async () => {
    const shelf = await createLibrary(env.DB, 'Books');
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'Piranesi', coverKey: KEY, copies: 1 });
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Shelf', libraryId: shelf.id });
    for (const path of [`/share/${token}`, `/share/${token}/items/${book.id}`]) {
      const html = await (await plain.get(path)).text();
      expect(coverImgs(html), path).toEqual([expect.stringContaining('data-fallback="📖"')]);
      expect(html, path).toContain('<script src="/covers.js" defer=""></script>');
    }
  });

  it('marks covers from a connection — on the feed and on their shelves', async () => {
    const { a, connectionId, peer } = await connected();
    await followWithEntries(connectionId, 1, { coverKey: KEY, mediaType: 'vinyl' });
    const member = await sessionCookie('member');
    const feed = await (await a.get('/feed', member)).text();
    expect(coverImgs(feed)).toEqual([
      expect.stringMatching(new RegExp(`src="${peer.url}/covers/${KEY}"[^>]*data-fallback="💿"`)),
    ]);

    vi.unstubAllGlobals();
    const stamp = 'aaaaaaaaaaaaa070';
    answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/shelf'
        ? json({
            view: { id: 7, name: 'Their shelf' },
            total: 1,
            page: 1,
            pages: 1,
            items: [{ id: 70, mediaType: 'book', title: 'Theirs', creators: null, published: null, coverKey: KEY, rating: null, inCollection: true, available: true, stamp }],
          })
        : json({}, 404),
    );
    const shelf = await (await a.get(`/households/${connectionId}/views/7`, member)).text();
    expect(coverImgs(shelf)).toEqual([expect.stringMatching(new RegExp(`src="${peer.url}/covers/${KEY}"[^>]*data-fallback="📖"`))]);
  });
});
