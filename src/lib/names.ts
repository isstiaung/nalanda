// Display names (ARCH.md §16 #45): the name a member goes by outside the app — on share pages and to connected
// households, only while an admin has switched names on there. A username never leaves the app; a display name is
// never a login.

/** Long enough for "Priya Ramanathan-Iyer", short enough to sit on a feed card. Counted in characters, not bytes. */
export const MAX_DISPLAY_NAME = 40;

/**
 * What a display name typed into a form becomes: control and format characters (newlines, bidi overrides) and
 * characters that look like nothing (Hangul fillers, the braille blank) taken out, runs of
 * whitespace made one space, trimmed, cut to MAX_DISPLAY_NAME characters. Empty is no display name — the member
 * stays unnamed. Not unique: two members may both go by "Sam"; nothing needs to tell them apart by it.
 */
export function normalizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029\u115F\u1160\u3164\uFFA0\u2800]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const cut = [...clean].slice(0, MAX_DISPLAY_NAME).join('').trim();
  return cut || null;
}

/**
 * A name another household sent, checked like any field a connection sends: a string of at most PEER_NAME_MAX
 * characters, with nothing a page couldn't render as plain text. `undefined` when absent (an older peer, or a member
 * with no display name), `null` when present but malformed — which rejects what carried it.
 */
export const PEER_NAME_MAX = 80;
export function parsePeerName(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || [...v].length > PEER_NAME_MAX) return null;
  // control and format characters (bidi overrides, zero-width marks) go, as they do from a display name typed here,
  // so a name can't reorder or hide the text around it; what's left renders as escaped text
  const clean = normalizeDisplayName(v.slice(0, PEER_NAME_MAX * 2));
  return clean ?? undefined;
}
