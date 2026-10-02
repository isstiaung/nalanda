// Types for scripts/database-id.mjs, so test/deploy-config.spec.ts holds it to its answers under `tsc --noEmit`.
export const PLACEHOLDER_ID: string;
export function configuredDatabase(source: string): { id: string; name: string; hasIdField: boolean };
export function chooseDatabaseId(envValue: string | undefined, source: string): { id: string; from: 'env' | 'config'; error?: undefined } | { error: string; id?: undefined; from?: undefined };
export function withDatabaseId(source: string, id: string): string | null;
