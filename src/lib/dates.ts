// Dates as the ledger writes them (ARCH.md §16 #16: monospace for all data): "2026-09-28", and a moment as
// "2026-09-28 18:28" — everywhere a page shows one, the same way. Display only: the export, the CSV and every stored
// value keep their own formats. public/scan-review.js writes a scan's time the same way, in the device's own time.

/** "2026-09-28", from a calendar date, an SQL datetime ("2026-09-28 18:28:11") or an ISO timestamp ("…T18:28:11Z"). */
export const ledgerDate = (value: string): string => value.slice(0, 10);

/** "2026-09-28 18:28", from an SQL datetime or an ISO timestamp: the date, then the time to the minute. */
export const ledgerDateTime = (value: string): string => value.slice(0, 16).replace('T', ' ');

// ── today, where the viewer is (ARCH.md §16 #69) ──
// The server's clock is UTC, and a household east of it reaches tomorrow first: a member in Chennai finishing a book
// at 2 am would have it dated yesterday. So every "today" a page decides — the date a Finish, Played or Start form
// offers, the day a page or a return is recorded on, whether a loan is overdue, where a goal's pace stands — is the
// day in the device's own time zone. app.js writes that zone (an IANA name, from the browser) into a small `tz`
// cookie, as the sidebar's `nav` cookie is written (§16 #62), and the server reads it here. No cookie, or one that
// isn't a zone this runtime knows, means UTC, as before: the browser writes it, so it is only ever input.

export const TZ_COOKIE = 'tz';

/** Plausible IANA zone names only — "Asia/Kolkata", "America/Argentina/Buenos_Aires", "UTC" — before Intl sees one. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2}$/;

// One formatter per zone, kept for the isolate's life: a page asks for today several times a request, and there are
// a few hundred zones at most. A zone the runtime refuses is remembered as null, so it's probed once.
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      f = null;
    }
    formatters.set(zone, f);
  }
  return f;
}

/**
 * The zone a `tz` cookie names, when this runtime can keep time in it; otherwise 'UTC'. The name as given, not the
 * runtime's canonical one (ICU answers "Asia/Calcutta" for Asia/Kolkata): either keeps the same time.
 */
export function zoneOf(cookie: string | undefined): string {
  if (!cookie || !ZONE_SHAPE.test(cookie)) return 'UTC';
  return formatterFor(cookie) ? cookie : 'UTC';
}

/** "2026-10-02": the calendar day it is in `zone` at `at` (milliseconds since the epoch; now by default). */
export function todayIn(zone: string, at: number = Date.now()): string {
  const parts = (formatterFor(zone) ?? formatterFor('UTC')!).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`;
}

/** Today for the device a request comes from: its `tz` cookie's zone, else UTC. */
export const todayFor = (cookie: string | undefined): string => todayIn(zoneOf(cookie));
