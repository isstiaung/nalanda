// BoardGameGeek went registration-only in 2025: every XML API2 request needs an application's bearer token,
// and without one it answers 401 to everything. That took board-game search down silently — this pins the
// token, the host and the notices; the ranking of its search is test/add-search.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/env';
import { searchByName } from '../src/metadata';
import { bgg } from '../src/metadata/bgg';
import { activateFetchMock, assertNoPendingInterceptors, intercept } from './fetch-mock';

type Seen = { url: string; auth: string | null };

function stubBgg(reply: (url: string) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    return reply(url);
  });
  return seen;
}

const xml = (body: string) => new Response(body, { headers: { 'content-type': 'text/xml' } });
const SEARCH = '<items total="2"><item type="boardgame" id="13"><name type="primary" value="Catan"/></item><item type="boardgame" id="278"><name type="primary" value="Catan: Cities"/></item></items>';
const THING = '<items><item type="boardgame" id="13"><name type="primary" value="Catan"/><yearpublished value="1995"/><link type="boardgamedesigner" value="Klaus Teuber"/><image>https://cf.geekdo-images.com/catan.jpg</image></item></items>';
const env = (token?: string) => ({ BGG_TOKEN: token }) as unknown as Bindings;

afterEach(() => vi.unstubAllGlobals());

describe('BoardGameGeek', () => {
  it('sends the token as a bearer header, to the documented host', async () => {
    const seen = stubBgg((url) => (url.includes('/search') ? xml(SEARCH) : xml(THING)));
    const found = await bgg('tok-123').search('Catan');

    expect(found.map((c) => [c.title, c.creators, c.published])).toEqual([['Catan', 'Klaus Teuber', '1995']]);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.auth).toBe('Bearer tok-123');
      expect(s.url.startsWith('https://boardgamegeek.com/xmlapi2/')).toBe(true); // never www.
    }
    expect(seen[1]!.url).toContain('id=13,278');
  });

  it('asks for a token instead of calling BGG when none is set', async () => {
    const seen = stubBgg(() => xml(SEARCH));
    const result = await searchByName(env(undefined), 'Catan', 'boardgame');

    expect(seen).toHaveLength(0);
    expect(result.candidates).toEqual([]);
    expect(result.notices.join(' ')).toContain('BGG_TOKEN');
  });

  it('says the token was refused, rather than suggesting a retry, on a 401', async () => {
    stubBgg(() => new Response('Unauthorized. See https://boardgamegeek.com/using_the_xml_api', { status: 401 }));
    const result = await searchByName(env('revoked'), 'Catan', 'boardgame');

    expect(result.notices.join(' ')).toContain('rejected the BGG_TOKEN');
    expect(result.notices.join(' ')).not.toContain('throttles');
  });

  it("keeps BGG's description whole — its terms forbid modifying the data", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of the rules and the story of the game.`).join('&#10;&#10;');
    const thing = THING.replace('<yearpublished', `<description>${long}</description><yearpublished`);
    stubBgg((url) => (url.includes('/search') ? xml(SEARCH) : xml(thing)));

    const [catan] = await bgg('tok-123').search('Catan');

    const expected = long.replace(/&#10;/g, '\n');
    expect(expected.length).toBeGreaterThan(3000);
    expect(catan!.description).toBe(expected); // every paragraph, blank lines kept
  });

  it("shows BGG's character references as the characters they stand for", async () => {
    // BGG's XML escapes its descriptions once more than needed: after parsing, the text still says &#039; and &mdash;
    const raw = 'Settlers&amp;#039; island &amp;mdash; 3&amp;ndash;4 players.  &amp;#10;&amp;#10;Trade &amp;amp; build &amp;#x2764; &amp;unknown; &amp;#0;';
    const thing = THING.replace('<yearpublished', `<description>${raw}</description><yearpublished`);
    stubBgg((url) => (url.includes('/search') ? xml(SEARCH) : xml(thing)));

    const [catan] = await bgg('tok-123').search('Catan');

    expect(catan!.description).toBe("Settlers' island — 3–4 players.\n\nTrade & build ❤ &unknown; &#0;");
  });

  it("reads a 403 from BGG's edge as BGG not answering, not as a bad token", async () => {
    stubBgg(() => new Response('<html>challenge</html>', { status: 403 }));
    const result = await searchByName(env('fine-token'), 'Catan', 'boardgame');

    expect(result.notices.join(' ')).toContain('did not answer');
    expect(result.notices.join(' ')).not.toContain('rejected the BGG_TOKEN');
  });
});

// BGG's API docs: "if you send requests too frequently, the server will give you 500 or 503 return codes"; its edge
// answers 429 for the same, and 202 means "queued — ask again". Each used to come back as an empty list, so a
// throttled search told the household the game wasn't on BoardGameGeek at all.
describe('BoardGameGeek, busy', () => {
  const BGG = 'https://boardgamegeek.com';
  const search = (p: string) => p.startsWith('/xmlapi2/search?');
  const thing = (p: string) => p.startsWith('/xmlapi2/thing?');

  beforeEach(() => activateFetchMock());
  afterEach(() => assertNoPendingInterceptors());

  for (const status of [202, 429, 500, 503]) {
    it(`says BGG is busy, not that nothing matched, when the search answers ${status}`, async () => {
      intercept(BGG, search, { status, body: status === 202 ? '<message>Your request has been accepted</message>' : '' });
      const result = await searchByName(env('tok'), 'Catan', 'boardgame');

      expect(result.candidates).toEqual([]);
      expect(result.notices.join(' ')).toContain('BoardGameGeek is busy');
      expect(result.notices.join(' ')).not.toContain('No board games found');
    });
  }

  it('says BGG is busy when the search answers but the game details are throttled', async () => {
    intercept(BGG, search, { body: SEARCH });
    intercept(BGG, thing, { status: 429 });
    const result = await searchByName(env('tok'), 'Catan', 'boardgame');

    expect(result.candidates).toEqual([]);
    expect(result.notices.join(' ')).toContain('BoardGameGeek is busy');
  });

  it('still says nothing was found when BGG answers with no games — and never asks for their details', async () => {
    intercept(BGG, search, { body: '<items total="0" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse"></items>' });
    const result = await searchByName(env('tok'), 'Zzyzx the unplayable', 'boardgame');

    expect(result.candidates).toEqual([]);
    expect(result.notices).toEqual(['No board games found on BoardGameGeek.']);
  });

  it('reads any other failure as BGG not answering, not as an empty result', async () => {
    intercept(BGG, search, { status: 502 });
    const result = await searchByName(env('tok'), 'Catan', 'boardgame');

    expect(result.notices.join(' ')).toContain('did not answer');
    expect(result.notices.join(' ')).not.toContain('No board games found');
  });
});
