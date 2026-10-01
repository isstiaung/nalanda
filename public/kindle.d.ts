// Types for public/kindle.js, so test/quotes.spec.ts can import the browser's parser as it is.
export type ParsedHighlight = { text: string; page: string | null; note: string | null; at: string | null };
export type ParsedBook = { title: string; author: string | null; highlights: ParsedHighlight[] };
export function kindleDate(text: string | null | undefined): string | null;
export function parseClippings(text: string): ParsedBook[];
export function parseNotebookHtml(html: string): ParsedBook[];
export function parseKindle(text: string): ParsedBook[];
