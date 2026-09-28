// BoardGameGeek went registration-only in 2025: every XML API2 request needs an application's bearer token,
// and without one it answers 401 to everything. That took board-game search down silently — this pins the
// token, the host, the notices, and the cheap id scan.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/env';
import { searchByName } from '../src/metadata';
import { bgg, firstIds } from '../src/metadata/bgg';

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

  it('takes the first ids from a huge search result without parsing all of it', () => {
    const big = `<items total="5000">${Array.from({ length: 5000 }, (_, i) => `<item type="boardgame" id="${i + 1}"><name type="primary" value="Game ${i}"/></item>`).join('')}</items>`;
    expect(firstIds(big, 8)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(firstIds('<items total="0"></items>', 8)).toEqual([]);
  });

  it("reads a 403 from BGG's edge as BGG not answering, not as a bad token", async () => {
    stubBgg(() => new Response('<html>challenge</html>', { status: 403 }));
    const result = await searchByName(env('fine-token'), 'Catan', 'boardgame');

    expect(result.notices.join(' ')).toContain('did not answer');
    expect(result.notices.join(' ')).not.toContain('rejected the BGG_TOKEN');
  });
});
