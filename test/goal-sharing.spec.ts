// Reading goals reach connected households (ARCH.md §16 #49): per-person entries — set, halfway, reached — signed with a
// display name, recorded only as they happen, only while names and goals both go to connections. They have no item, so
// a household on 1.3.0 or older skips them and keeps the rest of the page; this version reads them.
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView, createSubscription, deleteConnectionView } from '../src/db/federation';
import {
  addPastRead,
  createLibrary,
  deleteGoal,
  deleteUser,
  goalCountSql,
  goalOf,
  mergeImportItems,
  setDisplayName,
  setGoal,
  setGoalsToConnections,
  updateSiteSettings,
} from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { MEMBER_ACTIVITY_BASE } from '../src/federation/config';
import { parseFeedPage } from '../src/federation/feed';
import { parseFeedEntry, type GoalFeedEntry } from '../src/federation/items';
import { clearSharedViewsCache } from '../src/federation/routes';
import { todayUtc } from '../src/lib/reads';
import * as v130 from './fixtures/items-v1.3.0';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, sessionCookie, setUpA, sqlAgo, type Peer } from './federation-helpers';
import { actor, book, member, rows, type Member } from './member-helpers';

const today = () => todayUtc();
const thisYear = () => Number(today().slice(0, 4));

type Served = {
  id: number;
  kind: string;
  published: string;
  item?: { id: number; title: string; by?: string };
  goal?: { by: string; year: number; target: number; count: number };
};
type Page = { latest: number; more: boolean; entries: Served[] };

/** "Asha goal_halfway 2/4 2026" — what a goal entry says, one line each, oldest id first. */
const goalLines = (entries: Served[]) =>
  [...entries]
    .filter((e) => e.kind.startsWith('goal_'))
    .sort((x, y) => x.id - y.id)
    .map((e) => `${e.goal!.by} ${e.kind} ${e.goal!.count}/${e.goal!.target} ${e.goal!.year}`);

/** A book `who` finished on `endedOn` — today unless told otherwise, which is what makes a finish news. */
const finished = async (who: Member, values: Parameters<typeof book>[1] = {}, endedOn: string | null = today()) => {
  const item = await book(who, values);
  await addPastRead(env.DB, item.id, { status: 'completed', beganOn: null, endedOn }, who.id);
  return item;
};

const goalRowKinds = async () => (await rows<{ kind: string }>('SELECT kind FROM member_activity WHERE goal_id IS NOT NULL ORDER BY id')).map((r) => r.kind);

let a: ReturnType<typeof instanceA>;
let peer: Peer;
let viewId: number;

async function connected() {
  const keys = await makeKeys();
  a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
  clearSharedViewsCache();
  await setUpA();
  peer = await makePeer('Riverbank library');
  await connectPeer(peer);
  viewId = (await createConnectionView(env.DB, { name: 'All', libraryId: null, mediaType: null, status: null, owned: null })).id;
  return keys;
}

const pull = async (since = 0, view = viewId) =>
  (await (await a.signedGet(`/federation/feed?view=${view}&since=${since}`, peer)).json()) as Page;
const check = async (ids: number[], view = viewId) =>
  ((await (await a.signedPost('/federation/feed/check', peer, { view, ids })).json()) as { invalid: number[] }).invalid.sort();
const goalIds = (entries: Served[]) => entries.filter((e) => e.kind.startsWith('goal_')).map((e) => e.id).sort();

async function named(name: string, display: string | null, role: 'admin' | 'member' = 'member') {
  const m = await member(name, role);
  if (display) await setDisplayName(env.DB, m.id, display);
  return m;
}

describe('goal entries, as they happen', () => {
  beforeEach(async () => {
    await connected();
    await updateSiteSettings(env.DB, { namesToConnections: true, goalsToConnections: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('say when a goal is set, passes halfway and is reached — signed, with year, target and count, and no item', async () => {
    const asha = await named('u-asha', 'Asha', 'admin');
    expect(await setGoal(env.DB, asha.id, thisYear(), 4, actor(asha))).toBe(true);
    const counts: number[] = [];
    for (const title of ['One', 'Two', 'Three', 'Four']) {
      await finished(asha, { title });
      counts.push((await goalOf(env.DB, asha.id, thisYear()))!.count);
    }
    expect(counts).toEqual([1, 2, 3, 4]);
    const page = await pull();
    const y = thisYear();
    expect(goalLines(page.entries)).toEqual([`Asha goal_set 0/4 ${y}`, `Asha goal_halfway 2/4 ${y}`, `Asha goal_reached 4/4 ${y}`]);
    for (const e of page.entries.filter((x) => x.kind.startsWith('goal_'))) {
      expect(Object.keys(e).sort()).toEqual(['goal', 'id', 'kind', 'published']); // no item, not even null
      expect(Object.keys(e.goal!).sort()).toEqual(['by', 'count', 'target', 'year']);
      expect(e.id).toBeGreaterThan(MEMBER_ACTIVITY_BASE);
      expect(e.published >= sqlAgo(5)).toBe(true); // dated when recorded — now
    }
    // the count a milestone carries is the goal's count at that moment — the trigger's count is goalCountSql's
    const milestones = await rows<{ kind: string; goal_count: number }>("SELECT kind, goal_count FROM member_activity WHERE kind LIKE 'goal_%' ORDER BY id");
    expect(milestones).toEqual([
      { kind: 'goal_set', goal_count: 0 },
      { kind: 'goal_halfway', goal_count: counts[1] },
      { kind: 'goal_reached', goal_count: counts[3] },
    ]);
    // each finish is its own entry as ever — the milestones add to the stream, they don't replace anything
    expect(page.entries.filter((e) => e.kind === 'finished')).toHaveLength(4);
  });

  it('are never backfilled: a past read, an undated finish, an import, a goal set before any view', async () => {
    const asha = await named('u-asha', 'Asha', 'admin');
    // last year's goal, set now: its setting is news, but reads added now with last year's dates are not
    const last = thisYear() - 1;
    await setGoal(env.DB, asha.id, last, 2, actor(asha));
    await finished(asha, { title: 'Back then' }, `${last}-06-15`);
    await finished(asha, { title: 'Also then' }, `${last}-06-16`);
    expect((await goalOf(env.DB, asha.id, last))!.count).toBe(2); // counted — reached, quietly
    expect(await goalRowKinds()).toEqual(['goal_set']);

    // this year: a finish with no date counts toward no year and is no milestone
    await setGoal(env.DB, asha.id, thisYear(), 1, actor(asha));
    await finished(asha, { title: 'Undated' }, null);
    expect((await goalOf(env.DB, asha.id, thisYear()))!.count).toBe(0);
    // an import's finishes — even today's — are an import, not news
    const kindred = await book(asha, { title: 'Kindred', creators: 'Octavia E. Butler' });
    await mergeImportItems(env.DB, [
      {
        item: { libraryId: kindred.libraryId, title: 'Kindred', creators: 'Octavia E. Butler', addedBy: asha.id },
        tags: [],
        goodreads: { shelf: 'completed', dateRead: today(), dateStarted: null, readCount: 1 },
      },
    ]);
    expect((await goalOf(env.DB, asha.id, thisYear()))!.count).toBe(1); // it counts
    expect(await goalRowKinds()).toEqual(['goal_set', 'goal_set']); // but reached nothing on anyone's feed

    // with no view shared nothing is recorded, and sharing one later brings no goal back
    await deleteConnectionView(env.DB, viewId);
    await setGoal(env.DB, asha.id, thisYear() + 1, 10, actor(asha));
    viewId = (await createConnectionView(env.DB, { name: 'Again', libraryId: null, mediaType: null, status: null, owned: null })).id;
    expect(await goalRowKinds()).toEqual([]);
    expect(goalLines((await pull()).entries)).toEqual([]);
  });

  it('tell no read’s date: dated when recorded, a milestone only where its finish is news, nothing to a view of records', async () => {
    const asha = await named('u-asha', 'Asha', 'admin');
    const fiction = await createLibrary(env.DB, 'Fiction');
    const kids = await createLibrary(env.DB, 'Kids');
    const kidsView = (await createConnectionView(env.DB, { name: 'Kids', libraryId: kids.id, mediaType: null, status: null, owned: null })).id;
    const records = (await createConnectionView(env.DB, { name: 'Records', libraryId: null, mediaType: 'vinyl', status: null, owned: null })).id;
    await setGoal(env.DB, asha.id, thisYear(), 3, actor(asha));
    // two books finished long ago this year, added now: they count, but nothing is announced for them
    const early = `${thisYear()}-01-01`;
    if (early < new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)) {
      await finished(asha, { title: 'January', libraryId: fiction.id }, early);
    }
    await finished(asha, { title: 'Today', libraryId: fiction.id });
    await finished(asha, { title: 'Also today', libraryId: fiction.id });
    await finished(asha, { title: 'And one more', libraryId: fiction.id });

    const all = await pull();
    const text = JSON.stringify(all.entries.filter((e) => e.kind.startsWith('goal_')));
    expect(text).not.toContain(early); // no read's date — only when each entry was recorded
    expect(text).not.toMatch(/"(ended|began|completed)/i);
    expect(goalLines(all.entries).map((l) => l.split(' ')[1])).toEqual(['goal_set', 'goal_halfway', 'goal_reached']);
    // Kids holds none of those books: the goal, yes; the milestones their finishes made, no
    expect(goalLines((await pull(0, kidsView)).entries).map((l) => l.split(' ')[1])).toEqual(['goal_set']);
    expect(goalLines((await pull(0, records)).entries)).toEqual([]);
    expect(await check(goalIds(all.entries), records)).toEqual(goalIds(all.entries));
  });
});

describe('the switches', () => {
  beforeEach(connected);
  afterEach(() => vi.unstubAllGlobals());

  it('send no goal entry while names are off, and withdraw them when goals go off — bringing them back when on', async () => {
    const asha = await named('u-asha', 'Asha', 'admin');
    await updateSiteSettings(env.DB, { namesToConnections: true, goalsToConnections: true });
    await setGoal(env.DB, asha.id, thisYear(), 2, actor(asha));
    await finished(asha);
    const first = await pull();
    const goals = goalIds(first.entries);
    expect(goals).toHaveLength(2); // set, halfway
    const others = first.entries.filter((e) => !e.kind.startsWith('goal_')).map((e) => e.id);

    await setGoalsToConnections(env.DB, false);
    expect(goalLines((await pull()).entries)).toEqual([]);
    expect(await check([...goals, ...others])).toEqual(goals); // only the goal entries go
    expect((await pull(first.latest)).entries).toEqual([]);

    await setGoalsToConnections(env.DB, false); // saved unchanged: nothing re-keyed
    await setGoalsToConnections(env.DB, true);
    const again = await pull(first.latest); // new ids, past the cursor: pulled again
    expect(goalLines(again.entries)).toEqual(goalLines(first.entries));
    expect(again.entries.map((e) => e.published).sort()).toEqual(first.entries.filter((e) => goals.includes(e.id)).map((e) => e.published).sort());

    // names off: the household's stream, which has no goals at all — and every per-person id is withdrawn
    await updateSiteSettings(env.DB, { namesToConnections: false });
    const household = await pull();
    expect(household.entries.every((e) => e.id < MEMBER_ACTIVITY_BASE && !e.kind.startsWith('goal_'))).toBe(true);
    expect(await check(goalIds(again.entries))).toEqual(goalIds(again.entries));
  });

  it('are an admin’s, on the Connections page, the goals one greyed out until names go to connections', async () => {
    const admin = await sessionCookie('admin');
    const plain = await sessionCookie('member');
    await updateSiteSettings(env.DB, { namesToConnections: false, goalsToConnections: false });
    const off = (await (await a.get('/connections', admin)).text()).replace(/\s+/g, ' ');
    expect(off).toContain('Share reading goals');
    expect(off).toMatch(/<input type="checkbox" name="goalsToConnections" value="on" disabled=""\s*\/?>/);
    expect(off).toContain('Takes effect only while names are shown to connected households');
    expect((await a.postForm('/connections/goals-sharing', { goalsToConnections: 'on' }, plain)).status).toBe(403);
    expect((await rows<{ g: number }>('SELECT goals_to_connections AS g FROM site_settings'))).toEqual([{ g: 0 }]);

    await updateSiteSettings(env.DB, { namesToConnections: true });
    expect((await a.postForm('/connections/goals-sharing', { goalsToConnections: 'on' }, admin)).status).toBe(302);
    const on = (await (await a.get('/connections', admin)).text()).replace(/\s+/g, ' ');
    expect(on).toMatch(/<input type="checkbox" name="goalsToConnections" value="on" checked=""\s*\/?>/);
    expect(on).not.toContain('Takes effect only while names are shown');
    expect((await rows<{ n: number; g: number }>('SELECT names_to_connections AS n, goals_to_connections AS g FROM site_settings'))).toEqual([{ n: 1, g: 1 }]);
    expect((await a.postForm('/connections/goals-sharing', {}, admin)).status).toBe(302); // unchecked: off
    expect((await rows<{ g: number }>('SELECT goals_to_connections AS g FROM site_settings'))).toEqual([{ g: 0 }]);
  });
});

describe('whose goal', () => {
  beforeEach(async () => {
    await connected();
    await updateSiteSettings(env.DB, { namesToConnections: true, goalsToConnections: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('only a member with a display name: a name given, changed, cleared or removed re-keys their goal entries', async () => {
    const ravi = await named('u-ravi', null);
    await setGoal(env.DB, ravi.id, thisYear(), 2, actor(ravi));
    await finished(ravi);
    const first = await pull();
    expect(goalLines(first.entries)).toEqual([]); // there's no "A member reached their goal"
    expect(first.entries.some((e) => e.kind === 'finished')).toBe(true); // his finish still goes, unsigned

    await setDisplayName(env.DB, ravi.id, 'Ravi');
    const namedPage = await pull(first.latest);
    expect(goalLines(namedPage.entries)).toEqual([`Ravi goal_set 0/2 ${thisYear()}`, `Ravi goal_halfway 1/2 ${thisYear()}`]);
    const recorded = (await rows<{ at: string }>("SELECT at FROM member_activity WHERE kind LIKE 'goal_%' ORDER BY id")).map((r) => r.at);
    expect(namedPage.entries.filter((e) => e.kind.startsWith('goal_')).map((e) => e.published).sort()).toEqual([...recorded].sort()); // dated as recorded

    await setDisplayName(env.DB, ravi.id, 'R. K.');
    const held = goalIds(namedPage.entries);
    expect(await check(held)).toEqual(held);
    expect(goalLines((await pull(namedPage.latest)).entries)).toEqual([`R. K. goal_set 0/2 ${thisYear()}`, `R. K. goal_halfway 1/2 ${thisYear()}`]);

    await setDisplayName(env.DB, ravi.id, null);
    expect(goalLines((await pull()).entries)).toEqual([]);

    await setDisplayName(env.DB, ravi.id, 'Ravi');
    const again = goalIds((await pull()).entries);
    await deleteUser(env.DB, ravi.id);
    expect(await check(again)).toEqual(again);
    expect(await rows('SELECT id FROM member_activity WHERE goal_id IS NOT NULL')).toEqual([]); // gone with the goal
  });

  it('a changed target replaces the goal’s entries, a deleted goal withdraws them, a deleted finish its milestone', async () => {
    const asha = await named('u-asha', 'Asha', 'admin');
    await setGoal(env.DB, asha.id, thisYear(), 2, actor(asha));
    await finished(asha, { title: 'One' });
    const crossing = await finished(asha, { title: 'Two' });
    const first = await pull();
    const y = thisYear();
    expect(goalLines(first.entries)).toEqual([`Asha goal_set 0/2 ${y}`, `Asha goal_halfway 1/2 ${y}`, `Asha goal_reached 2/2 ${y}`]);
    const old = goalIds(first.entries);

    await setGoal(env.DB, asha.id, y, 4, actor(asha)); // a bigger goal: "reached" isn't true any more
    expect(await check(old)).toEqual(old);
    const changed = await pull(first.latest);
    expect(goalLines(changed.entries)).toEqual([`Asha goal_set 2/4 ${y}`]); // halfway already passed: not announced late
    await finished(asha, { title: 'Three' });
    const last = await finished(asha, { title: 'Four' });
    const reached = await pull(changed.latest);
    expect(goalLines(reached.entries)).toEqual([`Asha goal_reached 4/4 ${y}`]);

    // the finish that reached it deleted: the milestone goes with it
    await env.DB.prepare('DELETE FROM reads WHERE item_id = ?1').bind(last.id).run();
    expect(await check(goalIds(reached.entries))).toEqual(goalIds(reached.entries));
    expect(crossing.id).toBeGreaterThan(0);

    const goal = (await goalOf(env.DB, asha.id, y))!;
    expect(await deleteGoal(env.DB, goal.id, actor(asha))).toBe(true);
    expect(await check(goalIds(changed.entries))).toEqual(goalIds(changed.entries));
    expect(await rows("SELECT id FROM member_activity WHERE kind LIKE 'goal_%'")).toEqual([]);
  });
});

describe('a milestone’s finish undone', () => {
  beforeEach(async () => {
    await connected();
    await updateSiteSettings(env.DB, { namesToConnections: true, goalsToConnections: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  // found by the adversarial pass: a stopped crossing read left its hidden "reached" in the goal's one row of that
  // kind, and the finish that genuinely reached the goal again was never news
  it('goes with it — stopped, reopened or re-dated — so the next finish that crosses the line is news', async () => {
    const asha = await named('u-asha', 'Asha', 'admin');
    const y = thisYear();
    await setGoal(env.DB, asha.id, y, 2, actor(asha));
    await finished(asha, { title: 'One' });
    const two = await finished(asha, { title: 'Two' });
    const first = await pull();
    expect(goalLines(first.entries)).toEqual([`Asha goal_set 0/2 ${y}`, `Asha goal_halfway 1/2 ${y}`, `Asha goal_reached 2/2 ${y}`]);
    const reachedId = first.entries.find((e) => e.kind === 'goal_reached')!.id;

    const readTwo = (await rows<{ id: number }>('SELECT id FROM reads WHERE item_id = ?1', two.id))[0]!.id;
    await env.DB.prepare("UPDATE reads SET status = 'abandoned' WHERE id = ?1").bind(readTwo).run(); // stopped, not finished
    expect(await check([reachedId])).toEqual([reachedId]);
    expect(await rows("SELECT id FROM member_activity WHERE kind = 'goal_reached'")).toEqual([]);

    await finished(asha, { title: 'Three' }); // 2 of 2 again, today: news
    expect(goalLines((await pull(first.latest)).entries)).toEqual([`Asha goal_reached 2/2 ${y}`]);

    // re-dated into last year: no longer this year's finish, and its milestone goes too
    const readThree = (await rows<{ id: number }>("SELECT r.id FROM reads r JOIN items i ON i.id = r.item_id WHERE i.title = 'Three'"))[0]!.id;
    await env.DB.prepare('UPDATE reads SET ended_on = ?2 WHERE id = ?1').bind(readThree, `${y - 1}-12-30`).run();
    expect(await rows("SELECT id FROM member_activity WHERE kind = 'goal_reached'")).toEqual([]);
    // and a finish that stays a finish of the same year keeps its milestone when its date moves within the year
    await setGoal(env.DB, asha.id, y, 3, actor(asha)); // 1 of 3 (One)
    const four = await finished(asha, { title: 'Four' }); // 2 of 3: halfway
    expect(await goalRowKinds()).toEqual(['goal_set', 'goal_halfway']);
    await env.DB.prepare('UPDATE reads SET ended_on = ?2 WHERE item_id = ?1').bind(four.id, `${y}-01-01`).run();
    expect(await goalRowKinds()).toEqual(['goal_set', 'goal_halfway']);
  });
});

// ---------- compatibility, both ways ----------

describe('a line crossed without news', () => {
  beforeEach(async () => {
    await connected();
    await updateSiteSettings(env.DB, { namesToConnections: true, goalsToConnections: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  // the owner's choice (§16 #49): a back-dated or imported finish that crosses a line is no news itself, but the next
  // finish that is news announces the line, with the count as it then stands
  it('is announced by the next live finish — "reached" at 5 of 4 — and only once', async () => {
    const asha = await named('u-asha', 'Asha', 'admin');
    const y = thisYear();
    if (daysAgo(6).slice(0, 4) !== String(y)) return; // the first days of January: back-dated finishes would count toward last year
    await setGoal(env.DB, asha.id, y, 4, actor(asha));
    await finished(asha, { title: 'One' });
    await finished(asha, { title: 'Two' }, daysAgo(1)); // halfway, as it happens
    await finished(asha, { title: 'Three' }, daysAgo(5)); // back-dated: no news
    await finished(asha, { title: 'Four' }, daysAgo(6)); // back-dated, and it crosses the target: still no news
    expect(goalLines((await pull()).entries)).toEqual([`Asha goal_set 0/4 ${y}`, `Asha goal_halfway 2/4 ${y}`]);

    await finished(asha, { title: 'Five' }); // live: the line crossed silently is news now
    const after = goalLines((await pull()).entries);
    expect(after).toEqual([`Asha goal_set 0/4 ${y}`, `Asha goal_halfway 2/4 ${y}`, `Asha goal_reached 5/4 ${y}`]);
    await finished(asha, { title: 'Six' }); // and never again
    expect(goalLines((await pull()).entries)).toEqual(after);
  });

  it('announces a halfway crossed silently at the next live finish below the target', async () => {
    const asha = await named('u-asha', 'Asha', 'admin');
    const y = thisYear();
    if (daysAgo(6).slice(0, 4) !== String(y)) return;
    await setGoal(env.DB, asha.id, y, 6, actor(asha));
    for (const [i, d] of [5, 6, 7].entries()) await finished(asha, { title: `Old ${i}` }, daysAgo(d)); // 3 of 6, silently
    expect(goalLines((await pull()).entries)).toEqual([`Asha goal_set 0/6 ${y}`]);
    await finished(asha, { title: 'Four' });
    expect(goalLines((await pull()).entries)).toEqual([`Asha goal_set 0/6 ${y}`, `Asha goal_halfway 4/6 ${y}`]);
  });
});

describe('compatibility: the protocol stays version 1', () => {
  beforeEach(async () => {
    await connected();
    await updateSiteSettings(env.DB, { namesToConnections: true, goalsToConnections: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A page this version serves with goal entries among the others, the newest entry by id being a goal's. */
  async function servedPage() {
    const asha = await named('u-asha', 'Asha', 'admin');
    await finished(asha, { title: 'Before the goal', rating: 8 });
    const opening = await pull();
    await setGoal(env.DB, asha.id, thisYear(), 4, actor(asha));
    await finished(asha, { title: 'After' }); // a finish, then the halfway it made: 2 of 4
    const body = await (await a.signedGet(`/federation/feed?view=${viewId}&since=${opening.latest}`, peer)).json();
    return body as Page;
  }

  it('(a) a household on 1.3.0 skips goal entries one by one, keeping the rest of the page and moving its cursor past them', async () => {
    const page = await servedPage();
    const kinds = page.entries.map((e) => e.kind);
    expect(kinds).toEqual(['goal_set', 'finished', 'goal_halfway']); // after the cursor, by id
    expect(page.latest).toBe(page.entries.at(-1)!.id); // and the newest is a goal's

    const old = v130.parseFeedPage(page)!; // v1.3.0's own code
    expect(old).not.toBeNull(); // the page itself is fine to it
    expect(old.entries.map((e) => e.kind)).toEqual(['finished']);
    expect(old.entries[0]!.id).toBe(page.entries[1]!.id);
    expect(old.entries[0]!.item.title).toBe('After');
    // v1.3.0's refreshSubscription stores `cursor: page.latest` whatever it kept, so its next pull starts after the
    // goal entries — they are never asked for again — and its daily allowance counts only the one it kept
    expect(old.latest).toBe(page.latest);
    expect(old.latest).toBeGreaterThan(old.entries[0]!.id);
    // one by one: each goal entry alone is dropped by v1.3.0's entry parser, never mistaken for anything else
    for (const e of page.entries.filter((x) => x.kind.startsWith('goal_'))) expect(v130.parseFeedEntry(e)).toBeNull();
    // and it never needed an item on a goal: even one with a stray item of a known kind's shape is refused by kind
    const goal = page.entries[0]!;
    expect(v130.parseFeedEntry({ ...goal, item: { ...old.entries[0]!.item } })).toBeNull();
  });

  it('(b) this version reads goal entries — and still wants an item on every other kind', () => {
    const goal = { id: MEMBER_ACTIVITY_BASE + 4, kind: 'goal_reached', published: sqlAgo(3), goal: { by: 'Priya', year: 2026, target: 24, count: 24 } };
    expect(parseFeedEntry(goal)).toEqual(goal as GoalFeedEntry);
    expect(parseFeedPage({ latest: goal.id, more: false, entries: [goal] })!.entries).toEqual([goal]);
    const bad = (over: Record<string, unknown>) => parseFeedEntry({ ...goal, goal: { ...goal.goal, ...over } });
    for (const over of [{ by: undefined }, { by: '' }, { by: '  ' }, { by: 42 }, { by: 'x'.repeat(81) }, { year: 99 }, { year: '2026' },
      { target: 0 }, { target: 1001 }, { target: 2.5 }, { count: -1 }, { count: 100_001 }]) {
      expect(bad(over), JSON.stringify(over)).toBeNull();
    }
    expect(parseFeedEntry({ ...goal, goal: undefined })).toBeNull();
    expect(parseFeedEntry({ ...goal, kind: 'goal_abandoned' })).toBeNull(); // an unknown kind, as ever
    expect(parseFeedEntry({ ...goal, goal: { ...goal.goal, by: 'Pri‮ya' } })).toMatchObject({ goal: { by: 'Pri ya' } });
    // every other kind still needs its item — a goal is no substitute
    for (const kind of ['finished', 'rated', 'reviewed', 'progress', 'started']) {
      expect(parseFeedEntry({ ...goal, kind }), kind).toBeNull();
    }
  });

  it('(c) a household on this version still reads a 1.3.0 feed — and renders goals from a newer one as escaped text, no item card', async () => {
    const connectionId = (await rows<{ id: number }>('SELECT id FROM connections'))[0]!.id;
    const sub = await createSubscription(env.DB, { connectionId, viewId: 7, viewName: 'All', intervalMinutes: 60, retentionDays: 90, maxEntries: 500 });
    const second = await createSubscription(env.DB, { connectionId, viewId: 8, viewName: 'Books', intervalMinutes: 60, retentionDays: 90, maxEntries: 500 });
    // a page exactly as v1.3.0 serves it: its own serializer, its kinds, no goal
    const theirBook = await book(null, { title: 'Their Piranesi', rating: 8, review: 'A house of tides.' });
    const oldItem = v130.toFeedItem(theirBook, 'reviewed', '0123456789abcdef');
    const oldPage = { view: 7, latest: 3, more: false, entries: [{ id: 3, kind: 'reviewed', published: sqlAgo(30), item: oldItem }] };
    const goalEntry = (id: number, by: string) => ({ id, kind: 'goal_reached', published: sqlAgo(10), goal: { by, year: 2026, target: 12, count: 12 } });
    const newPage = { view: 8, latest: MEMBER_ACTIVITY_BASE + 9, more: false, entries: [goalEntry(MEMBER_ACTIVITY_BASE + 9, '<script>alert(1)</script>')] };
    answerOutbound((req) => {
      const url = new URL(req.url);
      if (url.pathname === '/federation/feed/check') return json({ invalid: [], viewGone: false });
      if (url.pathname === '/federation/feed') return json(url.searchParams.get('view') === '7' ? oldPage : newPage);
      return json({}, 404);
    });
    const cookie = await sessionCookie('member');
    await a.get('/feed', cookie); // pulls one subscription after the response…
    await a.get('/feed', cookie); // …and the other on the next load
    const stored = await rows<{ subscription_id: number; kind: string; item_remote_id: number; item_stamp: string }>(
      'SELECT subscription_id, kind, item_remote_id, item_stamp FROM remote_activities ORDER BY id',
    );
    expect(stored.map((r) => [r.subscription_id, r.kind]).sort()).toEqual([[sub!.id, 'reviewed'], [second!.id, 'goal_reached']].sort());
    expect(stored.find((r) => r.kind === 'goal_reached')).toMatchObject({ item_remote_id: 0, item_stamp: '' });
    expect(await rows('SELECT cursor FROM feed_subscriptions ORDER BY id')).toEqual([{ cursor: 3 }, { cursor: MEMBER_ACTIVITY_BASE + 9 }]);

    // the same goal arriving through a second view shows once
    await env.DB.prepare(
      `INSERT INTO remote_activities (subscription_id, remote_id, item_remote_id, item_stamp, kind, published_at, item, bytes)
       SELECT ?1, remote_id, item_remote_id, item_stamp, kind, published_at, item, bytes FROM remote_activities WHERE kind = 'goal_reached'`,
    ).bind(sub!.id).run();
    const html = (await (await a.get('/feed', cookie)).text()).replace(/\s+/g, ' ');
    expect(html).toContain('Their Piranesi'); // the 1.3.0 entry, as ever
    expect(html).toContain('A house of tides.');
    expect(html).toContain('<span class="feed-by">&lt;script&gt;alert(1)&lt;/script&gt; </span><span class="muted">reached their 2026 goal</span>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html.match(/reached their 2026 goal/g)).toHaveLength(1);
    const goalCard = html.slice(html.indexOf('<article class="feed-card feed-goal">'));
    expect(goalCard.slice(0, goalCard.indexOf('</article>'))).not.toContain('feed-cover'); // no item card
    expect(goalCard).toContain('<span class="goal-count">12 of 12</span>');
  });

  it('changes nothing else a connection sees: the descriptor, item pages and the check keep their shape', async () => {
    const asha = await named('u-asha', 'Asha', 'admin');
    const item = await finished(asha, { title: 'Piranesi', rating: 8, review: 'Tides.' });
    await setGoal(env.DB, asha.id, thisYear(), 2, actor(asha));
    const seen = async () => [
      await (await a.get('/.well-known/nalanda')).text(),
      await (await a.signedGet(`/federation/item?view=${viewId}&id=${item.id}`, peer)).text(),
      await (await a.signedPost('/federation/feed/check', peer, { view: viewId, ids: [MEMBER_ACTIVITY_BASE + 999] })).text(),
    ];
    const withGoals = await seen();
    await setGoalsToConnections(env.DB, false);
    await env.DB.prepare('DELETE FROM reading_goals').run();
    expect(await seen()).toEqual(withGoals);
    expect(JSON.parse(withGoals[0]!).version).toBe(1);
    expect(withGoals[1]).not.toContain('goal');
    expect(Object.keys(JSON.parse(withGoals[2]!)).sort()).toEqual(['invalid', 'viewGone']);
  });
});

describe('D1 calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keep a feed pull with goals from several members well inside the budget', async () => {
    const keys = await connected();
    await updateSiteSettings(env.DB, { namesToConnections: true, goalsToConnections: true });
    for (let i = 0; i < 8; i++) {
      const m = await named(`u-m${i}`, `Member ${i}`);
      await setGoal(env.DB, m.id, thisYear(), 2, actor(m));
      await finished(m, { title: `Book ${i}` });
      await finished(m, { title: `Book ${i}b` });
    }
    const budget = { left: 1000 };
    const counted = instanceA({ ...env, DB: budgeted(env.DB, budget), FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
    const res = await counted.signedGet(`/federation/feed?view=${viewId}&since=0`, peer);
    const page = (await res.json()) as Page;
    expect(goalLines(page.entries)).toHaveLength(24);
    const pullCalls = 1000 - budget.left;
    expect(pullCalls).toBeLessThanOrEqual(10);
    const before = budget.left;
    await counted.signedPost('/federation/feed/check', peer, { view: viewId, ids: page.entries.map((e) => e.id) });
    expect(before - budget.left).toBeLessThanOrEqual(10);
  });
});

// ---------- the migration ----------

describe('migration 0036', () => {
  it('counts a goal as goalCountSql does, word for word, in both milestone triggers', () => {
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith('0036'))!;
    const text = m.queries.join('\n');
    expect(text.split(goalCountSql('g2')).length - 1).toBe(2);
  });

  it('keeps every entry and its id, and never hands out an id a connection may already hold', async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((x) => x.name < '0036'));
    const asha = await member('u-asha', 'admin');
    await createConnectionView(env.DB, { name: 'All', libraryId: null, mediaType: null, status: null, owned: null });
    // Raw SQL, not book(): a Drizzle insert names every column schema.ts has today, and migrations after 0036 add some
    // (0037's want lists touch no item column; 0038's recommendations none either; 0039's purchase price does) that this database, stopped before 0036, lacks.
    const shelf = await createLibrary(env.DB, 'Household shelf');
    for (const title of ['One', 'Two', 'Three']) {
      const item = await env.DB.prepare("INSERT INTO items (library_id, media_type, title, length, details, added_by) VALUES (?1, 'book', ?2, 300, '{}', ?3) RETURNING id")
        .bind(shelf.id, title, asha.id)
        .first<{ id: number }>();
      await addPastRead(env.DB, item!.id, { status: 'completed', beganOn: null, endedOn: today() }, asha.id);
    }
    const before = await rows<Record<string, unknown>>('SELECT id, item_id, kind, at, read_id, review_id, progress_id FROM member_activity ORDER BY id');
    expect(before).toHaveLength(3);
    // the newest entry withdrawn — its id is still in a connection's hands
    const newest = before.at(-1)!.id as number;
    await env.DB.prepare('DELETE FROM member_activity WHERE id = ?1').bind(newest).run();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await rows('SELECT id, item_id, kind, at, read_id, review_id, progress_id FROM member_activity ORDER BY id')).toEqual(before.slice(0, -1));
    await finished(asha, { title: 'Four' });
    const [next] = await rows<{ id: number }>('SELECT max(id) AS id FROM member_activity');
    expect(next!.id).toBeGreaterThan(newest); // not the withdrawn one's id again
    // and the triggers it re-made record as before
    expect(await rows("SELECT kind FROM member_activity WHERE id = ?1", next!.id)).toEqual([{ kind: 'finished' }]);
  });
});
