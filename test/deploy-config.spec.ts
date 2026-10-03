// What a deploy runs against (ARCH.md §16 #24, #101): this repository's placeholder database id, D1_DATABASE_ID, a real
// id in a config, and a household's fork, whose database is found by name — and the one secret the example asks for.
import { describe, expect, it } from 'vitest';
import { chooseDatabaseId, configuredDatabase, findDatabase, PLACEHOLDER_ID, withDatabaseId } from '../scripts/database-id.mjs';
import wrangler from '../wrangler.jsonc?raw';
import devVarsExample from '../.dev.vars.example?raw';

const REAL = '0f3c5a1e-8b2d-4c6f-9a7e-1d2b3c4d5e6f';
// The config as this repository keeps it, and with a real id written in. Built from the real file, with its id set either
// way, so these pass in a fork that wrote one in too: that this repository keeps the placeholder is a CI step (ci.yml).
const placeheld = withDatabaseId(wrangler, PLACEHOLDER_ID)!;
const copied = withDatabaseId(wrangler, REAL)!;

describe('the database a deploy means', () => {
  it('is D1_DATABASE_ID when set — this repository’s own deploys', () => {
    expect(chooseDatabaseId(` ${REAL} `, placeheld)).toEqual({ id: REAL, from: 'env' });
    expect(chooseDatabaseId(REAL, copied)).toEqual({ id: REAL, from: 'env' });
  });

  it('is the config’s own id when D1_DATABASE_ID isn’t set, and never the placeholder — then a fork’s, found by name', () => {
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

describe('a fork’s database, found by name', () => {
  const listed = [
    { uuid: '11111111-2222-4333-8444-555555555555', name: 'nalanda', created_at: '2026-10-03' },
    { uuid: '66666666-7777-4888-8999-000000000000', name: 'something-else' },
  ];

  it('is the one database the config names in `wrangler d1 list`’s answer', () => {
    expect(findDatabase(listed, configuredDatabase(placeheld).name)).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('is none when there is no such database — the first deploy creates it — or the answer isn’t a list', () => {
    expect(findDatabase([listed[1]], 'nalanda')).toBe('');
    expect(findDatabase([], 'nalanda')).toBe('');
    expect(findDatabase({ error: 'not logged in' }, 'nalanda')).toBe('');
    expect(findDatabase([{ name: 'nalanda', uuid: 'not-a-uuid' }], 'nalanda')).toBe('');
  });
});

describe('the example secrets', () => {
  it('carry no value for SESSION_SECRET to accept as it stands — the optional tokens stay commented out', () => {
    const set = devVarsExample
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.split('=') as [string, string]);
    expect(set).toEqual([['SESSION_SECRET', '']]);
  });
});
