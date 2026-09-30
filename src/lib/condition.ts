// A record's condition: media and sleeve, graded by hand on the Goldmine scale Discogs uses (ARCH.md §16 #55).
// It describes this household's copy, like `copies`, so it is in no whitelist: share pages and connections never
// see it. Stored as the grade's code; read back from a form or a CSV cell by code or by Discogs' own wording.
import { MEDIA_GRADES, SLEEVE_GRADES, type MediaGrade, type MediaType, type SleeveGrade } from '../db/schema';

/** Discogs' own wording for each grade, as its marketplace and collection export write them. */
export const GRADE_NAME: Record<SleeveGrade, string> = {
  M: 'Mint (M)',
  NM: 'Near Mint (NM or M-)',
  'VG+': 'Very Good Plus (VG+)',
  VG: 'Very Good (VG)',
  'G+': 'Good Plus (G+)',
  G: 'Good (G)',
  F: 'Fair (F)',
  P: 'Poor (P)',
  Generic: 'Generic',
  'No Cover': 'No Cover',
};

/** Which items take a grade: records, the media Discogs catalogues. A book or a game has no Goldmine grade. */
export const isRecord = (mediaType: MediaType | null | undefined): boolean => mediaType === 'vinyl' || mediaType === 'music';

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// code, Discogs' wording, and the one alias Discogs itself gives (NM "or M-"), all matched case-insensitively
const LOOKUP = new Map<string, SleeveGrade>();
for (const g of SLEEVE_GRADES) {
  LOOKUP.set(key(g), g);
  LOOKUP.set(key(GRADE_NAME[g]), g);
}
LOOKUP.set('m-', 'NM');

/**
 * A grade from a form or a CSV cell: `null` for none (blank, or Discogs' "Not Graded"), `undefined` for anything
 * off the scale — a media grade can't be Generic or No Cover, which only a sleeve can be.
 */
export function parseGrade(raw: unknown, part: 'media'): MediaGrade | null | undefined;
export function parseGrade(raw: unknown, part: 'sleeve'): SleeveGrade | null | undefined;
export function parseGrade(raw: unknown, part: 'media' | 'sleeve'): SleeveGrade | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return undefined;
  const k = key(raw);
  if (k === '' || k === 'not graded') return null;
  if (k.length > 40) return undefined;
  const grade = LOOKUP.get(k);
  if (!grade) return undefined;
  return part === 'media' && !(MEDIA_GRADES as readonly string[]).includes(grade) ? undefined : grade;
}
