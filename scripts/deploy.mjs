// Deploys: remote migrations, then `wrangler deploy` — against the right D1 database (ARCH.md §16 #24, #101).
//
// wrangler.jsonc carries no `database_id` (only the all-zero `preview_database_id` local dev keys by), so this
// repository names no specific Cloudflare resource. The id comes from, in order (scripts/database-id.mjs):
//   - D1_DATABASE_ID in the environment — how this repository's own deploys get it:
//       locally:                    D1_DATABASE_ID=<id> npm run deploy
//       Cloudflare Workers Builds:  a build variable on the Worker
//   - a real `database_id` in wrangler.jsonc, if one was ever written in;
//   - otherwise, in Cloudflare's Workers Builds only, the database the config names (`nalanda`) in the account this
//     deploys to — a household's fork whose deploy command is `npm run deploy` (runbooks/deploy.md): found by that
//     name, or created near D1_LOCATION (scripts/fork-database.mjs), and only on the library's branch. A fork left with
//     Cloudflare's own `npx wrangler deploy` gets the same from the build hook, scripts/workers-build.mjs. The cover
//     bucket the config names is created by `wrangler deploy` itself when it's missing.
// Anywhere else — a laptop — with no id it stops, as it always has: it never guesses at which database a terminal means.
// Whichever id it is, it is said before anything runs.
//
// Wrangler doesn't interpolate environment variables inside its config file, so this writes a resolved copy and points
// wrangler at it. The copy lives in the project root, because wrangler resolves `main`, `assets` and `migrations_dir`
// relative to the config file's own directory; it is gitignored. Migrations name the database as the config does —
// `nalanda` — so wrangler finds that entry, and the id written into it. They run before the code, every time, the
// first deploy included: a new database is made and migrated before the Worker that needs it goes live.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chooseDatabaseId, configuredDatabase, withDatabaseId } from './database-id.mjs';
import { branchProblem, findOrCreate, Refusal } from './fork-database.mjs';

const SOURCE = 'wrangler.jsonc';
const RESOLVED = '.wrangler-deploy.jsonc';

const source = readFileSync(SOURCE, 'utf8');
const name = configuredDatabase(source).name || 'nalanda';

function stop(message) {
  console.error(message);
  process.exit(1);
}

const chosen = chooseDatabaseId(process.env.D1_DATABASE_ID, source);
if (chosen.error && chosen.error !== 'no-id') stop(chosen.error);
let id = chosen.id;
if (id) {
  console.log(`Deploying with D1 database ${id} (${chosen.from === 'env' ? 'from D1_DATABASE_ID' : 'from wrangler.jsonc'}).`);
} else if (process.env.WORKERS_CI !== '1') {
  stop(
    'D1_DATABASE_ID is not set, and wrangler.jsonc names no database id.\n\n' +
      'The D1 database id is deliberately not stored in this repository. Supply it at\n' +
      'deploy time — `wrangler d1 list` will show it:\n\n' +
      '  D1_DATABASE_ID=<id> npm run deploy\n\n' +
      'On Cloudflare Workers Builds, add it as a build variable instead — or, for a household\n' +
      "running a fork, leave it out: the build finds or creates the account's database itself.",
  );
} else {
  // a household's fork, in Workers Builds, whose deploy command was set to `npm run deploy` (Cloudflare's own
  // `npx wrangler deploy` gets the same from scripts/workers-build.mjs)
  try {
    const problem = branchProblem();
    if (problem) throw new Refusal(problem);
    id = findOrCreate(name);
  } catch (err) {
    stop(err instanceof Refusal ? err.message : String(err));
  }
}

const resolved = withDatabaseId(source, id);
if (resolved === null) {
  console.error(`No database_id field found in ${SOURCE} — has the config changed shape?`);
  process.exit(1);
}
writeFileSync(RESOLVED, resolved);

const run = (args) => execFileSync('wrangler', [...args, '--config', RESOLVED], { stdio: 'inherit' });

try {
  run(['d1', 'migrations', 'apply', name, '--remote']);
  run(['deploy']);
} finally {
  rmSync(RESOLVED, { force: true });
}
