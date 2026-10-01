// Reading goals (ARCH.md §16 #49): N books in a year, per member. What counts — every finished read of a book by that
// member with its end date in that year, re-reads included — is SQL (goalCountSql in src/db/queries.ts, and the same
// expression in migration 0036's milestone triggers); this module is the arithmetic around it.

/** The most books a goal can ask for: a book a day for nearly three years, far past any real goal. */
export const MAX_GOAL_TARGET = 1000;

/** Halfway through a goal, in whole books: 12 of 24, 13 of 25, 1 of 1. */
export const halfOf = (target: number) => Math.ceil(target / 2);

export type GoalPace =
  | { state: 'reached' }
  | { state: 'on_track' } // exactly where a year-long pace is today, in whole books
  | { state: 'ahead'; by: number }
  | { state: 'behind'; by: number }
  | { state: 'upcoming' } // a goal for a year that hasn't started
  | { state: 'missed' }; // a year that has ended short of it

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Where a goal stands on `today` (YYYY-MM-DD, the device's day, §16 #69). Pace is linear through the year, from 1 January
 * whenever the goal was set: by the end of day d of a year of D days, d/D of the target — rounded down, so a goal is on
 * pace until it is a whole book behind, and ahead once it is a whole book past.
 */
export function goalPace(count: number, target: number, year: number, today: string): GoalPace {
  if (count >= target) return { state: 'reached' };
  const thisYear = Number(today.slice(0, 4));
  if (year > thisYear) return { state: 'upcoming' };
  if (year < thisYear) return { state: 'missed' };
  const start = Date.UTC(year, 0, 1);
  const day = Math.floor((Date.parse(`${today}T00:00:00Z`) - start) / 86_400_000) + 1; // 1 on 1 January
  const expected = Math.floor((target * day) / (isLeap(year) ? 366 : 365));
  if (count > expected) return { state: 'ahead', by: count - expected };
  return count === expected ? { state: 'on_track' } : { state: 'behind', by: expected - count };
}

/**
 * "on pace", "3 behind pace", "2 ahead of pace", "reached" — the words beside a goal's count. "Pace" says what it is
 * behind: a year-long pace from 1 January, so a goal set in September starts behind it (the meter says so under the
 * bar). Short enough for a pill at phone width.
 */
export function paceLabel(pace: GoalPace): string {
  switch (pace.state) {
    case 'reached':
      return 'reached';
    case 'on_track':
      return 'on pace';
    case 'ahead':
      return `${pace.by} ahead of pace`;
    case 'behind':
      return `${pace.by} behind pace`;
    case 'upcoming':
      return 'not started yet';
    case 'missed':
      return 'year ended';
  }
}

/** How far through the target, as a whole percentage for a bar: 0–100. */
export const goalPercent = (count: number, target: number) => Math.min(100, Math.floor((count / Math.max(1, target)) * 100));

/** Where linear pace stands today, as a percentage of the bar — the tick a goal is measured against. Null outside its year. */
export function pacePercent(year: number, today: string): number | null {
  if (Number(today.slice(0, 4)) !== year) return null;
  const day = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  return Math.min(100, Math.round((day / (isLeap(year) ? 366 : 365)) * 100));
}

/** A goal's target from a form: a whole number of books, 1 to MAX_GOAL_TARGET; null when it isn't one. */
export function parseGoalTarget(raw: unknown): number | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_GOAL_TARGET ? n : null;
}

/** The years a goal can be set for on `today`: this one and the next. Earlier goals stay, to look back on or delete. */
export function settableYears(today: string): number[] {
  const y = Number(today.slice(0, 4));
  return [y, y + 1];
}
