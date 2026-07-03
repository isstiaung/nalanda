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
