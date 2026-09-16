import type { MediaType } from '../db/schema';

/** A normalized lookup result, ready to prefill the add-item confirm form. */
export type Candidate = {
  mediaType: MediaType;
  title: string;
  creators?: string;
  publisher?: string;
  published?: string;
  description?: string;
  length?: number; // pages / play-minutes / tracks (by media type)
  isbn13?: string;
  isbn10Upc?: string;
  coverUrl?: string; // provider-hosted; fetched into R2 only on save
  workKey?: string; // Open Library work record (/works/OL…W) — where its description lives
  details: Record<string, unknown>;
  provider: string;
};

export interface MetadataProvider {
  id: string;
  mediaTypes: MediaType[];
  /** Resolve a scanned barcode; null when the provider has no barcode support or no hit. */
  lookupByBarcode(code: string): Promise<Candidate | null>;
  search(query: string): Promise<Candidate[]>;
}

export type LookupResult = {
  candidates: Candidate[];
  /** Human-readable hints, e.g. "Set DISCOGS_TOKEN to enable vinyl lookups." */
  notices: string[];
};

/** Lowercased, unaccented, punctuation-free — for comparing titles across providers. */
export function normTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when titles are the same book modulo case/punctuation/subtitle. */
export function titlesMatch(a: string, b: string): boolean {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (na.length < 3 || nb.length < 3) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

/**
 * Same-creator check for title matching: the subject's first creator's surname must
 * appear in the candidate's creators. Different books share titles constantly —
 * a title match with the wrong author is a wrong cover.
 */
const GENERATIONAL = new Set(['jr', 'jnr', 'sr', 'snr', 'ii', 'iii', 'iv']);

export function creatorsMatch(subject: string | null | undefined, candidate: string | null | undefined): boolean {
  if (!subject) return true; // nothing to check against — accept the title match
  if (!candidate) return false; // subject names an author, candidate doesn't — too risky
  // "Kurt Vonnegut Jr." must still match a record crediting "Kurt Vonnegut": a generational
  // suffix is not a surname, and taking it as one rejects every correct record.
  const parts = normTitle(subject.split(',')[0] ?? '')
    .split(' ')
    .filter((part) => !GENERATIONAL.has(part));
  const surname = parts.pop();
  if (!surname || surname.length < 2) return true;
  return normTitle(candidate).includes(surname);
}

/** Shortest blurb worth keeping: below this it's a stub like "First published 1944." */
const MIN_DESCRIPTION = 40;

/**
 * Provider blurbs arrive as markdown (Open Library) or HTML (Google Books), and item pages render
 * plain text — raw asterisks and <p> tags would show literally. Returns null for a stub.
 */
export function cleanDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/\r/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .split('\n')
    .filter((line) => !/^\s*\[\d+\]:\s*http/i.test(line))
    .join('\n')
    .replace(/\(\[source\]\[\d+\]\)/gi, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Reference-style links: Open Library's work records quote reviews as "[Comment by X][1]"
    // with the target defined on a line already dropped above, leaving bare brackets on the page.
    .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
    // Blockquoted excerpts ("> One of my favourite novels…") render as literal > in our markup.
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length >= MIN_DESCRIPTION ? text : null;
}
