// Data-only, per-table D1 backup. Whole-database export is impossible here:
// D1 refuses to export databases containing virtual tables (our FTS5 index).
// Schema is NOT backed up — it lives in migrations/. Restore = apply migrations,
// then execute each file in TABLE order (items inserts rebuild FTS via triggers).
// See runbooks/backup-and-restore.md.
//
//   node scripts/backup.mjs           # production (--remote)
//   node scripts/backup.mjs --local   # local dev database
//
// wrangler.jsonc carries an all-zero placeholder database_id, which the remote API rejects. So, as
// scripts/deploy.mjs does, a production backup runs against a gitignored copy of the config holding the
// real id: D1_DATABASE_ID when it's set, otherwise the id of the database named `nalanda` in the account
// wrangler is logged in to. The copy is deleted when the backup ends, however it ends.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

// FK-safe restore order. login_attempts (transient) and d1_migrations
// (recreated by `wrangler d1 migrations apply`) are deliberately excluded.
// federation_seen and connection_push_counts are left out on purpose: replay and rate bookkeeping that's
// worthless within a day. The federation private key isn't data at all — it's a secret.
export const TABLES = [
  'users',
  'libraries',
  'shares',
  'items',
  'tags',
  'item_tags',
  'loans',
  'federation_settings',
  'connection_invites', // before connections, which reference it
  'connections',
  'connection_views',
  'activity_log',
  'feed_subscriptions', // after connections
  'remote_activities', // after feed_subscriptions
  'comments',
  'outbox',
  'borrow_requests',
  'connection_loans', // after loans and borrow_requests
  'borrowed_items',
];

const DATABASE = 'nalanda';
const SOURCE = 'wrangler.jsonc';
const RESOLVED = '.wrangler-backup.jsonc';
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

const local = process.argv.includes('--local');

let config = null;
if (!local) {
  const id = productionDatabaseId();
  if (!UUID.test(id)) {
    console.error(
      `Couldn't find the id of the "${DATABASE}" D1 database. Log in with \`npx wrangler login\`,\n` +
        'or set D1_DATABASE_ID yourself — `npx wrangler d1 list` shows it:\n\n' +
        '  D1_DATABASE_ID=<id> npm run backup',
    );
    process.exit(1);
  }
  const source = readFileSync(SOURCE, 'utf8');
  const resolved = source.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${id}"`);
  if (resolved === source) {
    console.error(`No database_id field found in ${SOURCE} — has the config changed shape?`);
    process.exit(1);
  }
  writeFileSync(RESOLVED, resolved);
  config = RESOLVED;
}

const stamp = new Date().toISOString().slice(0, 10);
const dir = `backups/${local ? 'local' : 'remote'}-${stamp}`;
mkdirSync(dir, { recursive: true });

try {
  for (const table of TABLES) {
    execFileSync(
      'npx',
      [
        'wrangler', 'd1', 'export', DATABASE,
        local ? '--local' : '--remote',
        ...(config ? ['--config', config] : []),
        `--table=${table}`,
        '--no-schema',
        `--output=${dir}/${table}.sql`,
      ],
      { stdio: 'inherit' },
    );
  }
} finally {
  if (config) rmSync(config, { force: true });
}

console.log(`\nBackup written to ${dir}/`);
console.log(`Restore: apply migrations to the target db, then execute in order: ${TABLES.join(' → ')}`);
