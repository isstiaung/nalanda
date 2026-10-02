// What a deploy runs against (ARCH.md §16 #24, #101): this repository's placeholder database id, D1_DATABASE_ID, and the
// real id the Deploy to Cloudflare button writes into a person's copy — and what the button's form asks for.
import { describe, expect, it } from 'vitest';
import { chooseDatabaseId, configuredDatabase, PLACEHOLDER_ID, withDatabaseId } from '../scripts/database-id.mjs';
import wrangler from '../wrangler.jsonc?raw';
import devVarsExample from '../.dev.vars.example?raw';
import pkg from '../package.json';

const REAL = '0f3c5a1e-8b2d-4c6f-9a7e-1d2b3c4d5e6f';
// The config as this repository keeps it, and as the button leaves a person's copy. Built from the real file, with its
// id set either way, so these pass in a copy too: that this repository keeps the placeholder is a CI step (ci.yml).
const placeheld = withDatabaseId(wrangler, PLACEHOLDER_ID)!;
const copied = withDatabaseId(wrangler, REAL)!;

describe('the database a deploy means', () => {
  it('is D1_DATABASE_ID when set — this repository’s own deploys', () => {
    expect(chooseDatabaseId(` ${REAL} `, placeheld)).toEqual({ id: REAL, from: 'env' });
    expect(chooseDatabaseId(REAL, copied)).toEqual({ id: REAL, from: 'env' });
  });

  it('is a button copy’s own id when D1_DATABASE_ID isn’t set, and never the placeholder', () => {
    expect(chooseDatabaseId(undefined, copied)).toEqual({ id: REAL, from: 'config' });
    expect(chooseDatabaseId('', placeheld)).toEqual({ error: 'no-id' });
  });

  it('refuses a D1_DATABASE_ID that isn’t a UUID, or is the placeholder, rather than falling back', () => {
    expect(chooseDatabaseId('not-an-id', copied).error).toContain('not a UUID');
    expect(chooseDatabaseId(PLACEHOLDER_ID, copied).error).toContain('placeholder');
  });

  it('writes the id into the config, the same id included — only a config without the field is refused', () => {
    expect(withDatabaseId(placeheld, REAL)).toBe(copied);
    expect(withDatabaseId(copied, REAL)).toBe(copied);
    expect(withDatabaseId('{ "name": "x" }', REAL)).toBeNull();
  });
});

describe('the config', () => {
  it('reads as a placeholder here and as a real id in a copy — the same file either way', () => {
    expect(configuredDatabase(placeheld)).toMatchObject({ id: '', hasIdField: true });
    expect(configuredDatabase(copied)).toMatchObject({ id: REAL, hasIdField: true });
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
