// Deploys with the D1 database id supplied by the environment instead of the repo.
//
// wrangler.jsonc ships with `"database_id": ""` so the repo names no specific
// Cloudflare resource. Wrangler does not interpolate environment variables inside its
// config file — a literal "${D1_DATABASE_ID}" is sent to the API verbatim — so this
// writes a resolved copy of the config and points wrangler at that. The copy lives in
// the project root because wrangler resolves `main`, `assets`, and `migrations_dir`
// relative to the config file's own directory; it is gitignored.
//
// Set D1_DATABASE_ID wherever you deploy from:
//   - locally:   D1_DATABASE_ID=<id> npm run deploy
//   - Cloudflare Workers Builds: add it as a build variable on the Worker
//
// `wrangler d1 create nalanda` prints the id; `wrangler d1 list` shows it again later.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const SOURCE = 'wrangler.jsonc';
const RESOLVED = '.wrangler-deploy.jsonc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const id = (process.env.D1_DATABASE_ID ?? '').trim();
if (!id) {
  console.error(
    'D1_DATABASE_ID is not set.\n\n' +
      'The D1 database id is deliberately not stored in this repository. Supply it at\n' +
      'deploy time — `wrangler d1 list` will show it:\n\n' +
      '  D1_DATABASE_ID=<id> npm run deploy\n\n' +
      'On Cloudflare Workers Builds, add it as a build variable instead.',
  );
  process.exit(1);
}
if (!UUID.test(id)) {
  console.error(`D1_DATABASE_ID is not a UUID: ${id}`);
  process.exit(1);
}

const source = readFileSync(SOURCE, 'utf8');
const resolved = source.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${id}"`);
if (resolved === source) {
  console.error(`No database_id field found in ${SOURCE} — has the config changed shape?`);
  process.exit(1);
}
writeFileSync(RESOLVED, resolved);

const run = (args) => execFileSync('wrangler', [...args, '--config', RESOLVED], { stdio: 'inherit' });

try {
  run(['d1', 'migrations', 'apply', 'nalanda', '--remote']);
  run(['deploy']);
} finally {
  rmSync(RESOLVED, { force: true });
}
