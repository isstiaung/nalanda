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
export function creatorsMatch(subject: string | null | undefined, candidate: string | null | undefined): boolean {
  if (!subject) return true; // nothing to check against — accept the title match
  if (!candidate) return false; // subject names an author, candidate doesn't — too risky
  const surname = normTitle(subject.split(',')[0] ?? '')
    .split(' ')
    .pop();
  if (!surname || surname.length < 2) return true;
  return normTitle(candidate).includes(surname);
}
