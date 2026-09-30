// Board games' own rules (ARCH.md §16 #60): what "What should we play tonight?" filters on, and what "Refresh from
// BGG" may fill. A game's facts live in its `details` JSON under the keys BGG's provider writes — bgg_id,
// players_min, players_max, playtime_min, playtime_max and weight — so they round-trip through the CSV's details
// column with no migration. No network and no D1 here: src/metadata/bgg.ts fetches, src/db/queries.ts filters.
import type { Item } from '../db/schema';
import type { Candidate } from '../metadata/provider';
import { isBlank } from './pressing';
import { parseDetails } from './share';

/** The weight bands on BGG's 1–5 complexity scale: light below 2, medium from 2 to below 3, heavy from 3. */
export const WEIGHTS = ['light', 'medium', 'heavy'] as const;
export type Weight = (typeof WEIGHTS)[number];

/** Each band's range, `from` inclusive and `below` exclusive — the query and the page read the same numbers. */
export const WEIGHT_BANDS: Record<Weight, { from: number; below: number }> = {
  light: { from: 1, below: 2 },
  medium: { from: 2, below: 3 },
  heavy: { from: 3, below: 6 }, // 5 is the top of BGG's scale; `below` only has to clear it
};

export const WEIGHT_LABEL: Record<Weight, string> = { light: 'Light', medium: 'Medium', heavy: 'Heavy' };

/** Which band a weight falls in, or null for none (no votes, or off the scale). */
export function weightBand(w: number | null | undefined): Weight | null {
  if (typeof w !== 'number' || !Number.isFinite(w) || w < 1 || w > 5) return null;
  return WEIGHTS.find((k) => w >= WEIGHT_BANDS[k].from && w < WEIGHT_BANDS[k].below) ?? null;
}

/** The time choices the form offers, in minutes. Any whole number of minutes up to a day works from the URL. */
export const TIME_CHOICES = [20, 30, 45, 60, 90, 120, 180, 240] as const;
export const MAX_MINUTES = 24 * 60;
export const MAX_PLAYERS = 99;

/** "45 min", "1 hour", "1½ hours", "3 hours". */
export function minutesLabel(m: number): string {
  if (m < 60) return `${m} min`;
  if (m % 60 === 0) return m === 60 ? '1 hour' : `${m / 60} hours`;
  if (m % 30 === 0) return `${Math.floor(m / 60)}½ hours`;
  return `${m} min`;
}

/** What the household asked for: each null means "any". */
export type GameFilters = { players: number | null; minutes: number | null; weight: Weight | null };

const whole = (raw: string | undefined, max: number): number | null => {
  const t = (raw ?? '').trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= max ? n : null;
};

/** The filters from a query string. Anything that isn't one of the allowed values reads as "any", never an error. */
export function parseGameFilters(q: Record<string, string | undefined>): GameFilters {
  const w = q['weight'];
  return {
    players: whole(q['players'], MAX_PLAYERS),
    minutes: whole(q['time'], MAX_MINUTES),
    weight: (WEIGHTS as readonly string[]).includes(w ?? '') ? (w as Weight) : null,
  };
}

/** The filters as a query string, for links and the "Pick another" form: only what's set, in a fixed order. */
export function gameFilterParams(f: GameFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.players !== null) p.set('players', String(f.players));
  if (f.minutes !== null) p.set('time', String(f.minutes));
  if (f.weight !== null) p.set('weight', f.weight);
  return p;
}

export const anyFilter = (f: GameFilters): boolean => f.players !== null || f.minutes !== null || f.weight !== null;

/**
 * A game's BGG id from its details — a positive whole number, or digits typed as text (a libib import keeps every
 * value as text). Null when there is none to look it up by.
 */
export function bggIdOf(details: Record<string, unknown>): number | null {
  const v = details['bgg_id'];
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,12}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Everything "Refresh from BGG" may write, and nothing else: these details keys, and `length` while it is blank. */
export const GAME_FILL_KEYS = ['players_min', 'players_max', 'playtime_min', 'playtime_max', 'weight'] as const;

export type GameFill = {
  details: string;
  length: number | null;
  /** The details keys and columns that changed, in a stable order — empty when there was nothing to fill. */
  filled: string[];
};

/**
 * Fills a game's blanks from BGG's record of it (ARCH.md §16 #60, on the pattern of #55's pressing refresh): a key is
 * written only while it is blank — absent, null, empty text — so anything with a value stays exactly as it is,
 * whoever put it there. `length` (BGG's playing time, in minutes) fills only while the column is empty. Title,
 * creators, publisher, description, cover, bgg_id and everything else are never touched.
 */
export function fillGame(item: Pick<Item, 'details' | 'length'>, game: Candidate): GameFill {
  const details = parseDetails(item.details);
  const filled: string[] = [];
  // details that don't read as an object (hand-made, broken) are left alone: writing ours would replace them
  const raw = (item.details ?? '').trim();
  if (raw && raw !== '{}' && !Object.keys(details).length) return { details: item.details, length: item.length, filled };
  for (const k of GAME_FILL_KEYS) {
    const v = game.details[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (!isBlank(details[k])) continue;
    details[k] = v;
    filled.push(k);
  }
  let length = item.length;
  if ((length === null || length === undefined) && typeof game.length === 'number' && game.length > 0) {
    length = game.length;
    filled.push('length');
  }
  return { details: JSON.stringify(details), length: length ?? null, filled };
}
