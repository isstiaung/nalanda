// wrangler.jsonc carries an all-zero placeholder database_id (ARCH.md §16 #24), which Cloudflare's API rejects —
// so a bare `wrangler d1 … --remote` can't find the production database. Scripts that reach it from a laptop
// run wrangler against a gitignored copy of the config holding the real id: D1_DATABASE_ID when it's set,
// otherwise the id of the database named `nalanda` in the account wrangler is logged in to.
//
// scripts/deploy.mjs does the same but insists on D1_DATABASE_ID: in Cloudflare's build, that's how the id
// arrives, and a deploy shouldn't guess.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

export const DATABASE = 'nalanda';
const SOURCE = 'wrangler.jsonc';
const RESOLVED = '.wrangler-remote.jsonc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** D1_DATABASE_ID if set, else the id `wrangler d1 list` gives the one database with our name — or ''. */
function productionDatabaseId() {
  const fromEnv = (process.env.D1_DATABASE_ID ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const listed = JSON.parse(
      execFileSync('npx', ['wrangler', 'd1', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    const matches = listed.filter((db) => db.name === DATABASE);
    return matches.length === 1 ? matches[0].uuid : '';
  } catch {
    return ''; // not logged in, or no answer
  }
}

/**
 * Writes the config copy and returns its path, for wrangler's `--config`. Exits with instructions when the id
 * can't be found; `usage` is how to run the calling command again with D1_DATABASE_ID set. Pair every call
 * with removeRemoteConfig() in a `finally`. A long-running script passes its own `path`, so a backup or
 * migration started meanwhile can't delete the copy out from under it.
 */
export function writeRemoteConfig(usage, path = RESOLVED) {
  const id = productionDatabaseId();
  if (!UUID.test(id)) {
    console.error(
      `Couldn't find the id of the "${DATABASE}" D1 database. Log in with \`npx wrangler login\`,\n` +
        'or set D1_DATABASE_ID yourself — `npx wrangler d1 list` shows it:\n\n' +
        `  D1_DATABASE_ID=<id> ${usage}`,
    );
    process.exit(1);
  }
  const source = readFileSync(SOURCE, 'utf8');
  const resolved = source.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${id}"`);
  if (resolved === source) {
    console.error(`No database_id field found in ${SOURCE} — has the config changed shape?`);
    process.exit(1);
  }
  writeFileSync(path, resolved);
  return path;
}

export function removeRemoteConfig(path = RESOLVED) {
  rmSync(path, { force: true });
}
