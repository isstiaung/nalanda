// Signing in a device from another one (ARCH.md §16 #99): the short code a signed-in device shows, and the two digits
// a new device shows for the phone to match. Pure: what the codes look like and how they are read back; the rows are
// in db/queries.ts, the pages in routes/auth.tsx (the new device's) and routes/account.tsx (the signed-in one's).

/** How long either way of pairing stays open: long enough to pick up the other device, short enough to be no standing key. */
export const PAIR_MINUTES = 5;

/** The code's alphabet: no 0/O, 1/I/L — read off one screen and typed on another, often a television's. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIR_CODE_LENGTH = 8;

/** A new code: eight characters (~40 bits), used once, within PAIR_MINUTES, and refused after ten wrong tries an address. */
export function newPairCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIR_CODE_LENGTH));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** A code as it is shown: in two fours, "ABCD-EFGH". */
export const formatPairCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/** A code as typed — lower case, spaces, the dash — read back as the code it was meant to be; '' if it can't be one. */
export function normalizePairCode(raw: unknown): string {
  const code = String(raw ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  return code.length === PAIR_CODE_LENGTH && [...code].every((ch) => ALPHABET.includes(ch)) ? code : '';
}

/** The two digits a new device shows, 10 to 99: what the phone must pick before it approves (§16 #99). */
export function newMatchDigits(): string {
  return String(10 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 90));
}

/** The three numbers the phone offers: the right one among two others, in an order that gives nothing away. The others
 *  come from the request's hash (hex), so they are the same on every load: reloading the page narrows nothing down. */
export function matchChoices(match: string, seed: string): string[] {
  const picks = new Set([match]);
  for (let i = 0; i + 2 <= seed.length && picks.size < 3; i += 2) picks.add(String(10 + (parseInt(seed.slice(i, i + 2), 16) % 90)));
  for (let n = 10; picks.size < 3; n++) picks.add(String(n));
  return [...picks].sort();
}
