// Deploys: remote migrations, then `wrangler deploy` — against the right D1 database (ARCH.md §16 #24, #101).
//
// wrangler.jsonc ships with an all-zero placeholder, `"database_id": "00000000-0000-0000-0000-000000000000"`, so this
// repository names no specific Cloudflare resource. The id comes from, in order (scripts/database-id.mjs):
//   - D1_DATABASE_ID in the environment — how this repository's own deploys get it:
//       locally:                    D1_DATABASE_ID=<id> npm run deploy
//       Cloudflare Workers Builds:  a build variable on the Worker
//   - the id in wrangler.jsonc, when it isn't the placeholder;
//   - otherwise the database the config names (`nalanda`) in the account this deploys to — how a household's fork
//     deploys, with nothing to set (runbooks/deploy.md): found by that name, or created on the first deploy. The
//     cover bucket the config names is created by `wrangler deploy` itself when it's missing.
// Whichever it is, it is said before anything runs.
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

/** The account's database called `name`, by `wrangler d1 list` — '' when there is none. */
const lookUp = () => findDatabase(JSON.parse(execFileSync('wrangler', ['d1', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })), name);

const chosen = chooseDatabaseId(process.env.D1_DATABASE_ID, source);
if (chosen.error && chosen.error !== 'no-id') {
  console.error(chosen.error);
  process.exit(1);
}
let id = chosen.id;
if (id) {
  console.log(`Deploying with D1 database ${id} (${chosen.from === 'env' ? 'from D1_DATABASE_ID' : 'from wrangler.jsonc'}).`);
} else {
  // a household's fork: no id anywhere, so the account's own database of this name — made on the first deploy
  id = lookUp();
  if (id) {
    console.log(`Deploying with this account's D1 database "${name}" (${id}).`);
  } else {
    console.log(`This account has no D1 database "${name}" yet: creating it.`);
    execFileSync('wrangler', ['d1', 'create', name], { stdio: 'inherit' });
    id = lookUp();
    if (!id) {
      console.error(`Created the D1 database "${name}", but couldn't find it again — run the deploy once more.`);
      process.exit(1);
    }
    console.log(`Created D1 database "${name}" (${id}).`);
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
