// Today is the device's day, not the server's (ARCH.md §16 #69): a `tz` cookie app.js writes names the zone, and
// every date a page offers or a handler fills in — a finish, a play, a page's first read, a loan, a return — is
// today there. No cookie, or a cookie that isn't a zone, is UTC, as before.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary } from '../src/db/queries';
import { todayFor, todayIn, zoneOf } from '../src/lib/dates';
import { todayUtc } from '../src/lib/reads';
import app from '../src/index';
import { book, member, rows, type Member } from './member-helpers';

const ORIGIN = 'http://nalanda.test';

/** A request as `who`, from a device whose `tz` cookie says `zone` (none when undefined). A body makes it a POST. */
async function from(who: Member, zone: string | undefined, path: string, body?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, cookie: zone === undefined ? who.cookie : `${who.cookie}; tz=${zone}` };
  let payload: string | undefined;
  if (body) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: payload === undefined ? 'GET' : 'POST', headers, body: payload, redirect: 'manual' }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// 21:30 UTC on 1 October: already 2 October in Kolkata (+5:30) and Kiritimati (+14), still 1 October in Los Angeles
const AT = Date.parse('2026-10-01T21:30:00Z');

describe('the zone a tz cookie names', () => {
  it('is kept when the runtime knows it, and UTC otherwise', () => {
    expect(zoneOf('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(zoneOf('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(zoneOf('Etc/GMT+5')).toBe('Etc/GMT+5');
    expect(zoneOf('UTC')).toBe('UTC');
    expect(zoneOf(undefined)).toBe('UTC');
    expect(zoneOf('')).toBe('UTC');
    expect(zoneOf('Mars/Olympus_Mons')).toBe('UTC'); // the shape of a zone, but not one
    expect(zoneOf('<script>')).toBe('UTC');
    expect(zoneOf('Asia/Kolkata; Path=/')).toBe('UTC');
    expect(zoneOf('A'.repeat(200))).toBe('UTC');
  });

  it('gives the calendar day in that zone', () => {
    expect(todayIn('UTC', AT)).toBe('2026-10-01');
    expect(todayIn('Asia/Kolkata', AT)).toBe('2026-10-02');
    expect(todayIn('Pacific/Kiritimati', AT)).toBe('2026-10-02');
    expect(todayIn('America/Los_Angeles', AT)).toBe('2026-10-01');
    expect(todayIn('Pacific/Pago_Pago', AT)).toBe('2026-10-01'); // -11: 10:30 the same morning
    expect(todayIn('Asia/Kolkata', Date.parse('2026-12-31T19:00:00Z'))).toBe('2027-01-01'); // a year turns there first
    expect(todayFor(undefined)).toBe(todayUtc());
    expect(todayFor('Mars/Olympus_Mons')).toBe(todayUtc());
  });
});

describe('a page offers the device’s today', () => {
  it('on the Finish and Played forms, and the item page’s overdue check', async () => {
    const asha = await member('asha');
    const item = await book(asha);
    await from(asha, 'Asia/Kolkata', `/items/${item.id}/reads/start`, { date: '2026-01-01' });
    const kolkata = todayIn('Asia/Kolkata');
    const utc = todayUtc();
    const page = await (await from(asha, 'Asia/Kolkata', `/items/${item.id}`)).text();
    expect(page).toContain(`name="date" value="${kolkata}"`);
    // the same page from a device with no zone, or a zone that isn't one, offers the server's UTC day
    expect(await (await from(asha, undefined, `/items/${item.id}`)).text()).toContain(`name="date" value="${utc}"`);
    expect(await (await from(asha, 'Mars/Olympus_Mons', `/items/${item.id}`)).text()).toContain(`name="date" value="${utc}"`);

    const lib = await createLibrary(env.DB, 'Games');
    const game = await createItem(env.DB, { libraryId: lib.id, mediaType: 'boardgame', title: 'Azul', details: '{}', addedBy: asha.id });
    const gamePage = await (await from(asha, 'Pacific/Kiritimati', `/items/${game.id}`)).text();
    expect(gamePage).toContain(`name="date" value="${todayIn('Pacific/Kiritimati')}"`);
  });
});

describe('a handler fills in the device’s today', () => {
  // The zone is chosen so its day differs from UTC's right now, whichever side of midnight the test runs on: Kiritimati
  // (UTC+14) is on the next day from 10:00 UTC, Pago Pago (UTC−11) on the previous day until 11:00 UTC — so the cutoff
  // is 10, not noon, or an 11 o'clock run finds both zones on UTC's day. The test then proves the recorded date is that day.
  const zoneApart = () => (new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago');

  it('for a play logged without a date', async () => {
    const asha = await member('asha');
    const lib = await createLibrary(env.DB, 'Games');
    const game = await createItem(env.DB, { libraryId: lib.id, mediaType: 'boardgame', title: 'Azul', details: '{}', addedBy: asha.id });
    const zone = zoneApart();
    expect(todayIn(zone)).not.toBe(todayUtc());
    await from(asha, zone, `/items/${game.id}/plays`, {});
    const plays = await rows<{ playedOn: string }>('SELECT played_on AS playedOn FROM plays WHERE item_id = ?1', game.id);
    expect(plays).toEqual([{ playedOn: todayIn(zone) }]);
  });

  it('for a read started or finished without a date', async () => {
    const asha = await member('asha');
    const item = await book(asha);
    const zone = zoneApart();
    await from(asha, zone, `/items/${item.id}/reads/start`, {});
    const [open] = await rows<{ id: number; beganOn: string }>('SELECT id, began_on AS beganOn FROM reads WHERE item_id = ?1', item.id);
    expect(open!.beganOn).toBe(todayIn(zone));
    await from(asha, zone, `/items/${item.id}/reads/${open!.id}/finish`, {});
    const [done] = await rows<{ endedOn: string }>('SELECT ended_on AS endedOn FROM reads WHERE id = ?1', open!.id);
    expect(done!.endedOn).toBe(todayIn(zone));
  });

  it('for a first page recorded, which opens a read today', async () => {
    const asha = await member('asha');
    const item = await book(asha);
    const zone = zoneApart();
    await from(asha, zone, `/items/${item.id}/progress`, { page: '40' });
    const reads = await rows<{ beganOn: string }>('SELECT began_on AS beganOn FROM reads WHERE item_id = ?1', item.id);
    expect(reads).toEqual([{ beganOn: todayIn(zone) }]);
  });

  it('for a loan made and a loan returned', async () => {
    const asha = await member('asha');
    const item = await book(asha);
    const zone = zoneApart();
    await from(asha, zone, `/items/${item.id}/loan`, { borrower: 'Priya' });
    const [loan] = await rows<{ id: number; loanedOn: string; returnedOn: string | null }>(
      'SELECT id, loaned_on AS loanedOn, returned_on AS returnedOn FROM loans WHERE item_id = ?1',
      item.id,
    );
    expect(loan).toEqual({ id: expect.any(Number), loanedOn: todayIn(zone), returnedOn: null });
    await from(asha, zone, `/loans/${loan!.id}/return`, {});
    const [back] = await rows<{ returnedOn: string | null }>('SELECT returned_on AS returnedOn FROM loans WHERE id = ?1', loan!.id);
    expect(back!.returnedOn).toBe(todayIn(zone));
  });

  it('for the export’s file name', async () => {
    const asha = await member('asha', 'admin');
    const zone = zoneApart();
    const res = await from(asha, zone, '/export.csv');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="nalanda-export-${todayIn(zone)}.csv"`);
  });
});

describe('app.js', () => {
  it('writes the device’s zone into the tz cookie, same-site, for a year', async () => {
    const js = await (await env.ASSETS.fetch(`${ORIGIN}/app.js`)).text();
    expect(js).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
    expect(js).toContain('tz=${zone}; Path=/; Max-Age=31536000; SameSite=Lax');
  });
});
