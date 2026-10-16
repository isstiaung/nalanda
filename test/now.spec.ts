// Now reading & playing (ARCH.md §16 #104): every book being read in the household, by whom and how far, and the games
// and records played lately — and the two things a person does from there, which post to the item's own routes with
// back=now and land back on the page.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addProgress, closeRead, createLibrary, logPlay, startRead } from '../src/db/queries';
import { daysBefore, todayIn } from '../src/lib/dates';
import { PLAYED_LATELY_DAYS } from '../src/routes/now';
import { actor, as, book, html, member, openReadOf, rows } from './member-helpers';

const today = () => todayIn('UTC');

describe('the Now page', () => {
  it('lists every book being read, yours first, with whose read it is and where it has got to', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Books');
    const hers = await book(asha, { libraryId: shelf.id, title: 'Hers', length: 400 });
    const his = await book(asha, { libraryId: shelf.id, title: 'His' });
    const done = await book(asha, { libraryId: shelf.id, title: 'Finished' });
    await startRead(env.DB, his.id, '2026-09-01', ravi.id);
    await startRead(env.DB, hers.id, '2026-08-01', asha.id);
    await addProgress(env.DB, hers.id, 100, asha.id);
    await startRead(env.DB, done.id, '2026-07-01', asha.id);
    await closeRead(env.DB, done.id, await openReadOf(done.id, asha), 'completed', '2026-07-20', actor(asha));

    const page = await html(asha, '/now');
    const reading = page.slice(page.indexOf('id="now-reading"'), page.indexOf('id="now-played"'));
    expect(reading.indexOf('>Hers</a>')).toBeGreaterThan(-1);
    expect(reading.indexOf('>His</a>')).toBeGreaterThan(reading.indexOf('>Hers</a>')); // the viewer's own first
    expect(reading).not.toContain('>Finished</a>'); // a finished read isn't open
    expect(reading).toContain('<small class="now-reader">You</small>');
    expect(reading).toContain('<small class="now-reader">ravi</small>');
    expect(reading).toContain('since 2026-08-01');
    expect(reading).toMatch(/p\. 100<\/span> of <span class="mono">400<\/span> · <span class="mono">25%/);
    // a page only into your own read: one Record form, Hers
    expect(reading.match(/action="\/items\/\d+\/progress"/g)).toEqual([`action="/items/${hers.id}/progress"`]);
    expect(reading).toContain('<input type="hidden" name="back" value="now"/>');
    // ravi sees his own first, and Record on his
    const his_ = await html(ravi, '/now');
    expect(his_.indexOf('>His</a>')).toBeLessThan(his_.indexOf('>Hers</a>'));
    expect(his_).toContain(`action="/items/${his.id}/progress"`);
    expect(his_).not.toContain(`action="/items/${hers.id}/progress"`);
  });

  it('names no reader in a household of one, and says what to do when nothing is open', async () => {
    const solo = await member('solo', 'admin');
    const empty = await html(solo, '/now');
    expect(empty).toContain('Nothing is being read just now.');
    expect(empty).toContain('<a href="/#read-next">Read next</a>');
    expect(empty).toContain(`No board game or record played in the last ${PLAYED_LATELY_DAYS} days.`);
    const it = await book(solo, { title: 'Alone' });
    await startRead(env.DB, it.id, '2026-09-01', solo.id);
    const page = await html(solo, '/now');
    expect(page).toContain('>Alone</a>');
    expect(page).not.toContain('now-reader');
  });

  it('lists the games and records played lately, the most recent first, with plays since — not older ones, never a book', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Games');
    const game = await book(asha, { libraryId: shelf.id, title: 'Wingspan', mediaType: 'boardgame' });
    const record = await book(asha, { libraryId: shelf.id, title: 'Kind of Blue', mediaType: 'vinyl' });
    const old = await book(asha, { libraryId: shelf.id, title: 'Long ago', mediaType: 'boardgame' });
    await logPlay(env.DB, game.id, daysBefore(today(), 10), asha.id);
    await logPlay(env.DB, game.id, daysBefore(today(), 3), asha.id);
    await logPlay(env.DB, record.id, today(), asha.id);
    await logPlay(env.DB, old.id, daysBefore(today(), PLAYED_LATELY_DAYS + 1), asha.id);
    const page = await html(asha, '/now');
    const played = page.slice(page.indexOf('id="now-played"'));
    expect(played.indexOf('>Kind of Blue</a>')).toBeGreaterThan(-1);
    expect(played.indexOf('>Wingspan</a>')).toBeGreaterThan(played.indexOf('>Kind of Blue</a>'));
    expect(played).not.toContain('>Long ago</a>');
    expect(played).toContain(`2 plays in ${PLAYED_LATELY_DAYS} days`);
    expect(played).toContain(`1 play in ${PLAYED_LATELY_DAYS} days`);
    expect(played).toContain(`last ${daysBefore(today(), 3)}`);
    expect(played).toContain(`action="/items/${game.id}/plays"`);
    expect(page).toContain('2 PLAYED LATELY');
  });

  it('is inside the app only: signed out, it is the login page, and the answer is never cached', async () => {
    const asha = await member('asha'); // an instance with an account: signed out is the login page, not setup
    const out = await as(null, '/now');
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toMatch(/^\/login/);
    expect((await as(asha, '/now')).headers.get('cache-control')).toBe('no-store');
  });

  it('is pinned in the sidebar under Overview, marked as the page you are on', async () => {
    const asha = await member('asha');
    const home = await html(asha, '/');
    const pinned = home.slice(home.indexOf('<div class="nav-pinned">'), home.indexOf('</div>', home.indexOf('<div class="nav-pinned">')));
    expect(pinned.indexOf('href="/now"')).toBeGreaterThan(pinned.indexOf('href="/"'));
    expect(pinned.indexOf('href="/now"')).toBeLessThan(pinned.indexOf('href="/add"'));
    const now = await html(asha, '/now');
    expect(now).toMatch(/<a href="\/now" class="nav-link active"[^>]*>/);
  });
});

describe('a page or a play from the Now page', () => {
  it('records a page into your read and lands back on the page; refused, it says so there', async () => {
    const asha = await member('asha', 'admin');
    const it = await book(asha, { title: 'Reading' });
    await startRead(env.DB, it.id, '2026-09-01', asha.id);
    const res = await as(asha, `/items/${it.id}/progress`, { body: { page: '42', back: 'now' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/now');
    expect(await rows('SELECT page FROM reading_progress WHERE item_id = ?1', it.id)).toEqual([{ page: 42 }]);
    const refused = await as(asha, `/items/${it.id}/progress`, { body: { page: 'lots', back: 'now' } });
    expect(refused.headers.get('location')).toBe('/now?refused=1');
    expect(await html(asha, '/now?refused=1')).toContain('<p class="error" role="alert">That wasn’t recorded. Open the item to see why.</p>');
    // without back=now, the item page as before (negative control); and any other back is not a place to go
    expect((await as(asha, `/items/${it.id}/progress`, { body: { page: '43' } })).headers.get('location')).toBe(`/items/${it.id}`);
    expect((await as(asha, `/items/${it.id}/progress`, { body: { page: '44', back: 'https://example.com' } })).headers.get('location')).toBe(`/items/${it.id}`);
    // htmx still swaps the item page's section
    expect(await (await as(asha, `/items/${it.id}/progress`, { body: { page: '45', back: 'now' }, htmx: true })).text()).toContain('id="reading"');
  });

  it('logs a play today and lands back on the page', async () => {
    const asha = await member('asha');
    const game = await book(asha, { title: 'Azul', mediaType: 'boardgame' });
    const res = await as(asha, `/items/${game.id}/plays`, { body: { back: 'now' } });
    expect(res.headers.get('location')).toBe('/now');
    expect(await rows('SELECT played_on AS playedOn, logged_by AS loggedBy FROM plays WHERE item_id = ?1', game.id)).toEqual([{ playedOn: today(), loggedBy: asha.id }]);
    expect((await as(asha, `/items/${game.id}/plays`, { body: {} })).headers.get('location')).toBe(`/items/${game.id}`);
  });
});
