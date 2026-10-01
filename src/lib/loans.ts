// Every loan of an item in the export's `loans` cell (ARCH.md §16 #57), written and read back the way the `reads` cell
// is (src/lib/reads.ts): one token per loan, semicolon-separated, free text percent-encoded. Pure functions —
// loansForIdRange() in src/db/queries.ts reads a page's loans, and importItems() writes a row's back.
import { isIsoDate } from './reads';

/** A loan as the cell carries it, and as an import writes it: every column but the item and the id. */
export type LoanDraft = {
  borrower: string;
  loanedOn: string;
  dueOn: string | null;
  returnedOn: string | null; // null: still out
  contact: string | null;
  note: string | null;
  edition?: string | null; // which copy went out (§16 #75): one of the item's format codes, or none
};

/**
 * A bound on what a crafted CSV can make one row insert — decades of lending, for the busiest board game. The export
 * writes every loan; an item lent more often than this comes back with its latest MAX_LOANS_PER_CELL.
 */
export const MAX_LOANS_PER_CELL = 1000;

// ---------- the export's `loans` cell ----------
//
// In the order the loans were made, oldest first, semicolon-separated, each `loaned..returned@borrower` with the
// optional parts after it, each `|key:value`, in this order when written and in any order when read:
//   2024-03-01..2024-03-20@Asha|due:2024-03-15;2026-09-10..@Ravi%20(Kapoor%20household)|contact:ravi%40example.com|note:Hardback
// Nothing after the `..` is a loan still out. The borrower, contact and note are percent-encoded, as a reader's name
// is in `reads`, so no text can break the cell — `;`, `|`, `@`, `:`, `%`, commas, quotes and newlines all arrive
// encoded — and nothing in the cell needs CSV quoting. Dates are calendar dates; the due date is encoded as well, which
// leaves a real date as it is.

/** Text as percent-encoding. A string with a lone surrogate — which D1 can't hand back, but a caller might — is mended first rather than failing the export. */
function enc(text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    return encodeURIComponent(text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�'));
  }
}

/** Percent-encoding back into text; a value that isn't our encoding — a `%` typed by hand — is taken as written. */
function dec(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function formatLoansCell(loans: LoanDraft[]): string {
  return loans
    .map(
      (l) =>
        `${l.loanedOn}..${l.returnedOn ?? ''}@${enc(l.borrower)}` +
        // encoded too: the lend form's due date was never checked, and a stored `;` must not start a loan of its own
        (l.dueOn ? `|due:${enc(l.dueOn)}` : '') +
        (l.contact ? `|contact:${enc(l.contact)}` : '') +
        (l.note ? `|note:${enc(l.note)}` : '') +
        (l.edition ? `|edition:${enc(l.edition)}` : ''),
    )
    .join(';');
}

const SPAN = /^(.*?)\.\.(.*)$/;

// A due date is kept as written on import (see parseLoansCell); a legacy free-text one is bounded, never dropped.
const MAX_DUE_TEXT = 200;

/**
 * A `loans` cell back into loans, oldest first as written. A part that doesn't parse is dropped and the rest kept:
 * one with no borrower, or whose lending date isn't a calendar date, or whose return date is there but isn't one —
 * read as a loan still out, it would say someone has a book that came back. A due date comes back as written, even
 * one that isn't a calendar date: loans lent before the lend form checked it can hold free text ("next week"), and
 * the export carries that faithfully, so it must round-trip too (only its length is bounded); a part it doesn't know (`|key:…` from a later version) is
 * ignored. Every loan is kept however many are out: an import restores the history as it was (§16 #57), and the
 * app can hold more open loans than copies (a book marked Not owned while it was out). Only the last
 * MAX_LOANS_PER_CELL parts are read: the latest loans, where the ones still out are.
 */
export function parseLoansCell(cell: string | null | undefined): LoanDraft[] {
  const out: LoanDraft[] = [];
  const parts = (cell ?? '').split(';');
  for (const part of parts.length > MAX_LOANS_PER_CELL ? parts.slice(-MAX_LOANS_PER_CELL) : parts) {
    const [head = '', ...fields] = part.trim().split('|');
    const at = head.indexOf('@');
    if (at < 0) continue;
    const span = SPAN.exec(head.slice(0, at).trim());
    const borrower = dec(head.slice(at + 1).trim());
    if (!span || !borrower) continue;
    const loanedOn = span[1]!.trim();
    const returned = span[2]!.trim();
    if (!isIsoDate(loanedOn) || (returned !== '' && !isIsoDate(returned))) continue;
    const loan: LoanDraft = { borrower, loanedOn, dueOn: null, returnedOn: returned || null, contact: null, note: null };
    for (const field of fields) {
      const colon = field.indexOf(':');
      if (colon < 0) continue;
      const key = field.slice(0, colon).trim();
      const value = field.slice(colon + 1).trim();
      if (key === 'due' && loan.dueOn === null) loan.dueOn = dec(value).slice(0, MAX_DUE_TEXT) || null;
      else if (key === 'contact' && loan.contact === null) loan.contact = dec(value) || null;
      else if (key === 'note' && loan.note === null) loan.note = dec(value) || null;
      else if (key === 'edition' && loan.edition === undefined) loan.edition = dec(value).slice(0, 40) || null; // the key only when the cell had one
    }
    out.push(loan);
  }
  return out;
}
