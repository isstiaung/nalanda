// Each member's reading and reviews (ARCH.md §16 #43): the household's summary on the item, each person's reads on the
// book's page, the edit form as one person's, and who may change what — members their own, admins anyone's.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  addPastRead,
  addProgress,
  closeRead,
  deleteProgress,
  deleteRead,
  deleteReview,
  getItem,
  listProgress,
  moveRead,
  moveReview,
  refreshReadState,
  refreshReviewState,
  startRead,
  updateRead,
  updateReview,
} from '../src/db/queries';
import type { ReadStatus } from '../src/db/schema';
import { summarizeReads } from '../src/lib/reads';
import { summarizeReviews } from '../src/lib/reviews';
import { actor, as, book, html, member, openReadOf, readsOf, reviewsOf, rows, summaryOf, type Member } from './member-helpers';

const household = async () => ({ asha: await member('asha', 'admin'), ravi: await member('ravi'), mira: await member('mira') });

// ---------- the household's summary ----------

describe('the household summary on an item', () => {
  it('is Completed once anyone has finished it, and re-reading while someone reads it now', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha, { status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20' });
    await startRead(env.DB, item.id, '2026-09-01', ravi.id); // ravi's first read of a book asha finished
    expect(await summaryOf(item.id)).toMatchObject({ status: 'completed', completedOn: '2019-03-20', readCount: 1, rereading: 1 });

    await closeRead(env.DB, item.id, await openReadOf(item.id, ravi), 'completed', '2026-09-10', actor(ravi));
    // the latest finish by anyone, and everyone's finishes counted
    expect(await summaryOf(item.id)).toMatchObject({ status: 'completed', beganOn: '2026-09-01', completedOn: '2026-09-10', readCount: 2, rereading: 0 });
  });

  it('is In progress while anyone reads and nobody has finished, Abandoned when everyone stopped, else Not started', async () => {
    const { asha, ravi } = await household();
    const item = await book(null);
    expect(await summaryOf(item.id)).toMatchObject({ status: 'not_started', readCount: 0 });

    await addPastRead(env.DB, item.id, { status: 'abandoned', beganOn: '2020-01-01', endedOn: '2020-02-01' }, asha.id);
    expect(await summaryOf(item.id)).toMatchObject({ status: 'abandoned', completedOn: '2020-02-01' });

    await startRead(env.DB, item.id, '2026-09-01', ravi.id);
    expect(await summaryOf(item.id)).toMatchObject({ status: 'in_progress', beganOn: '2026-09-01', completedOn: null, rereading: 0 });

    await addPastRead(env.DB, item.id, { status: 'completed', beganOn: null, endedOn: '2021-05-01' }, asha.id);
    expect(await summaryOf(item.id)).toMatchObject({ status: 'completed', completedOn: '2021-05-01', rereading: 1, readCount: 1 });
  });

  it('keeps the SQL summary and its TypeScript twin together across readers', async () => {
    const { asha, ravi, mira } = await household();
    const shapes: Array<Array<[Member, ReadStatus, string | null, string | null]>> = [
      [[asha, 'completed', '2019-01-01', '2019-02-01'], [ravi, 'in_progress', '2026-09-01', null]],
      [[asha, 'abandoned', '2020-01-01', '2020-01-05'], [ravi, 'abandoned', '2021-01-01', '2021-02-01'], [mira, 'in_progress', null, null]],
      [[asha, 'completed', null, null], [ravi, 'completed', '2018-01-01', '2018-03-01'], [mira, 'completed', null, '2017-01-01']],
      [[ravi, 'in_progress', '2026-01-01', null], [mira, 'in_progress', '2026-02-01', null], [asha, 'abandoned', null, '2025-12-01']],
    ];
    for (const shape of shapes) {
      const item = await book(null);
      for (const [who, status, began, ended] of shape) {
        if (status === 'in_progress') await startRead(env.DB, item.id, began ?? '2026-09-01', who.id);
        else await addPastRead(env.DB, item.id, { status, beganOn: began, endedOn: ended }, who.id);
      }
      const reads = await readsOf(item.id);
      const state = summarizeReads(reads.map((r) => ({ status: r.status as ReadStatus, beganOn: r.beganOn, endedOn: r.endedOn })));
      const got = await getItem(env.DB, item.id);
      expect({ status: got?.status, beganOn: got?.beganOn, completedOn: got?.completedOn, readCount: got?.readCount, rereading: got?.rereading }).toEqual(state);
    }
  });

  it('shows the latest page recorded in anyone’s open read', async () => {
    const { asha, ravi } = await household();
    const item = await book(null);
    await addProgress(env.DB, item.id, 50, asha.id);
    await env.DB.prepare("UPDATE reading_progress SET at = '2026-09-01 10:00:00'").run();
    await addProgress(env.DB, item.id, 120, ravi.id);
    await env.DB.prepare("UPDATE reading_progress SET at = '2026-09-02 10:00:00' WHERE page = 120").run();
    await env.DB.batch([refreshReadState(env.DB, [item.id])]);
    expect(await summaryOf(item.id)).toMatchObject({ progressPage: 120 });

    await addProgress(env.DB, item.id, 60, asha.id); // now, so the newest
    expect(await summaryOf(item.id)).toMatchObject({ progressPage: 60 });

    // asha finishes: only ravi is reading now, so his page is the one shown
    await closeRead(env.DB, item.id, await openReadOf(item.id, asha), 'completed', '2026-09-28', actor(asha));
    expect(await summaryOf(item.id)).toMatchObject({ progressPage: 120 });
  });

  it('averages everyone’s ratings, rounded to the scale, and shows the review written last', async () => {
    const { asha, ravi, mira } = await household();
    const item = await book(asha, { rating: 8, review: 'Asha: an old favourite.' });
    await env.DB.prepare("UPDATE reviews SET reviewed_at = '2020-01-01 00:00:00'").run();
    await updateReviewAs(item.id, ravi, 5, 'Ravi: slow going.');
    expect(await summaryOf(item.id)).toMatchObject({ rating: 7, review: 'Ravi: slow going.' }); // 6.5 rounds up

    // a rating changed alone leaves the written time, so ravi's review stays the latest
    await env.DB.prepare("UPDATE reviews SET reviewed_at = '2021-01-01 00:00:00' WHERE user_id = ?1").bind(ravi.id).run();
    await as(asha, `/items/${item.id}/reviews/${(await reviewsOf(item.id))[0]!.id}`, { body: { rating: '10', review: 'Asha: an old favourite.' } });
    expect(await summaryOf(item.id)).toMatchObject({ rating: 8, review: 'Ravi: slow going.' }); // (10 + 5) / 2 = 7.5 → 8

    await updateReviewAs(item.id, mira, null, 'Mira: no stars from me, just words.');
    expect(await summaryOf(item.id)).toMatchObject({ rating: 8, review: 'Mira: no stars from me, just words.' });
    const summary = summarizeReviews((await reviewsOf(item.id)).map((r) => ({ rating: r.rating, review: r.review, reviewedAt: r.reviewedAt })));
    expect(await summaryOf(item.id)).toMatchObject(summary);
  });

  it('keeps refreshReviewState and summarizeReviews together — ties go to the later review', async () => {
    const item = await book(null);
    const { asha, ravi, mira } = await household();
    for (const [who, rating, review, at] of [
      [asha, 3, 'first', '2024-01-01 00:00:00'],
      [ravi, 4, 'second', '2024-01-01 00:00:00'],
      [mira, 10, null, null],
    ] as const) {
      await env.DB.prepare('INSERT INTO reviews (item_id, user_id, rating, review, reviewed_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(item.id, who.id, rating, review, at).run();
    }
    await env.DB.batch([refreshReviewState(env.DB, [item.id])]);
    const expected = summarizeReviews((await reviewsOf(item.id)).map((r) => ({ rating: r.rating, review: r.review, reviewedAt: r.reviewedAt })));
    expect(expected).toEqual({ rating: 6, review: 'second' }); // 17 / 3 = 5.67
    expect(await summaryOf(item.id)).toMatchObject(expected);
  });
});

/** A member's own rating and review, through the edit form they'd use. */
async function updateReviewAs(itemId: number, who: Member, rating: number | null, review: string | null) {
  const item = (await getItem(env.DB, itemId))!;
  const res = await as(who, `/items/${itemId}`, {
    body: { libraryId: String(item.libraryId), title: item.title, mediaType: item.mediaType, rating: rating ? String(rating) : '', review: review ?? '', ...(await formReading(itemId, who)) },
  });
  expect(res.status, await res.clone().text()).toBe(302);
}

/** What someone's edit form sends back for their reading, untouched: read off the form itself. */
async function formReading(itemId: number, who: Member): Promise<Record<string, string>> {
  const form = await html(who, `/items/${itemId}/edit`);
  if (/<select name="status" disabled/.test(form)) return {};
  const status = /<option value="([a-z_]+)" selected/.exec(form.slice(form.indexOf('name="status"')))?.[1] ?? 'not_started';
  const began = /name="beganOn" value="([^"]*)"/.exec(form)?.[1] ?? '';
  const completed = /name="completedOn" value="([^"]*)"/.exec(form)?.[1] ?? '';
  return { status, beganOn: began, completedOn: completed };
}

// ---------- each person's reading on the book's page ----------

describe('each person’s reading, on the book’s page', () => {
  it('says "Read again" to whoever finished it and "Start reading" to whoever hasn’t, under their names', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha, { status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20' });

    const hers = await html(asha, `/items/${item.id}`);
    expect(hers).toContain('<button type="submit">Read again</button>');
    expect(hers).toContain('You <span class="muted">· asha</span>');

    const his = await html(ravi, `/items/${item.id}`);
    expect(his).toContain('<button type="submit">Start reading</button>');
    expect(his).not.toContain('Read again');
    expect(his).toContain('<p class="reader-name">asha</p>');
    expect(his).toContain('Finished 2019-03-20'); // her reading, read-only for him
  });

  it('lets two people read the same book at once, each recording their own pages', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha, { status: 'completed', completedOn: '2019-03-20' });
    expect((await as(ravi, `/items/${item.id}/reads/start`, { body: {}, htmx: true })).status).toBe(200);
    const again = await (await as(asha, `/items/${item.id}/reads/start`, { body: {}, htmx: true })).text();
    expect(again).toContain('Re-reading, since');
    expect((await readsOf(item.id)).filter((r) => r.status === 'in_progress').map((r) => r.readerId).sort()).toEqual([asha.id, ravi.id].sort());

    await as(ravi, `/items/${item.id}/progress`, { body: { page: '40' }, htmx: true });
    await as(asha, `/items/${item.id}/progress`, { body: { page: '90' }, htmx: true });
    const pages = await rows<{ page: number; readerId: number; addedBy: number }>(
      'SELECT p.page, r.reader_id AS readerId, p.added_by AS addedBy FROM reading_progress p JOIN reads r ON r.id = p.read_id ORDER BY p.id',
    );
    expect(pages).toEqual([
      { page: 40, readerId: ravi.id, addedBy: ravi.id },
      { page: 90, readerId: asha.id, addedBy: asha.id },
    ]);
    const his = await html(ravi, `/items/${item.id}`);
    expect(his).toContain('Reading, since'); // his first read: not "re-reading", though the household is
    expect(his).toMatch(/<span class="mono">p\. 40<\/span>/);
    expect(await summaryOf(item.id)).toMatchObject({ status: 'completed', rereading: 1, readCount: 1 });
  });

  it('records a first page as someone’s first read, whoever else has read it', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha, { status: 'completed', completedOn: '2019-03-20' });
    // asha finished and has no read open: her page is refused; ravi has none, so his page starts one
    expect(await (await as(asha, `/items/${item.id}/progress`, { body: { page: '10' }, htmx: true })).text()).toContain('isn’t being read now');
    await as(ravi, `/items/${item.id}/progress`, { body: { page: '10' }, htmx: true });
    expect((await readsOf(item.id)).map((r) => [r.readerId, r.status])).toEqual([
      [asha.id, 'completed'],
      [ravi.id, 'in_progress'],
    ]);
  });

  it('shows members everyone’s reads but the forms for their own only; an admin gets them for all, with Move', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha, { status: 'completed', completedOn: '2019-03-20' });
    const hers = (await readsOf(item.id))[0]!.id;
    await startRead(env.DB, item.id, '2026-09-01', ravi.id);
    const his = await openReadOf(item.id, ravi);

    const asMember = await html(ravi, `/items/${item.id}`);
    expect(asMember).toContain(`/reads/${his}/finish`);
    expect(asMember).not.toContain(`/reads/${hers}"`); // no correcting her read
    expect(asMember).not.toContain(`/reads/${hers}/delete`);
    expect(asMember).not.toContain('/move');

    const asAdmin = await html(asha, `/items/${item.id}`);
    expect(asAdmin).toContain(`/reads/${his}/delete`);
    expect(asAdmin).toContain(`/reads/${his}/move`);
    expect(asAdmin).toMatch(/<button type="submit" class="btn">\s*Move/); // a secondary action
  });
});

// ---------- the edit form ----------

describe('the edit form is its editor’s', () => {
  const form = (item: { libraryId: number; title: string }, over: Record<string, string>) => ({
    libraryId: String(item.libraryId),
    title: item.title,
    mediaType: 'book',
    ...over,
  });

  it('shows and edits the editor’s own status, dates, rating and review', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha, { status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20', rating: 8, review: 'Hers' });

    const his = await html(ravi, `/items/${item.id}/edit`);
    expect(his).toMatch(/<option value="not_started" selected/);
    expect(his).toContain('Your status');
    expect(his).toContain('name="beganOn" value=""');
    expect(his).not.toContain('>Hers<');

    const res = await as(ravi, `/items/${item.id}`, { body: form(item, { status: 'completed', beganOn: '2026-08-01', completedOn: '2026-09-01', rating: '4', review: 'His' }) });
    expect(res.status).toBe(302);
    expect((await readsOf(item.id)).map((r) => [r.readerId, r.status, r.endedOn])).toEqual([
      [asha.id, 'completed', '2019-03-20'],
      [ravi.id, 'completed', '2026-09-01'],
    ]);
    expect((await reviewsOf(item.id)).map((r) => [r.userId, r.rating, r.review])).toEqual([
      [asha.id, 8, 'Hers'],
      [ravi.id, 4, 'His'],
    ]);
    expect(await summaryOf(item.id)).toMatchObject({ status: 'completed', completedOn: '2026-09-01', readCount: 2, rating: 6, review: 'His' });

    // clearing his rating and review removes his, and only his
    await as(ravi, `/items/${item.id}`, { body: form(item, { status: 'completed', beganOn: '2026-08-01', completedOn: '2026-09-01', rating: '', review: '' }) });
    expect((await reviewsOf(item.id)).map((r) => r.userId)).toEqual([asha.id]);
    expect(await summaryOf(item.id)).toMatchObject({ rating: 8, review: 'Hers' });
  });

  it('locks the reading fields only for the person reading it again, and refuses "In progress" only to whoever finished', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha, { status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20' });
    await startRead(env.DB, item.id, '2026-09-01', asha.id); // her re-read
    await startRead(env.DB, item.id, '2026-09-02', ravi.id); // his first read

    expect(await html(asha, `/items/${item.id}/edit`)).toMatch(/<select name="status" disabled/);
    const his = await html(ravi, `/items/${item.id}/edit`);
    expect(his).not.toMatch(/<select name="status" disabled/);
    expect(his).toMatch(/<option value="in_progress" selected/);

    // he can stop his first read from the form; she can't turn her finish into anything but a finish
    expect((await as(ravi, `/items/${item.id}`, { body: form(item, { status: 'abandoned', beganOn: '2026-09-02', completedOn: '2026-09-05' }) })).status).toBe(302);
    const refused = await as(asha, `/items/${item.id}`, { body: form(item, { status: 'abandoned', beganOn: '2019-03-01', completedOn: '2019-03-20' }) });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('being read again');
    expect((await readsOf(item.id)).map((r) => [r.readerId, r.status])).toEqual([
      [asha.id, 'completed'],
      [asha.id, 'in_progress'],
      [ravi.id, 'abandoned'],
    ]);
  });

  it('says "use Read again" to someone who finished it, not to the rest of the household', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha, { status: 'completed', completedOn: '2019-03-20' });
    const hers = await as(asha, `/items/${item.id}`, { body: form(item, { status: 'in_progress', completedOn: '' }) });
    expect(hers.status).toBe(400);
    expect(await hers.text()).toContain('use Read again on its page');
    expect((await as(ravi, `/items/${item.id}`, { body: form(item, { status: 'in_progress', beganOn: '2026-09-01', completedOn: '' }) })).status).toBe(302);
  });

  it('clears only the editor’s reads when a record is made not started again', async () => {
    const { asha, ravi } = await household();
    const record = await book(asha, { mediaType: 'vinyl', title: 'Kind of Blue', status: 'completed', completedOn: '2020-01-01' });
    await addPastRead(env.DB, record.id, { status: 'completed', beganOn: null, endedOn: '2021-01-01' }, ravi.id);
    const res = await as(ravi, `/items/${record.id}`, { body: { libraryId: String(record.libraryId), title: 'Kind of Blue', mediaType: 'vinyl', status: 'not_started', beganOn: '', completedOn: '' } });
    expect(res.status).toBe(302);
    expect((await readsOf(record.id)).map((r) => r.readerId)).toEqual([asha.id]);
    expect(await summaryOf(record.id)).toMatchObject({ status: 'completed', completedOn: '2020-01-01', readCount: 1 });
  });
});

// ---------- who may change what ----------

describe('permissions: members change their own, admins anyone’s', () => {
  async function scene() {
    const people = await household();
    const { asha, ravi } = people;
    const item = await book(ravi, { status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20', rating: 6, review: 'Ravi’s review' });
    await startRead(env.DB, item.id, '2026-09-01', ravi.id);
    await addProgress(env.DB, item.id, 30, ravi.id);
    const [finished, open] = (await readsOf(item.id)).map((r) => r.id);
    const [page] = await listProgress(env.DB, item.id);
    const [review] = await reviewsOf(item.id);
    return { ...people, asha, ravi, item, finished: finished!, open: open!, page: page!, review: review! };
  }

  it('refuses a member every change to someone else’s read, page or review, and changes nothing', async () => {
    const s = await scene();
    const before = [await readsOf(s.item.id), await listProgress(env.DB, s.item.id), await reviewsOf(s.item.id), await summaryOf(s.item.id)];
    const attempts: Array<[string, Record<string, string>]> = [
      [`/items/${s.item.id}/reads/${s.open}/finish`, { date: '2026-09-10' }],
      [`/items/${s.item.id}/reads/${s.open}/stop`, {}],
      [`/items/${s.item.id}/reads/${s.finished}`, { status: 'abandoned', beganOn: '2019-03-01', endedOn: '2019-03-02' }],
      [`/items/${s.item.id}/reads/${s.finished}/delete`, {}],
      [`/items/${s.item.id}/reads/${s.finished}/move`, { to: String(s.mira.id) }],
      [`/items/${s.item.id}/progress/${s.page.id}/delete`, {}],
      [`/items/${s.item.id}/reviews/${s.review.id}`, { rating: '1', review: 'vandalised' }],
      [`/items/${s.item.id}/reviews/${s.review.id}/delete`, {}],
      [`/items/${s.item.id}/reviews/${s.review.id}/move`, { to: String(s.mira.id) }],
    ];
    for (const [path, body] of attempts) {
      const res = await as(s.mira, path, { body, htmx: true });
      expect(res.status, path).toBe(403);
    }
    expect([await readsOf(s.item.id), await listProgress(env.DB, s.item.id), await reviewsOf(s.item.id), await summaryOf(s.item.id)]).toEqual(before);
  });

  it('lets the owner do the same — the refusals above are about whose it is, not the route', async () => {
    const s = await scene();
    expect((await as(s.ravi, `/items/${s.item.id}/progress/${s.page.id}/delete`, { body: {}, htmx: true })).status).toBe(200);
    expect(await listProgress(env.DB, s.item.id)).toEqual([]);
    expect((await as(s.ravi, `/items/${s.item.id}/reads/${s.open}/finish`, { body: { date: '2026-09-10' }, htmx: true })).status).toBe(200);
    expect(await summaryOf(s.item.id)).toMatchObject({ readCount: 2, completedOn: '2026-09-10' });
    expect((await as(s.ravi, `/items/${s.item.id}/reviews/${s.review.id}`, { body: { rating: '9', review: 'Better second time' } })).status).toBe(302);
    expect(await summaryOf(s.item.id)).toMatchObject({ rating: 9, review: 'Better second time' });
    expect((await as(s.ravi, `/items/${s.item.id}/reads/${s.finished}/delete`, { body: {}, htmx: true })).status).toBe(200);
    expect((await readsOf(s.item.id)).map((r) => r.id)).toEqual([s.open]);
  });

  it('refuses a member moving even their own read or review: moving is an admin’s fix', async () => {
    const s = await scene();
    expect((await as(s.ravi, `/items/${s.item.id}/reads/${s.finished}/move`, { body: { to: String(s.mira.id) }, htmx: true })).status).toBe(403);
    expect((await as(s.ravi, `/items/${s.item.id}/reviews/${s.review.id}/move`, { body: { to: String(s.mira.id) } })).status).toBe(403);
    expect((await readsOf(s.item.id)).every((r) => r.readerId === s.ravi.id)).toBe(true);
    expect((await reviewsOf(s.item.id))[0]!.userId).toBe(s.ravi.id);
  });

  it('lets an admin correct, delete and move anyone’s — a read moving with its pages', async () => {
    const s = await scene();
    const moved = await as(s.asha, `/items/${s.item.id}/reads/${s.open}/move`, { body: { to: String(s.mira.id) }, htmx: true });
    expect(moved.status).toBe(200);
    expect((await readsOf(s.item.id)).map((r) => [r.id, r.readerId])).toEqual([
      [s.finished, s.ravi.id],
      [s.open, s.mira.id],
    ]);
    expect((await listProgress(env.DB, s.item.id)).map((p) => p.addedBy)).toEqual([s.mira.id]); // the page went too
    expect(await summaryOf(s.item.id)).toMatchObject({ status: 'completed', readCount: 1, rereading: 1, progressPage: 30 }); // nothing public moved
    expect(await html(s.mira, `/items/${s.item.id}`)).toMatch(/<span class="mono">p\. 30<\/span>/); // hers now

    await as(s.asha, `/items/${s.item.id}/reads/${s.finished}`, { body: { status: 'completed', beganOn: '2019-03-01', endedOn: '2019-03-25' }, htmx: true });
    expect(await summaryOf(s.item.id)).toMatchObject({ completedOn: '2019-03-25' });

    expect((await as(s.asha, `/items/${s.item.id}/reviews/${s.review.id}/move`, { body: { to: String(s.mira.id) } })).status).toBe(302);
    expect((await reviewsOf(s.item.id))[0]!.userId).toBe(s.mira.id);
    expect((await as(s.asha, `/items/${s.item.id}/reviews/${s.review.id}/delete`, { body: {} })).status).toBe(302);
    expect(await reviewsOf(s.item.id)).toEqual([]);
    expect(await summaryOf(s.item.id)).toMatchObject({ rating: null, review: null });
  });

  it('won’t move an open read to someone already reading it, or a review to someone who has one, and says so', async () => {
    const s = await scene();
    await startRead(env.DB, s.item.id, '2026-09-05', s.mira.id);
    const res = await (await as(s.asha, `/items/${s.item.id}/reads/${s.open}/move`, { body: { to: String(s.mira.id) }, htmx: true })).text();
    expect(res).toContain('mira is reading this book now');
    expect((await readsOf(s.item.id)).find((r) => r.id === s.open)?.readerId).toBe(s.ravi.id);

    await as(s.mira, `/items/${s.item.id}`, { body: { libraryId: String(s.item.libraryId), title: s.item.title, mediaType: 'book', rating: '2', ...(await formReading(s.item.id, s.mira)) } });
    const refused = await as(s.asha, `/items/${s.item.id}/reviews/${s.review.id}/move`, { body: { to: String(s.mira.id) } });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('mira has a review of this already');
    expect((await reviewsOf(s.item.id)).map((r) => r.userId)).toEqual([s.ravi.id, s.mira.id]);
  });

  it('holds in the database layer too: a member acting on someone else’s changes nothing', async () => {
    const s = await scene();
    const mira = actor(s.mira);
    expect(await closeRead(env.DB, s.item.id, s.open, 'completed', '2026-09-10', mira)).toBe(false);
    expect(await updateRead(env.DB, s.item.id, s.finished, { status: 'abandoned', beganOn: null, endedOn: null }, mira)).toBe(false);
    expect(await deleteRead(env.DB, s.item.id, s.finished, mira)).toBe(false);
    expect(await deleteProgress(env.DB, s.item.id, s.page.id, mira)).toBe(false);
    expect(await updateReview(env.DB, s.item.id, s.review.id, { rating: 1, review: null }, mira)).toBe(false);
    expect(await deleteReview(env.DB, s.item.id, s.review.id, mira)).toBe(false);
    expect(await moveRead(env.DB, s.item.id, s.finished, s.mira.id, mira)).toBe(false);
    expect(await moveReview(env.DB, s.item.id, s.review.id, s.mira.id, mira)).toBe(false);
    expect((await readsOf(s.item.id)).map((r) => [r.readerId, r.status])).toEqual([
      [s.ravi.id, 'completed'],
      [s.ravi.id, 'in_progress'],
    ]);
    expect(await listProgress(env.DB, s.item.id)).toHaveLength(1);
    expect(await reviewsOf(s.item.id)).toMatchObject([{ userId: s.ravi.id, rating: 6 }]);
    // negative control: the same calls as an admin go through
    expect(await closeRead(env.DB, s.item.id, s.open, 'completed', '2026-09-10', actor(s.asha))).toBe(true);
    expect(await deleteProgress(env.DB, s.item.id, s.page.id, actor(s.asha))).toBe(true);
  });

  it('gives a record’s or game’s reads the same: listed by person, fixed by an admin, refused to other members', async () => {
    const { asha, ravi, mira } = await household();
    const game = await book(ravi, { mediaType: 'boardgame', title: 'Wingspan', status: 'completed', completedOn: '2026-05-01' });
    const [read] = await readsOf(game.id);

    const page = await html(asha, `/items/${game.id}`);
    expect(page).toContain('<p class="reader-name">ravi</p>');
    expect(page).toContain(`/reads/${read!.id}/delete`);
    expect(page).toContain(`/reads/${read!.id}/move`);
    expect(await html(mira, `/items/${game.id}`)).not.toContain(`/reads/${read!.id}/delete`);

    expect((await as(mira, `/items/${game.id}/reads/${read!.id}/delete`, { body: {}, htmx: true })).status).toBe(403);
    const moved = await as(asha, `/items/${game.id}/reads/${read!.id}/move`, { body: { to: String(mira.id) }, htmx: true });
    expect(moved.status).toBe(200);
    expect(await moved.text()).toContain('<p class="reader-name">mira</p>');
    expect((await readsOf(game.id))[0]!.readerId).toBe(mira.id);
    expect((await as(asha, `/items/${game.id}/reads/${read!.id}/delete`, { body: {}, htmx: true })).status).toBe(200);
    expect(await summaryOf(game.id)).toMatchObject({ status: 'not_started', readCount: 0 });
    // starting a read, a past read and pages stay a book's
    expect((await as(asha, `/items/${game.id}/reads/start`, { body: {} })).status).toBe(404);
  });

  it('keeps the move routes to real members of the household', async () => {
    const s = await scene();
    const res = await (await as(s.asha, `/items/${s.item.id}/reads/${s.finished}/move`, { body: { to: '999999' }, htmx: true })).text();
    expect(res).toContain('Choose a member');
    expect((await readsOf(s.item.id))[0]!.readerId).toBe(s.ravi.id);
  });
});
