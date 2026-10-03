// Deploys: remote migrations, then `wrangler deploy` — against the right D1 database (ARCH.md §16 #24, #101).
//
// wrangler.jsonc ships with an all-zero placeholder, `"database_id": "00000000-0000-0000-0000-000000000000"`, so this
// repository names no specific Cloudflare resource. The id comes from, in order (scripts/database-id.mjs):
//   - D1_DATABASE_ID in the environment — how this repository's own deploys get it:
//       locally:                    D1_DATABASE_ID=<id> npm run deploy
//       Cloudflare Workers Builds:  a build variable on the Worker
//   - the id in wrangler.jsonc, when it isn't the placeholder;
//   - otherwise, in Cloudflare's Workers Builds only, the database the config names (`nalanda`) in the account this
//     deploys to — how a household's fork deploys, with nothing to set (runbooks/deploy.md): found by that name, or
//     created when there is none, near D1_LOCATION if that build variable is set. Never `main`: a household runs
//     deploy-site, the latest release. The cover bucket the config names is created by `wrangler deploy` itself when
//     it's missing.
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
import { chooseDatabaseId, configuredDatabase, findDatabase, withDatabaseId } from './database-id.mjs';

const SOURCE = 'wrangler.jsonc';
const RESOLVED = '.wrangler-deploy.jsonc';

const source = readFileSync(SOURCE, 'utf8');
const name = configuredDatabase(source).name || 'nalanda';
const LOCATIONS = ['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'];

function stop(message) {
  console.error(message);
  process.exit(1);
}

/** The account's database called `name`, by `wrangler d1 list` — '' when there is none. */
function lookUp() {
  try {
    const answer = execFileSync('wrangler', ['d1', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    return findDatabase(JSON.parse(answer), name);
  } catch {
    return stop(
      "Couldn't list this account's D1 databases. If the build's API token can't reach D1, give it D1 Edit: the Worker →\n" +
        'Settings → Build → API token (runbooks/troubleshooting.md).',
    );
  }
}

const chosen = chooseDatabaseId(process.env.D1_DATABASE_ID, source);
if (chosen.error && chosen.error !== 'no-id') stop(chosen.error);
let id = chosen.id;
if (id) {
  console.log(`Deploying with D1 database ${id} (${chosen.from === 'env' ? 'from D1_DATABASE_ID' : 'from wrangler.jsonc'}).`);
} else if (process.env.WORKERS_CI !== '1') {
  stop(
    'D1_DATABASE_ID is not set, and wrangler.jsonc has only the placeholder database id.\n\n' +
      'The D1 database id is deliberately not stored in this repository. Supply it at\n' +
      'deploy time — `wrangler d1 list` will show it:\n\n' +
      '  D1_DATABASE_ID=<id> npm run deploy\n\n' +
      'On Cloudflare Workers Builds, add it as a build variable instead — or, for a household\n' +
      "running a fork, leave it out: the build finds or creates the account's database itself.",
  );
} else if ((process.env.WORKERS_CI_BRANCH ?? '') === 'main') {
  stop(
    'This build is of `main`, which is work in progress. A library runs `deploy-site`, the latest release: set the\n' +
      "Worker's production branch to deploy-site (Settings → Build → Branch control), and your fork's default branch too.",
  );
} else {
  // a household's fork, in Workers Builds: no id anywhere, so the account's own database of this name
  id = lookUp();
  if (id) {
    console.log(`Deploying with this account's D1 database "${name}" (${id}).`);
  } else {
    const location = (process.env.D1_LOCATION ?? '').trim();
    if (location && !LOCATIONS.includes(location)) stop(`D1_LOCATION must be one of ${LOCATIONS.join(', ')} — not "${location}".`);
    console.log(`This account has no D1 database "${name}" yet: creating it${location ? ` near ${location}` : ''}.`);
    try {
      // never rewrites wrangler.jsonc, and asks nothing
      execFileSync('wrangler', ['d1', 'create', name, ...(location ? ['--location', location] : []), '--update-config=false'], { stdio: ['ignore', 'inherit', 'inherit'] });
    } catch {
      // another build made it a moment ago, or the create failed: what the account has now decides
    }
    id = lookUp();
    if (!id) stop(`Couldn't create the D1 database "${name}" — the lines above say why.`);
    console.log(`Using D1 database "${name}" (${id}).`);
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
