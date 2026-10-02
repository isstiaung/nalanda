// Deploys: remote migrations, then `wrangler deploy` — against the right D1 database (ARCH.md §16 #24, #101).
//
// wrangler.jsonc ships with an all-zero placeholder, `"database_id": "00000000-0000-0000-0000-000000000000"`, so this
// repository names no specific Cloudflare resource. The id comes from, in order (scripts/database-id.mjs):
//   - D1_DATABASE_ID in the environment — how this repository's own deploys get it:
//       locally:                    D1_DATABASE_ID=<id> npm run deploy
//       Cloudflare Workers Builds:  a build variable on the Worker
//   - the id in wrangler.jsonc, when it isn't the placeholder — a copy made with the Deploy to Cloudflare button,
//     whose database the button created and wrote in.
// Neither, and it stops: it never guesses. `wrangler d1 list` shows the id.
//
// Wrangler doesn't interpolate environment variables inside its config file, so this writes a resolved copy and points
// wrangler at it. The copy lives in the project root, because wrangler resolves `main`, `assets` and `migrations_dir`
// relative to the config file's own directory; it is gitignored. Migrations name the database as the config does —
// `nalanda` here, whatever a button copy's is — so wrangler finds that entry, and the id written into it.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chooseDatabaseId, configuredDatabase, withDatabaseId } from './database-id.mjs';

const SOURCE = 'wrangler.jsonc';
const RESOLVED = '.wrangler-deploy.jsonc';

const source = readFileSync(SOURCE, 'utf8');
const chosen = chooseDatabaseId(process.env.D1_DATABASE_ID, source);
if (chosen.error === 'no-id') {
  console.error(
    'D1_DATABASE_ID is not set, and wrangler.jsonc has only the placeholder database id.\n\n' +
      'The D1 database id is deliberately not stored in this repository. Supply it at\n' +
      'deploy time — `wrangler d1 list` will show it:\n\n' +
      '  D1_DATABASE_ID=<id> npm run deploy\n\n' +
      'On Cloudflare Workers Builds, add it as a build variable instead.',
  );
  process.exit(1);
}
if (chosen.error) {
  console.error(chosen.error);
  process.exit(1);
}
const resolved = withDatabaseId(source, chosen.id);
if (resolved === null) {
  console.error(`No database_id field found in ${SOURCE} — has the config changed shape?`);
  process.exit(1);
}
console.log(`Deploying with D1 database ${chosen.id} (${chosen.from === 'env' ? 'from D1_DATABASE_ID' : 'from wrangler.jsonc'}).`);
writeFileSync(RESOLVED, resolved);

const run = (args) => execFileSync('wrangler', [...args, '--config', RESOLVED], { stdio: 'inherit' });

try {
  run(['d1', 'migrations', 'apply', configuredDatabase(source).name || 'nalanda', '--remote']);
  run(['deploy']);
} finally {
  rmSync(RESOLVED, { force: true });
}
