// Quotes and highlights (ARCH.md §16 #77): what a quote is, how the form and the Kindle import tidy one, and the
// export's `quotes` cell. Pure functions; the queries are in src/db/queries.ts, the pages in routes/quotes.tsx and the
// item page, the Kindle file's parsing in public/kindle.js (the browser's, as the CSV import's is).

export const MAX_QUOTE_TEXT = 5_000;
export const MAX_QUOTE_NOTE = 2_000;
export const MAX_QUOTE_PAGE = 40;
/** Enough for any reader of one book, and a bound on what a crafted file can make one row insert. */
export const MAX_QUOTES_PER_ITEM = 500;

/** A quote as the form, the file and the trash carry it. */
export type QuoteDraft = {
  text: string;
  page: string | null;
  note: string | null;
  shared: boolean;
  at?: string | null; // 'YYYY-MM-DD HH:MM:SS'; null or absent takes now
  source?: string | null;
};
/** A quote in the export's cell: whose by username, null for a member removed since, absent for whoever imports it. */
export type CellQuote = QuoteDraft & { by?: string | null };
/** A quote on its way in, and whose: a member's id, null for nobody here, absent for whoever brings it in. */
export type PersonQuote = QuoteDraft & { userId?: number | null };

const SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Text as a quote keeps it: line breaks kept, trailing space dropped, bounded; null when nothing is left. */
export function quoteText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  return t ? t.slice(0, MAX_QUOTE_TEXT) : null;
}

/** A page or location as typed or as Kindle wrote it: one line, short; null when empty. */
export const quotePage = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim() ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE_PAGE) : null;

export const quoteNote = (raw: unknown): string | null => {
  const t = quoteText(raw);
  return t ? t.slice(0, MAX_QUOTE_NOTE) : null;
};

/** What a form or a file says about one quote, tidied; null when it has no text. */
export function cleanQuote(raw: Partial<Record<keyof QuoteDraft, unknown>>): QuoteDraft | null {
  const text = quoteText(raw.text);
  if (!text) return null;
  const at = typeof raw.at === 'string' && SQL_DATETIME.test(raw.at) ? raw.at : null;
  return {
    text,
    page: quotePage(raw.page),
    note: quoteNote(raw.note),
    shared: raw.shared === true || raw.shared === 1 || raw.shared === '1' || raw.shared === 'true',
    at,
    source: raw.source === 'kindle' ? 'kindle' : null,
  };
}

// ---------- the export's `quotes` cell ----------
//
// JSON, one object per quote, oldest first:
//   [{"by":"asha","text":"…","page":"42","note":null,"shared":true,"at":"2026-09-01 10:00:00","source":"kindle"}]
// `by` is null for a member removed since; a quote with no `by` at all is the importer's, as the reviews cell has it.

export function formatQuotesCell(quotes: CellQuote[]): string {
  if (!quotes.length) return '';
  return JSON.stringify(
    quotes.map((q) => ({ by: q.by ?? null, text: q.text, page: q.page, note: q.note, shared: q.shared, at: q.at ?? null, source: q.source ?? null })),
  );
}

/** A `quotes` cell back, each tidied, at most MAX_QUOTES_PER_ITEM; anything unreadable is none. */
export function parseQuotesCell(cell: string | null | undefined): CellQuote[] {
  const text = (cell ?? '').trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CellQuote[] = [];
  for (const entry of parsed.slice(0, MAX_QUOTES_PER_ITEM)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const q = cleanQuote(e);
    if (!q) continue;
    const by = !('by' in e) ? undefined : typeof e.by === 'string' && e.by.trim() ? e.by : null;
    out.push({ ...(by === undefined ? {} : { by }), ...q });
  }
  return out;
}

/** What the Kindle import posts for one book: its highlights, each as Kindle wrote it (parsed in the browser). */
export type KindleBook = { title: string; author: string | null; highlights: KindleHighlight[] };
export type KindleHighlight = { text: string; page: string | null; note: string | null; at: string | null };

export const MAX_KINDLE_BOOKS_PER_REQUEST = 25;
export const MAX_KINDLE_HIGHLIGHTS_PER_REQUEST = 2_000;

/** A posted Kindle book, checked field by field; null when it isn't one. */
export function cleanKindleBook(raw: unknown): KindleBook | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const title = typeof b.title === 'string' ? b.title.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  if (!title || !Array.isArray(b.highlights)) return null;
  const author = typeof b.author === 'string' && b.author.trim() ? b.author.replace(/\s+/g, ' ').trim().slice(0, 500) : null;
  const highlights: KindleHighlight[] = [];
  for (const h of b.highlights.slice(0, MAX_QUOTES_PER_ITEM)) {
    if (!h || typeof h !== 'object') continue;
    const x = h as Record<string, unknown>;
    const text = quoteText(x.text);
    if (!text) continue;
    highlights.push({
      text,
      page: quotePage(x.page),
      note: quoteNote(x.note),
      at: typeof x.at === 'string' && SQL_DATETIME.test(x.at) ? x.at : null,
    });
  }
  return highlights.length ? { title, author, highlights } : null;
}
