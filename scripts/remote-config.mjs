// wrangler.jsonc carries an all-zero placeholder database_id (ARCH.md §16 #24), which Cloudflare's API rejects —
// so a bare `wrangler d1 … --remote` can't find the production database. Scripts that reach it from a laptop
// run wrangler against a gitignored copy of the config holding the real id: D1_DATABASE_ID when it's set; else the
// config's own when it isn't the placeholder; else the id of the database the config names (`nalanda`) in the account
// wrangler is logged in to — a household's fork, whose deploys find it the same way (§16 #101).
//
// scripts/deploy.mjs does the same, and on a household's first deploy creates the database when there is none yet.
// This never creates anything: a backup or a hand-run command needs a database that is already there.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chooseDatabaseId, configuredDatabase, findDatabase, withDatabaseId } from './database-id.mjs';

const SOURCE = 'wrangler.jsonc';

/** What scripts pass wrangler's d1 commands: the database's name as wrangler.jsonc gives it — `nalanda`, here and in a
 *  household's fork (§16 #101). Wrangler finds that entry in the config, and its id —
 *  and every command line this repository's own production scripts run stays exactly what it was. */
export const DATABASE = configuredDatabase(readFileSync(SOURCE, 'utf8')).name || 'nalanda';
const RESOLVED = '.wrangler-remote.jsonc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** D1_DATABASE_ID if set; else the config's own id; else the id `wrangler d1 list` gives the one database with the
 *  config's name — or ''. */
function productionDatabaseId(source) {
  const chosen = chooseDatabaseId(process.env.D1_DATABASE_ID, source);
  if (chosen.id) return chosen.id;
  if (chosen.error !== 'no-id') return ''; // a malformed D1_DATABASE_ID: refused below, with how to set it
  const { name } = configuredDatabase(source);
  try {
    const listed = JSON.parse(
      execFileSync('npx', ['wrangler', 'd1', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    return findDatabase(listed, name);
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
  const source = readFileSync(SOURCE, 'utf8');
  const id = productionDatabaseId(source);
  if (!UUID.test(id)) {
    console.error(
      `Couldn't find the id of the "${configuredDatabase(source).name}" D1 database. Log in with \`npx wrangler login\`,\n` +
        'or set D1_DATABASE_ID yourself — `npx wrangler d1 list` shows it:\n\n' +
        `  D1_DATABASE_ID=<id> ${usage}`,
    );
    process.exit(1);
  }
  const resolved = withDatabaseId(source, id);
  if (resolved === null) {
    console.error(`No database_id field found in ${SOURCE} — has the config changed shape?`);
    process.exit(1);
  }
  writeFileSync(path, resolved);
  return path;
}

export function removeRemoteConfig(path = RESOLVED) {
  rmSync(path, { force: true });
}
