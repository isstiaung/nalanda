// BoardGameGeek's XML API terms require the "Powered by BGG" logo, linked back to BoardGameGeek, wherever the app
// shows BGG's data publicly (ARCH.md §16 #44). These pin where it appears — the add flow's BGG results, a board
// game's page, and the public share pages that show one — where it doesn't, and that the public copy of it adds
// nothing to a share page but the logo and its link.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createItem, createLibrary, createShare } from '../src/db/queries';
import type { MediaType } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { newShareToken } from '../src/lib/share';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { instanceA, sessionCookie } from './federation-helpers';

const app = instanceA(env);
const LOGO = 'src="/bgg/powered-by-bgg-rgb.svg"';
const DARK_LOGO = 'srcset="/bgg/powered-by-bgg-reversed-rgb.svg" media="(prefers-color-scheme: dark)"';
const LINK = 'href="https://boardgamegeek.com/"';

async function shelfWith(...types: MediaType[]) {
  const shelf = await createLibrary(env.DB, 'Front room');
  const items = [];
  for (const [i, mediaType] of types.entries()) {
    items.push(await createItem(env.DB, { libraryId: shelf.id, title: `Thing ${i}`, mediaType, copies: 1 }));
  }
  const share = await createShare(env.DB, { token: newShareToken(), name: 'Our shelf', libraryId: shelf.id });
  return { shelf, items, token: share.token };
}

describe('Powered by BGG, on share pages', () => {
  it('credits BGG in the footer of a share that lists a board game, in both themes, linked to BoardGameGeek', async () => {
    const { token } = await shelfWith('book', 'boardgame');
    const res = await app.get(`/share/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const footer = html.slice(html.indexOf('<footer class="share-footer">'));
    expect(footer).toContain(LINK);
    expect(footer).toContain(LOGO);
    expect(footer).toContain(DARK_LOGO);
    expect(footer).toContain('alt="Powered by BGG"');
  });

  it('credits BGG on a board game’s own share page, and not on a book’s', async () => {
    const { token, items } = await shelfWith('book', 'boardgame');
    const [book, game] = items;

    const gamePage = await (await app.get(`/share/${token}/items/${game!.id}`)).text();
    expect(gamePage).toContain(LOGO);
    const bookPage = await (await app.get(`/share/${token}/items/${book!.id}`)).text();
    expect(bookPage).not.toContain('/bgg/');
    expect(bookPage).not.toContain('boardgamegeek');
  });

  it('shows no BGG logo on a share with no board games in it', async () => {
    const { token } = await shelfWith('book', 'vinyl');
    const html = await (await app.get(`/share/${token}`)).text();
    expect(html).not.toContain('/bgg/');
    expect(html).not.toContain('boardgamegeek');
  });

  it('adds only the logo and its link: every link on the page stays on the share, or goes to BoardGameGeek', async () => {
    const { token, items } = await shelfWith('boardgame');
    for (const path of [`/share/${token}`, `/share/${token}/items/${items[0]!.id}`]) {
      const html = await (await app.get(path)).text();
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
      const outside = hrefs.filter(
        (h) => !h.startsWith(`/share/${token}`) && h !== '/app.css' && h !== '/logo.svg' && h !== 'https://boardgamegeek.com/',
      );
      expect(outside, path).toEqual([]); // no link into the signed-in app
      // the share's address is its secret: a click through to BGG sends no referrer at all
      expect(html, path).toMatch(/<a href="https:\/\/boardgamegeek\.com\/"[^>]*rel="noreferrer"/);
    }
  });

  it('lets a signed-out visitor’s missing logo file be a plain 404, not a login redirect', async () => {
    // the real files are served before the Worker runs; one that has gone missing must not bounce a share page's
    // <img> to /login
    const res = await app.get('/bgg/powered-by-bgg-gone.svg');
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toBe('Not found');
  });
});

describe('Powered by BGG, in the app', () => {
  it('credits BGG on a board game’s page, and not on a book’s', async () => {
    const cookie = await sessionCookie('member');
    const { items } = await shelfWith('book', 'boardgame');
    const [book, game] = items;

    const gamePage = await (await app.get(`/items/${game!.id}`, cookie)).text();
    expect(gamePage).toContain(LINK);
    expect(gamePage).toContain(LOGO);
    const bookPage = await (await app.get(`/items/${book!.id}`, cookie)).text();
    expect(bookPage).not.toContain('/bgg/');
  });

  describe('beside search results', () => {
    const BGG = 'https://boardgamegeek.com';
    const withToken = instanceA({ ...env, BGG_TOKEN: 'tok' } as Bindings);

    beforeEach(() => activateFetchMock());
    afterEach(() => assertNoPendingInterceptors());

    it('credits BGG under the board games it found', async () => {
      intercept(BGG, (p) => p.startsWith('/xmlapi2/search?'), { body: '<items total="1"><item type="boardgame" id="13"/></items>' });
      intercept(BGG, (p) => p.startsWith('/xmlapi2/thing?'), {
        body: '<items><item type="boardgame" id="13"><name type="primary" value="Catan"/></item></items>',
      });
      const html = await (await withToken.get('/add/results?q=Catan&type=boardgame', await sessionCookie('member'))).text();

      expect(html).toContain('Catan');
      expect(html.indexOf(LOGO)).toBeGreaterThan(html.indexOf('Catan')); // below the results it credits
      expect(html).toContain(LINK);
    });

    it('shows no BGG logo when BGG found nothing, or for a book search', async () => {
      const cookie = await sessionCookie('member');
      intercept(BGG, (p) => p.startsWith('/xmlapi2/search?'), { body: '<items total="0"></items>' });
      const none = await (await withToken.get('/add/results?q=Zzyzx&type=boardgame', cookie)).text();
      expect(none).toContain('No board games found');
      expect(none).not.toContain('/bgg/');

      intercept('https://openlibrary.org', (p) => p.startsWith('/search.json?'), json({ docs: [{ title: 'Catan: the novel', key: '/works/OL1W' }] }));
      const books = await (await withToken.get('/add/results?q=Catan&type=book', cookie)).text();
      expect(books).toContain('Catan: the novel');
      expect(books).not.toContain('/bgg/');
    });
  });
});
