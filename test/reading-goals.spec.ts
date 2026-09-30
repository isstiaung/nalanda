// Reading goals (ARCH.md §16 #49): each member's "N books in a year". What counts is every finished read of a book by
// that member with its end date in that year, re-reads included; the Overview shows the signed-in member's, with its
// pace; members set their own and admins anyone's, checked in the route and in the SQL.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addPastRead, deleteGoal, deleteUser, goalOf, goalsOf, setGoal, startRead } from '../src/db/queries';
import { budgeted } from '../src/federation/budget';
import { goalPace, halfOf, paceLabel, parseGoalTarget, settableYears } from '../src/lib/goals';
import { todayUtc } from '../src/lib/reads';
import app from '../src/index';
import { actor, as, book, member, rows, type Member } from './member-helpers';

const finish = (itemId: number, who: Member, endedOn: string | null) =>
  addPastRead(env.DB, itemId, { status: 'completed', beganOn: null, endedOn }, who.id);
const goalRows = () => rows<{ user_id: number; year: number; target: number }>('SELECT user_id, year, target FROM reading_goals ORDER BY id');

describe('what counts toward a goal', () => {
  it('is every finished read of a book by that member ending in that year — re-reads in, others’ reads and other years out', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    expect(await setGoal(env.DB, asha.id, 2025, 24, actor(asha))).toBe(true);
    const dune = await book(asha, { title: 'Dune' });
    const kindred = await book(asha, { title: 'Kindred' });
    const record = await book(asha, { title: 'Kind of Blue', mediaType: 'vinyl' });
    const game = await book(asha, { title: 'Wingspan', mediaType: 'boardgame' });

    await finish(dune.id, asha, '2025-01-01'); // the first day of the year counts
    await finish(dune.id, asha, '2025-12-31'); // and a re-read of it, on the last
    await finish(kindred.id, asha, '2024-12-31'); // the year before: not this goal's
    await finish(kindred.id, asha, '2026-01-01'); // nor the year after
    await finish(kindred.id, asha, null); // a finish with no date is in no year
    await addPastRead(env.DB, kindred.id, { status: 'abandoned', beganOn: null, endedOn: '2025-05-01' }, asha.id); // stopped, not finished
    await startRead(env.DB, kindred.id, '2025-06-01', asha.id); // still reading
    await finish(record.id, asha, '2025-03-01'); // a record isn't a book
    await finish(game.id, asha, '2025-03-01'); // nor is a game
    await finish(kindred.id, ravi, '2025-04-01'); // someone else's read of the same book

    expect((await goalOf(env.DB, asha.id, 2025))!.count).toBe(2);
    await finish(kindred.id, asha, '2025-07-04');
    expect((await goalOf(env.DB, asha.id, 2025))!.count).toBe(3);
    // a read moved or deleted changes the count at once: nothing is stored
    await env.DB.prepare("DELETE FROM reads WHERE item_id = ?1 AND ended_on = '2025-07-04'").bind(kindred.id).run();
    expect((await goalOf(env.DB, asha.id, 2025))!.count).toBe(2);
    expect(await goalOf(env.DB, ravi.id, 2025)).toBeNull(); // no goal, no row
  });

  it('keeps one goal per member per year, newest year first', async () => {
    const asha = await member('asha', 'admin');
    await setGoal(env.DB, asha.id, 2025, 12, actor(asha));
    await setGoal(env.DB, asha.id, 2026, 20, actor(asha));
    expect(await setGoal(env.DB, asha.id, 2026, 30, actor(asha))).toBe(true); // a new target for the same goal
    expect(await setGoal(env.DB, asha.id, 2026, 30, actor(asha))).toBe(true); // saved unchanged: still stands
    expect((await goalsOf(env.DB, asha.id)).map((g) => [g.year, g.target])).toEqual([
      [2026, 30],
      [2025, 12],
    ]);
  });

  it('goes with its member when they are removed', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    await setGoal(env.DB, ravi.id, 2026, 10, actor(ravi));
    await deleteUser(env.DB, ravi.id);
    expect(await goalRows()).toEqual([]);
    expect(asha.id).toBeGreaterThan(0);
  });
});

describe('pace', () => {
  it('is linear through the year: on track until a whole book behind', () => {
    // 2026-07-02 is day 183 of 365: 24 × 183 / 365 = 12.03, so 12 is on track and 9 is three behind
    expect(goalPace(12, 24, 2026, '2026-07-02')).toEqual({ state: 'on_track' });
    expect(goalPace(9, 24, 2026, '2026-07-02')).toEqual({ state: 'behind', by: 3 });
    expect(paceLabel(goalPace(9, 24, 2026, '2026-07-02'))).toBe('3 behind');
    expect(goalPace(0, 24, 2026, '2026-01-01')).toEqual({ state: 'on_track' }); // nobody is behind on 1 January
    expect(goalPace(23, 24, 2026, '2026-12-31')).toEqual({ state: 'behind', by: 1 });
    expect(goalPace(24, 24, 2026, '2026-03-01')).toEqual({ state: 'reached' });
    expect(goalPace(30, 24, 2026, '2026-03-01')).toEqual({ state: 'reached' });
    // a leap year has 366 days: 2028-07-02 is day 184, 366 × ½ = 183 — half of 24 is 12 there too
    expect(goalPace(12, 24, 2028, '2028-07-02')).toEqual({ state: 'on_track' });
    expect(goalPace(0, 24, 2027, '2026-12-01')).toEqual({ state: 'upcoming' });
    expect(goalPace(3, 24, 2025, '2026-12-01')).toEqual({ state: 'missed' });
  });

  it('knows halfway in whole books, and what a form may set', () => {
    expect([1, 2, 3, 24, 25].map(halfOf)).toEqual([1, 1, 2, 12, 13]);
    expect(['1', ' 24 ', '1000'].map(parseGoalTarget)).toEqual([1, 24, 1000]);
    expect(['0', '-3', '1001', '2.5', 'ten', ''].map(parseGoalTarget)).toEqual([null, null, null, null, null, null]);
    expect(settableYears('2026-09-30')).toEqual([2026, 2027]);
  });
});

describe('the Overview', () => {
  const year = () => Number(todayUtc().slice(0, 4));

  it('shows the signed-in member their own goal: count, pace and bar — and nobody else’s', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const item = await book(asha);
    // behind: a thousand books is more than anyone is on pace for on any day of the year
    await setGoal(env.DB, asha.id, year(), 1000, actor(asha));
    await finish(item.id, asha, todayUtc());
    const behind = goalPace(1, 1000, year(), todayUtc());
    expect(behind.state).toBe('behind');
    const html = (await (await as(asha, '/')).text()).replace(/\s+/g, ' ');
    expect(html).toContain(`Reading goal · ${year()}`);
    expect(html).toContain('<span class="goal-count">1 of 1000</span>');
    expect(html).toContain(`<span class="pill behind">${paceLabel(behind)}</span>`);
    expect(html).toContain('class="goal-pace"'); // the tick where an even pace stands today

    // reached
    await setGoal(env.DB, asha.id, year(), 1, actor(asha));
    const reached = (await (await as(asha, '/')).text()).replace(/\s+/g, ' ');
    expect(reached).toContain('<span class="goal-count">1 of 1</span>');
    expect(reached).toContain('<span class="pill reached">reached</span>');
    expect(reached).not.toContain('class="goal-pace"');

    // on track: two books ahead of any pace short of 31 December's
    await setGoal(env.DB, asha.id, year(), 2, actor(asha));
    await finish(item.id, asha, todayUtc());
    await setGoal(env.DB, asha.id, year(), 3, actor(asha));
    const onTrack = (await (await as(asha, '/')).text()).replace(/\s+/g, ' ');
    expect(onTrack).toContain('<span class="goal-count">2 of 3</span>');
    expect(onTrack).toContain(`${paceLabel(goalPace(2, 3, year(), todayUtc()))}</span>`);

    // Ravi has none: he is offered one, and sees nothing of Asha's
    const his = (await (await as(ravi, '/')).text()).replace(/\s+/g, ' ');
    expect(his).toContain(`No reading goal for ${year()}.`);
    expect(his).not.toContain('goal-count');
  });

  it('stays within the D1 budget: one call for the goal', async () => {
    const asha = await member('asha', 'admin');
    const count = async () => {
      const budget = { left: 1000 };
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request('http://nalanda.test/', { headers: { cookie: asha.cookie } }), { ...env, DB: budgeted(env.DB, budget) }, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      return 1000 - budget.left;
    };
    const without = await count();
    await setGoal(env.DB, asha.id, year(), 24, actor(asha));
    const item = await book(asha);
    for (let i = 0; i < 5; i++) await finish(item.id, asha, todayUtc());
    const withGoal = await count();
    expect(withGoal).toBe(without); // the goal's call is made either way; its count rides in it
    expect(withGoal).toBeLessThanOrEqual(12);
  });
});

describe('setting a goal', () => {
  it('is each member’s own, and an admin’s for anyone — refused in the route and in the SQL', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const mira = await member('mira');
    const y = String(settableYears(todayUtc())[0]);

    expect((await as(ravi, '/goals', { body: { userId: String(ravi.id), year: y, target: '24' } })).status).toBe(302);
    expect(await goalRows()).toEqual([{ user_id: ravi.id, year: Number(y), target: 24 }]);

    // a member can't set, see or delete another's
    const refused = await as(ravi, '/goals', { body: { userId: String(mira.id), year: y, target: '5' } });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('only your own');
    expect((await as(ravi, `/goals?member=${mira.id}`)).status).toBe(403);
    // and the statement refuses what a route might let through
    expect(await setGoal(env.DB, mira.id, Number(y), 5, actor(ravi))).toBe(false);
    expect(await setGoal(env.DB, ravi.id, Number(y), 99, actor(mira))).toBe(false);
    expect(await goalRows()).toEqual([{ user_id: ravi.id, year: Number(y), target: 24 }]);

    // an admin sets anyone's, and sees it
    expect((await as(asha, `/goals?member=${mira.id}`, { body: { userId: String(mira.id), year: y, target: '12' } })).status).toBe(302);
    expect((await goalRows()).find((g) => g.user_id === mira.id)?.target).toBe(12);
    const page = await (await as(asha, `/goals?member=${mira.id}`)).text();
    expect(page).toContain('mira’s goal');
    expect(await setGoal(env.DB, 9999, Number(y), 12, actor(asha))).toBe(false); // nobody

    const ravisGoal = (await goalsOf(env.DB, ravi.id))[0]!.id;
    const miras = (await goalsOf(env.DB, mira.id))[0]!.id;
    expect((await as(mira, `/goals/${ravisGoal}/delete`, { body: {} })).status).toBe(403);
    expect(await deleteGoal(env.DB, ravisGoal, actor(mira))).toBe(false);
    expect((await as(ravi, `/goals/${ravisGoal}/delete`, { body: {} })).status).toBe(302);
    expect((await as(asha, `/goals/${miras}/delete`, { body: {} })).status).toBe(302);
    expect(await goalRows()).toEqual([]);
  });

  it('takes this year or next, and a whole number of books', async () => {
    const ravi = await member('ravi');
    const [thisYear, nextYear] = settableYears(todayUtc());
    for (const [year, target] of [
      [String(thisYear! - 1), '10'],
      [String(nextYear! + 1), '10'],
      [String(thisYear), '0'],
      [String(thisYear), 'twelve'],
      [String(thisYear), '1001'],
    ] as const) {
      const res = await as(ravi, '/goals', { body: { userId: String(ravi.id), year, target } });
      expect(res.status, `${year} ${target}`).toBe(400);
    }
    expect(await goalRows()).toEqual([]);
    expect((await as(ravi, '/goals', { body: { year: String(nextYear), target: '30' } })).status).toBe(302); // yours by default
    expect(await goalRows()).toEqual([{ user_id: ravi.id, year: nextYear, target: 30 }]);
    const page = await (await as(ravi, '/goals')).text();
    expect(page).toContain('Your goals');
    expect(page).toContain('not started yet');
  });
});
