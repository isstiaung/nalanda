// Types for scripts/demo-static.mjs, so test/demo-static.spec.ts holds it to its answers under `tsc --noEmit`.
export const DEMO_USER: string;
export const DEMO_PASSWORD: string;
export const CANNED_SEARCHES: readonly string[];
export const LOGIN_NOTE: string;
export function crawlable(pathWithQuery: string): boolean;
export function safeQuery(query: string): string;
export function isAsset(path: string): boolean;
export function fileFor(pathWithQuery: string): string;
export function hrefFor(pathWithQuery: string, base?: string): string;
export function addressesIn(html: string): string[];
export function rewriteLinks(html: string, base?: string): string;
export function fullAddressesIn(text: string, origin: string): string[];
export function rewriteFullAddresses(text: string, from: string, to?: string, base?: string): string;
export function inject(html: string, opts: { base?: string; banner: string }): string;
export function bannerHtml(base?: string, repo?: string): string;
