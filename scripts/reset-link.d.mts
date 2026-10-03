// Types for scripts/reset-link.mjs, so test/recovery-code.spec.ts holds it to its answers under `tsc --noEmit`.
export const LINK_DAYS: number;
export const ADMINS_SQL: string;
export function newLinkSecret(): string;
export function newKey(): string;
export function isKey(key: unknown): boolean;
export function sha256Hex(text: string): Promise<string>;
export function sqlString(s: string): string;
export function accountSql(username: string): string;
export function resetLinkStatements(input: { id: number; sessionKey: string | null; newSessionKey?: string | null; tokenHash: string; days?: number }): string[];
export function linkMadeSql(tokenHash: string): string;
