// What a deploy runs against (ARCH.md §16 #24, #101): this repository's placeholder database id, D1_DATABASE_ID, and the
// real id the Deploy to Cloudflare button writes into a person's copy — and what the button's form asks for.
import { describe, expect, it } from 'vitest';
import { chooseDatabaseId, configuredDatabase, PLACEHOLDER_ID, withDatabaseId } from '../scripts/database-id.mjs';
import wrangler from '../wrangler.jsonc?raw';
import devVarsExample from '../.dev.vars.example?raw';
import pkg from '../package.json';

const REAL = '0f3c5a1e-8b2d-4c6f-9a7e-1d2b3c4d5e6f';
const copied = wrangler.replace(PLACEHOLDER_ID, REAL); // as the button leaves a person's copy

describe('the database a deploy means', () => {
  it('is D1_DATABASE_ID when set — this repository’s own deploys', () => {
    expect(chooseDatabaseId(` ${REAL} `, wrangler)).toEqual({ id: REAL, from: 'env' });
    expect(chooseDatabaseId(REAL, copied)).toEqual({ id: REAL, from: 'env' });
  });

  it('is a button copy’s own id when D1_DATABASE_ID isn’t set, and never the placeholder', () => {
    expect(chooseDatabaseId(undefined, copied)).toEqual({ id: REAL, from: 'config' });
    expect(chooseDatabaseId('', wrangler)).toEqual({ error: 'no-id' });
  });

  it('refuses a D1_DATABASE_ID that isn’t a UUID, rather than falling back', () => {
    expect(chooseDatabaseId('not-an-id', copied).error).toContain('not a UUID');
  });

  it('writes the id into the config, the same id included — only a config without the field is refused', () => {
    expect(withDatabaseId(wrangler, REAL)).toBe(copied);
    expect(withDatabaseId(copied, REAL)).toBe(copied);
    expect(withDatabaseId('{ "name": "x" }', REAL)).toBeNull();
  });
});

describe('this repository’s config', () => {
  it('names no Cloudflare resource: the all-zero placeholder, which the button overwrites', () => {
    expect(configuredDatabase(wrangler)).toEqual({ id: '', name: 'nalanda', hasIdField: true });
    expect(wrangler).toContain(`"database_id": "${PLACEHOLDER_ID}"`);
  });
});

describe('what the button’s form asks for', () => {
  const asked = devVarsExample
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => line.split('=') as [string, string]);

  it('is SESSION_SECRET alone, with no value to accept as it stands — the optional tokens stay commented out', () => {
    expect(asked).toEqual([['SESSION_SECRET', '']]);
  });

  it('says what each secret is for', () => {
    const bindings = (pkg as { cloudflare: { bindings: Record<string, { description: string }> } }).cloudflare.bindings;
    for (const [name] of asked) expect(bindings[name]?.description, name).toBeTruthy();
    expect(Object.keys(bindings)).toEqual(['SESSION_SECRET', 'DB', 'COVERS']);
  });
});
