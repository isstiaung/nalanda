// Dates as the ledger writes them (ARCH.md §16 #16: monospace for all data): "2026-09-28", and a moment as
// "2026-09-28 18:28" — everywhere a page shows one, the same way. Display only: the export, the CSV and every stored
// value keep their own formats. public/scan-review.js writes a scan's time the same way, in the device's own time.

/** "2026-09-28", from a calendar date, an SQL datetime ("2026-09-28 18:28:11") or an ISO timestamp ("…T18:28:11Z"). */
export const ledgerDate = (value: string): string => value.slice(0, 10);

/** "2026-09-28 18:28", from an SQL datetime or an ISO timestamp: the date, then the time to the minute. */
export const ledgerDateTime = (value: string): string => value.slice(0, 16).replace('T', ' ');
