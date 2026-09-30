// The household's play log (ARCH.md §16 #54): each time a board game was played or a record was put on, dated by the
// day. A play is the household's, not a person's, and nothing about an item's status depends on it. Pure functions:
// which items take plays, how a date is checked and shown, and the export's `plays` cell.
import type { MediaType } from '../db/schema';
import { isIsoDate, latestReadDate } from './reads';

/** What gets a "Played" button: board games (a play log) and records (a listening log). Books have reads instead. */
export const PLAYABLE_TYPES: readonly MediaType[] = ['boardgame', 'vinyl'];
export const isPlayable = (mediaType: MediaType): boolean => PLAYABLE_TYPES.includes(mediaType);

/**
 * At most this many plays an item — a game played every day for thirteen years. The app stops logging past it and an
 * import keeps the first this many of a row, so no item's export cell or page can grow without bound.
 */
export const MAX_PLAYS_PER_ITEM = 5000;

/** How many of an item's plays its page lists, newest first; the rest are on its plays page. */
export const RECENT_PLAYS = 5;

/** Why a play can't be dated `on`, or null. Tomorrow is allowed, as for reads: a household east of UTC reaches it first. */
export function playDateProblem(on: string): string | null {
  if (!isIsoDate(on)) return 'Give the date a play was on, as a calendar date.';
  if (on > latestReadDate()) return 'A play can’t be dated in the future.';
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14 Sep" in `today`'s year, "14 Sep 2025" in any other — a play log reads by the day, and this year is implied. */
export function playDate(on: string, today: string): string {
  const [y, m, d] = on.split('-');
  const day = `${Number(d)} ${MONTHS[Number(m) - 1] ?? m}`;
  return y === today.slice(0, 4) ? day : `${day} ${y}`;
}

/** "once", then "N times". */
export const timesPlayed = (n: number): string => (n === 1 ? 'once' : `${n} times`);

// ---------- the export's `plays` cell ----------

/** A play in the export: its date, and who logged it — a username, null for a member removed since, or left out. */
export type CellPlay = { playedOn: string; by?: string | null };
/** A play on its way in, with who logged it as an id here: null for nobody, or left out for whoever imports it. */
export type PersonPlay = { playedOn: string; loggedBy?: number | null };

/**
 * `2026-09-14@asha;2026-09-20@` — oldest first, each date with who logged it, percent-encoded as the reads cell's
 * readers are (so no name can break the cell), empty for a member removed since.
 */
export function formatPlaysCell(plays: CellPlay[]): string {
  return plays.map((p) => `${p.playedOn}${p.by === undefined ? '' : `@${p.by === null ? '' : encodeURIComponent(p.by)}`}`).join(';');
}

/**
 * A `plays` cell back into plays. A part that isn't a calendar date — or is one in the future — is dropped and the rest
 * kept; at most MAX_PLAYS_PER_ITEM. No `@` names nobody (the importer's), an empty name a former member. Names stay
 * names here: the importer knows its members (attributePeople in csv.ts).
 */
export function parsePlaysCell(cell: string | null | undefined): CellPlay[] {
  const out: CellPlay[] = [];
  const latest = latestReadDate();
  for (const part of (cell ?? '').split(';')) {
    const token = part.trim();
    if (!token) continue;
    const at = token.indexOf('@');
    const playedOn = (at < 0 ? token : token.slice(0, at)).trim();
    if (!isIsoDate(playedOn) || playedOn > latest) continue;
    if (at < 0) {
      out.push({ playedOn });
    } else {
      const raw = token.slice(at + 1).trim();
      let by: string | null = null;
      if (raw) {
        try {
          by = decodeURIComponent(raw);
        } catch {
          by = raw; // not our encoding — typed by hand; take it as written
        }
      }
      out.push({ playedOn, by });
    }
    if (out.length === MAX_PLAYS_PER_ITEM) break;
  }
  return out;
}
