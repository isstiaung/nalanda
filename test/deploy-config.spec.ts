// What a deploy runs against (ARCH.md §16 #24, #101): this repository's config, with no database id; D1_DATABASE_ID; a
// household's fork, whose database is found by name, on its library's branch — and the one secret the example asks for.
import { describe, expect, it } from 'vitest';
import { branchProblem, chooseDatabaseId, configuredDatabase, findDatabase, PLACEHOLDER_ID, withDatabaseId } from '../scripts/database-id.mjs';
import wrangler from '../wrangler.jsonc?raw';
import devVarsExample from '../.dev.vars.example?raw';

const REAL = '0f3c5a1e-8b2d-4c6f-9a7e-1d2b3c4d5e6f';
// The config as this repository keeps it — no database_id — and as a deploy resolves it, with a real one written in.
const resolvedCopy = withDatabaseId(wrangler, REAL)!;

describe('this repository’s config', () => {
  it('names no Cloudflare resource: no database_id, and the all-zero placeholder only as the id local dev keys by', () => {
    expect(configuredDatabase(wrangler)).toEqual({ id: '', name: 'nalanda', hasIdField: false });
    expect(wrangler).not.toMatch(/"database_id"\s*:/);
    expect(wrangler).toContain(`"preview_database_id": "${PLACEHOLDER_ID}"`);
  });

  it('runs the build hook before every deploy, so Cloudflare’s own deploy command migrates a fork', () => {
    expect(wrangler).toContain('"build": { "command": "node scripts/workers-build.mjs" }');
  });
});

describe('the database a deploy means', () => {
  it('is D1_DATABASE_ID when set — this repository’s own deploys', () => {
    expect(chooseDatabaseId(` ${REAL} `, wrangler)).toEqual({ id: REAL, from: 'env' });
  });

  it('is a database_id written into the config, when one is; otherwise none here — a fork’s is found by name', () => {
    expect(chooseDatabaseId(undefined, resolvedCopy)).toEqual({ id: REAL, from: 'config' });
    expect(chooseDatabaseId('', wrangler)).toEqual({ error: 'no-id' });
  });

  it('refuses a D1_DATABASE_ID that isn’t a UUID, or is the placeholder, rather than falling back', () => {
    expect(chooseDatabaseId('not-an-id', wrangler).error).toContain('not a UUID');
    expect(chooseDatabaseId(PLACEHOLDER_ID, wrangler).error).toContain('placeholder');
  });

  it('writes the id in after database_name, or over the one there — the preview id untouched', () => {
    expect(resolvedCopy).toContain(`"database_name": "nalanda",\n      "database_id": "${REAL}",\n      "preview_database_id": "${PLACEHOLDER_ID}"`);
    expect(withDatabaseId(resolvedCopy, REAL)).toBe(resolvedCopy);
    expect(configuredDatabase(withDatabaseId(resolvedCopy, '11111111-2222-4333-8444-555555555555')!).id).toBe('11111111-2222-4333-8444-555555555555');
    expect(withDatabaseId('{ "name": "x" }', REAL)).toBeNull();
  });
});

describe('the branch a fork’s library runs', () => {
  it('is deploy-site, or NALANDA_BRANCH — any other build, main above all, is refused with what to set', () => {
    expect(branchProblem({ WORKERS_CI_BRANCH: 'deploy-site' })).toBe('');
    expect(branchProblem({ WORKERS_CI_BRANCH: 'feat/x', NALANDA_BRANCH: 'feat/x' })).toBe('');
    expect(branchProblem({ WORKERS_CI_BRANCH: 'main' })).toContain('`main` is work in progress');
    expect(branchProblem({ WORKERS_CI_BRANCH: 'some-feature' })).toContain('a library runs `deploy-site`');
    expect(branchProblem({})).toContain('an unknown branch');
  });
});

describe('a fork’s database, found by name', () => {
  const listed = [
    { uuid: '11111111-2222-4333-8444-555555555555', name: 'nalanda', created_at: '2026-10-03' },
    { uuid: '66666666-7777-4888-8999-000000000000', name: 'something-else' },
  ];

  it('is the one database the config names in `wrangler d1 list`’s answer', () => {
    expect(findDatabase(listed, configuredDatabase(wrangler).name)).toBe('11111111-2222-4333-8444-555555555555');
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
