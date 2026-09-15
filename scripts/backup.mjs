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
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';

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
// D1's export API fails transiently now and then ("createMultipartUpload: internal error"), so each table
// gets a few tries, further apart each time.
const RETRY_PAUSES_MS = [5_000, 15_000];

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
  // wrangler asks before every remote export. Asked once here instead; its own prompts are skipped by
  // running it without stdin, which it treats as agreement.
  console.warn(`⚠️  Each of the ${TABLES.length} table exports makes the production database briefly unavailable to queries.`);
  if (process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    // Input closing at the prompt (Ctrl-D) rejects the question; that's a no, not a crash.
    const answer = await prompt.question('Ok to proceed? (y/N) ').then((a) => a.trim().toLowerCase(), () => '');
    prompt.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Nothing exported.');
      process.exit(0);
    }
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

/** One table's export, retried after each pause in RETRY_PAUSES_MS. False once every attempt has failed. */
async function exportTable(table) {
  const args = [
    'wrangler', 'd1', 'export', DATABASE,
    local ? '--local' : '--remote',
    ...(config ? ['--config', config] : []),
    `--table=${table}`,
    '--no-schema',
    `--output=${dir}/${table}.sql`,
  ];
  const attempts = RETRY_PAUSES_MS.length + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('npx', args, { stdio: ['ignore', 'inherit', 'inherit'] });
      return true;
    } catch {
      if (attempt === attempts) return false;
      const pause = RETRY_PAUSES_MS[attempt - 1];
      console.warn(`\nExporting ${table} failed (attempt ${attempt} of ${attempts}); trying again in ${pause / 1000}s.`);
      await sleep(pause);
    }
  }
}

let failed = null;
try {
  for (const table of TABLES) {
    if (!(await exportTable(table))) {
      failed = table;
      break;
    }
  }
} finally {
  if (config) rmSync(config, { force: true });
}

if (failed) {
  console.error(
    `\nBackup incomplete: ${failed} failed on every attempt, so the tables after it weren't exported.\n` +
      `The ones before it are in ${dir}/. Try again in a few minutes.`,
  );
  process.exit(1);
}

console.log(`\nBackup written to ${dir}/`);
console.log(`Restore: apply migrations to the target db, then execute in order: ${TABLES.join(' → ')}`);
