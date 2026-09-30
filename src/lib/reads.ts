// Each time a book was read (ARCH.md §16 #41): the rules that turn reads into an item's reading state, the
// legacy mapping from a single status and pair of dates, the export's `reads` cell, and how a Goodreads row
// reconciles with reads already here. Pure functions — src/db/queries.ts holds the SQL twins, and
// test/reads.spec.ts proves each pair agrees.
import type { ItemStatus, ReadStatus } from '../db/schema';
import { READ_STATUSES } from '../db/schema';

export type ReadDraft = { status: ReadStatus; beganOn: string | null; endedOn: string | null };
export type ReadRow = ReadDraft & { id: number };
/**
 * A read on its way in, and whose it is (ARCH.md §16 #43): a member's id, null for nobody here (a member removed
 * since), or left out for whoever brings it in — the person adding the item, or importing the file.
 */
export type PersonRead = ReadDraft & { readerId?: number | null };
/** A read in the export's `reads` cell: its reader by username, null for a member removed since, or left out in an older export. */
export type CellRead = ReadDraft & { reader?: string | null };

/** Enough for anyone — per reader, as `startRead` and `addPastRead` hold it (§16 #43). */
export const MAX_READS_PER_ITEM = 100;
/** A bound on what a crafted CSV can make one row insert, across everyone's reads: ten readers' worth. */
export const MAX_READS_PER_CELL = 1000;

// ---------- ordering ----------
//
// The read that decides an item's status: a finished one if there is any, else the open one, else a stopped
// one — and among those the latest, dated before undated. So a book stays Completed while it's read again
// (the open re-read is `rereading`), and an abandoned re-read leaves it Completed.

const when = (a: string) => `coalesce(${a}.ended_on, ${a}.began_on)`;

/** SQL ORDER BY for the read that decides status, began_on and completed_on. */
export const statusOrderSql = (a: string) =>
  `CASE ${a}.status WHEN 'completed' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, ${when(a)} IS NULL, ${when(a)} DESC, ${a}.id DESC`;

/** SQL ORDER BY for the current read — the open one if any — whose pages are the item's progress. */
export const currentOrderSql = (a: string) => `${a}.status = 'in_progress' DESC, ${statusOrderSql(a)}`;

/** SQL ORDER BY for showing reads: oldest first, undated ones first of all, the open read last. */
export const displayOrderSql = (a: string) => `${a}.status = 'in_progress', ${when(a)} IS NOT NULL, ${when(a)}, ${a}.id`;

// ---------- the Status filter (§16 #64) ----------

/**
 * Does an item fall under a Status filter's value? In progress means being read now: a book in progress, or one
 * finished before and being read again (`rereading`) — which also stays under Completed, since someone finished it.
 * The shelf, share links and connection views all filter this way: statusWhere() in src/db/queries.ts is the SQL
 * twin, and src/db/federation.ts spells it out where a view's own column is the filter.
 */
export function matchesStatus(item: { status: ItemStatus; rereading: boolean }, status: ItemStatus): boolean {
  return item.status === status || (status === 'in_progress' && item.rereading);
}

const RANK: Record<ReadStatus, number> = { completed: 0, in_progress: 1, abandoned: 2 };

/** The TypeScript twin of statusOrderSql. `seq` stands in for the id: a later read in the list is a newer one. */
function byStatusOrder(a: ReadDraft & { seq: number }, b: ReadDraft & { seq: number }): number {
  if (RANK[a.status] !== RANK[b.status]) return RANK[a.status] - RANK[b.status];
  const wa = a.endedOn ?? a.beganOn;
  const wb = b.endedOn ?? b.beganOn;
  if ((wa === null) !== (wb === null)) return wa === null ? 1 : -1;
  if (wa !== null && wb !== null && wa !== wb) return wa < wb ? 1 : -1;
  return b.seq - a.seq;
}

/** The TypeScript twin of displayOrderSql. */
export function inDisplayOrder<T extends ReadDraft & { id: number }>(reads: T[]): T[] {
  return [...reads].sort((a, b) => {
    const oa = a.status === 'in_progress' ? 1 : 0;
    const ob = b.status === 'in_progress' ? 1 : 0;
    if (oa !== ob) return oa - ob;
    const wa = a.endedOn ?? a.beganOn;
    const wb = b.endedOn ?? b.beganOn;
    if ((wa === null) !== (wb === null)) return wa === null ? -1 : 1;
    if (wa !== null && wb !== null && wa !== wb) return wa < wb ? -1 : 1;
    return a.id - b.id;
  });
}

export type ReadState = {
  status: ItemStatus;
  beganOn: string | null;
  completedOn: string | null;
  readCount: number;
  rereading: boolean;
};

/**
 * What the item columns say for a set of reads — the TypeScript twin of refreshReadState(), used where an item
 * is inserted with its reads, so the insert trigger sees the right status and date (migration 0021). Reads are
 * in insertion order.
 */
export function summarizeReads(reads: ReadDraft[]): ReadState {
  const ranked = reads.map((r, seq) => ({ ...r, seq })).sort(byStatusOrder);
  const top = ranked[0];
  const finished = reads.filter((r) => r.status === 'completed').length;
  return {
    status: top?.status ?? 'not_started',
    beganOn: top?.beganOn ?? null,
    completedOn: top?.endedOn ?? null,
    readCount: finished,
    rereading: finished > 0 && reads.some((r) => r.status === 'in_progress'),
  };
}

// ---------- dates ----------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * A real calendar date in YYYY-MM-DD — 2026-02-30 is not one. By arithmetic rather than a Date round trip, which cost
 * about a microsecond a date: an import page of loans checks thousands of them (§16 #57).
 */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= (month === 2 && leap ? 29 : MONTH_DAYS[month - 1]!);
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * The latest date a read can carry: tomorrow in UTC, because the server's day is UTC and a household east of it
 * reaches tomorrow first — refusing someone's real today would be worse than allowing a day's slack.
 */
export function latestReadDate(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

/** Why a read's dates can't stand, or null. `status` decides whether an end date is allowed. */
export function readDateProblem(read: ReadDraft): string | null {
  for (const d of [read.beganOn, read.endedOn]) {
    if (d !== null && !isIsoDate(d)) return 'Give dates as a calendar date.';
    if (d !== null && d > latestReadDate()) return 'A read can’t be dated in the future.';
  }
  if (read.status === 'in_progress' && read.endedOn !== null) return 'A read still in progress has no end date.';
  if (read.beganOn !== null && read.endedOn !== null && read.endedOn < read.beganOn) {
    return 'A read can’t end before it began.';
  }
  return null;
}

// ---------- the legacy mapping ----------

const blank = (v: string | null | undefined) => (v === null || v === undefined || v.trim() === '' ? null : v.trim());

/**
 * The reads one status and pair of dates stand for — migration 0023's mapping, and how a libib row or an
 * older Nalanda export arrives. A date is evidence: a completion date on a book marked not started is a
 * finished read, a start date alone one in progress. In progress with a completion date is a book finished
 * before and being read again; its start date goes with whichever read it precedes.
 */
export function readsFromColumns(status: ItemStatus, began: string | null | undefined, completed: string | null | undefined): ReadDraft[] {
  const b = blank(began);
  const c = blank(completed);
  switch (status) {
    case 'completed':
    case 'abandoned':
      return [{ status, beganOn: b, endedOn: c }];
    case 'in_progress':
      if (c === null) return [{ status: 'in_progress', beganOn: b, endedOn: null }];
      return b !== null && b <= c
        ? [
            { status: 'completed', beganOn: b, endedOn: c },
            { status: 'in_progress', beganOn: null, endedOn: null },
          ]
        : [
            { status: 'completed', beganOn: null, endedOn: c },
            { status: 'in_progress', beganOn: b, endedOn: null },
          ];
    default:
      if (c !== null) return [{ status: 'completed', beganOn: b, endedOn: c }];
      if (b !== null) return [{ status: 'in_progress', beganOn: b, endedOn: null }];
      return [];
  }
}

/** Undated finished reads added until `count` are finished — how a read count without dates arrives. */
export function topUpReads(reads: ReadDraft[], count: number | null | undefined): ReadDraft[] {
  if (!count || !Number.isSafeInteger(count) || count < 1) return reads;
  const target = Math.min(count, MAX_READS_PER_ITEM);
  const finished = reads.filter((r) => r.status === 'completed').length;
  const room = MAX_READS_PER_ITEM - reads.length;
  const extra = Math.max(0, Math.min(target - finished, room));
  return [...reads, ...Array.from({ length: extra }, () => ({ status: 'completed' as const, beganOn: null, endedOn: null }))];
}

// ---------- the export's `reads` cell ----------
//
// Oldest first, semicolon-separated, each `status:began..ended@reader` with a blank side for a date not known:
//   completed:..2019-03-20@asha;completed:2024-01-05..2024-02-01@asha;in_progress:2026-09-28..@ravi
// The reader is a username, percent-encoded so no name can break the cell; nothing after the `@` means a member
// removed since. A token with no `@` at all is from an export before readers (1.2.x), whose reads belong to whoever
// imports it. Nothing in the cell needs CSV quoting.

export function formatReadsCell(reads: CellRead[]): string {
  return reads
    .map((r) => `${r.status}:${r.beganOn ?? ''}..${r.endedOn ?? ''}${r.reader === undefined ? '' : `@${r.reader === null ? '' : encodeURIComponent(r.reader)}`}`)
    .join(';');
}

const READ_TOKEN = /^(in_progress|completed|abandoned):(.*?)\.\.(.*)$/;

/** The reader part of a token: undefined without an `@`, null for an empty name, else the name. */
function readerOf(token: string): { rest: string; reader?: string | null } {
  const at = token.lastIndexOf('@');
  if (at < 0) return { rest: token };
  const raw = token.slice(at + 1).trim();
  let reader: string | null = null;
  if (raw) {
    try {
      reader = decodeURIComponent(raw);
    } catch {
      reader = raw; // not our encoding — someone typed a name by hand; take it as written
    }
  }
  return { rest: token.slice(0, at), reader };
}

/**
 * A `reads` cell back into reads. A part that doesn't parse is dropped and the rest kept; a date that isn't a
 * calendar date becomes unknown and its read stays, as the export's date columns always have; a reader's second
 * open read, which the database refuses, is dropped — but not a former member's: several removed members can each
 * have had one open, and the database holds them. At most MAX_READS_PER_ITEM a reader and MAX_READS_PER_CELL in all.
 * Readers stay names here: the importer knows its members (attributePeople in csv.ts).
 */
export function parseReadsCell(cell: string | null | undefined): CellRead[] {
  const out: CellRead[] = [];
  const open = new Set<string | undefined>();
  const each = new Map<string | null | undefined, number>();
  for (const part of (cell ?? '').split(';')) {
    const { rest, reader } = readerOf(part.trim());
    const m = READ_TOKEN.exec(rest.trim());
    if (!m) continue;
    const status = m[1] as ReadStatus;
    const beganOn = isIsoDate(m[2]!.trim()) ? m[2]!.trim() : null;
    const endedOn = status !== 'in_progress' && isIsoDate(m[3]!.trim()) ? m[3]!.trim() : null;
    if (status === 'in_progress' && reader !== null) {
      if (open.has(reader)) continue;
      open.add(reader);
    }
    const n = each.get(reader) ?? 0;
    if (n >= MAX_READS_PER_ITEM) continue;
    each.set(reader, n + 1);
    out.push(reader === undefined ? { status, beganOn, endedOn } : { status, beganOn, endedOn, reader });
    if (out.length === MAX_READS_PER_CELL) break;
  }
  return out;
}

/**
 * Reads whose readers are known as ids, as the database will take them: each person held to one open read — two
 * names that turn out to be the same person here (both unknown, so both the importer's) could otherwise bring two,
 * and the database refuses a second — and to MAX_READS_PER_ITEM, and the row to MAX_READS_PER_CELL. The later are
 * dropped, as parseReadsCell drops them within a name. A read with no reader (a former member's) isn't held to one
 * open read: the unique index treats NULLs as distinct, and a round trip keeps every one. `fallback` is whose a read
 * that names nobody is.
 */
export function oneOpenReadEach<T extends PersonRead>(reads: T[], fallback: number | null): { reads: T[]; dropped: number } {
  const open = new Set<number>();
  const each = new Map<number | null, number>();
  const kept: T[] = [];
  for (const r of reads) {
    const who = r.readerId === undefined ? fallback : r.readerId;
    if (r.status === 'in_progress' && who !== null) {
      if (open.has(who)) continue;
      open.add(who);
    }
    const n = each.get(who) ?? 0;
    if (n >= MAX_READS_PER_ITEM) continue;
    each.set(who, n + 1);
    kept.push(r);
    if (kept.length === MAX_READS_PER_CELL) break;
  }
  return { reads: kept, dropped: reads.length - kept.length };
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

// ---------- Goodreads ----------

/** What a Goodreads row says about reading: its shelf, as a status, and the dates and count it carries. */
export type GoodreadsReading = {
  shelf: ItemStatus; // read → completed, currently-reading → in_progress, dnf → abandoned, anything else → not_started
  dateRead: string | null;
  dateStarted: string | null;
  readCount: number | null;
};

export type ReadOp = { op: 'insert'; read: ReadDraft } | { op: 'update'; id: number; read: ReadDraft };

/**
 * How a Goodreads row meets the reads already here: it adds what's missing and never removes a read — a to-read
 * shelf over there doesn't undo a read recorded here. Every rule checks for its own result first, and reading done
 * here since an earlier import counts as that result, so importing the same file again adds nothing, even after
 * a read here was finished, stopped or started again. `existing` may be empty: a new book's reads come from the
 * same rules.
 *
 * 1. Date Read (not on a DNF shelf) is a finish: nothing if a finished read already ends then; on the read shelf,
 *    it closes an open read that began by then; otherwise it dates an undated finished read that began by then,
 *    or adds one. On currently-reading it is the previous finish, so the open read stays open.
 * 2. The read shelf with no finished read: the open read closes, undated, or an undated finish is added.
 * 3. Currently-reading: an open read, starting on Date Started — unless one is open, or a read here began on or
 *    after Date Started, or (without it) ended after the last finish Goodreads knows: that read was this one.
 * 4. DNF: nothing if a stopped read is here already. Otherwise an open read that began by the DNF's date is
 *    stopped then (never before it began); failing that, a stopped read is added.
 * 5. Read Count: undated finished reads until that many are finished.
 */
export function reconcileGoodreads(existing: ReadRow[], g: GoodreadsReading): ReadOp[] {
  type Working = ReadDraft & { id: number | null; changed: boolean };
  const work: Working[] = existing.map((r) => ({ ...r, changed: false }));
  const add = (read: ReadDraft) => work.push({ ...read, id: null, changed: true });
  const set = (r: Working, patch: Partial<ReadDraft>) => Object.assign(r, patch, { changed: true });
  const open = () => work.find((r) => r.status === 'in_progress');
  const d = isIsoDate(g.dateRead) ? g.dateRead : null;
  const s = isIsoDate(g.dateStarted) ? g.dateStarted : null;

  if (d && g.shelf !== 'abandoned') {
    if (!work.some((r) => r.status === 'completed' && r.endedOn === d)) {
      const current = open();
      // an undated finish that began after Date Read can't be the one that ended then
      const undated = work.find((r) => r.status === 'completed' && r.endedOn === null && (r.beganOn === null || r.beganOn <= d));
      const startedByThen = s !== null && s <= d ? s : null;
      if (g.shelf === 'completed' && current && (current.beganOn === null || current.beganOn <= d)) {
        set(current, { status: 'completed', endedOn: d, beganOn: current.beganOn ?? startedByThen });
      } else if (undated) {
        set(undated, { endedOn: d, beganOn: undated.beganOn ?? (g.shelf === 'completed' ? startedByThen : null) });
      } else {
        add({ status: 'completed', beganOn: g.shelf === 'completed' ? startedByThen : null, endedOn: d });
      }
    }
  }
  if (g.shelf === 'completed' && !work.some((r) => r.status === 'completed')) {
    const current = open();
    if (current) set(current, { status: 'completed', endedOn: null });
    else add({ status: 'completed', beganOn: s, endedOn: null });
  }
  if (g.shelf === 'in_progress' && !open()) {
    // Goodreads' current read already here and since finished or stopped: a read that began on or after its start,
    // or — with no start date — one that ended after the last finish Goodreads knows about
    const sinceHere = work.some((r) =>
      s !== null ? r.beganOn !== null && r.beganOn >= s : r.status !== 'in_progress' && r.endedOn !== null && (d === null || r.endedOn > d),
    );
    if (!sinceHere) add({ status: 'in_progress', beganOn: s !== null && (d === null || s >= d) ? s : null, endedOn: null });
  }
  if (g.shelf === 'abandoned' && !work.some((r) => r.status === 'abandoned')) {
    const current = open();
    const evidence = d ?? s;
    if (current && (current.beganOn === null || evidence === null || current.beganOn <= evidence)) {
      set(current, { status: 'abandoned', endedOn: d !== null && (current.beganOn === null || d >= current.beganOn) ? d : null });
    } else {
      // an earlier attempt, stopped over there — a read started here since stays open
      add({ status: 'abandoned', beganOn: s, endedOn: d !== null && (s === null || d >= s) ? d : null });
    }
  }
  const topped = topUpReads(work, g.readCount);
  for (const extra of topped.slice(work.length)) add(extra);

  return work
    .filter((r) => r.changed)
    .map((r) => {
      const read = { status: r.status, beganOn: r.beganOn, endedOn: r.endedOn };
      return r.id === null ? { op: 'insert' as const, read } : { op: 'update' as const, id: r.id, read };
    });
}

export const isReadStatus = (v: unknown): v is ReadStatus => (READ_STATUSES as readonly unknown[]).includes(v);
