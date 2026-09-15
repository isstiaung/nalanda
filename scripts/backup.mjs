// Data-only, per-table D1 backup. Whole-database export is impossible here:
// D1 refuses to export databases containing virtual tables (our FTS5 index).
// Schema is NOT backed up — it lives in migrations/. Restore = apply migrations,
// then execute each file in TABLE order (items inserts rebuild FTS via triggers).
// See runbooks/backup-and-restore.md.
//
//   node scripts/backup.mjs           # production (--remote)
//   node scripts/backup.mjs --local   # local dev database
//
// Production is reached through a copy of the config holding the real database id (scripts/remote-config.mjs),
// deleted when the backup ends, however it ends.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATABASE, removeRemoteConfig, writeRemoteConfig } from './remote-config.mjs';

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

// D1's export API fails transiently now and then ("createMultipartUpload: internal error"), so each table
// gets a few tries, further apart each time.
const RETRY_PAUSES_MS = [5_000, 15_000];

const local = process.argv.includes('--local');

if (!local) {
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
}

const config = local ? null : writeRemoteConfig('npm run backup');

// Ctrl-C reaches wrangler too, which stops. Noted here rather than ending this process on the spot, so the
// backup stops without retrying and the config copy is still deleted.
let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
});

const stamp = new Date().toISOString().slice(0, 10);
const dir = `backups/${local ? 'local' : 'remote'}-${stamp}`;
mkdirSync(dir, { recursive: true });

/** One table's export, retried after each pause in RETRY_PAUSES_MS: 'done', 'failed' or 'interrupted'. */
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
      return 'done';
    } catch (err) {
      if (interrupted || err.signal || err.status === 130) return 'interrupted';
      if (attempt === attempts) return 'failed';
      const pause = RETRY_PAUSES_MS[attempt - 1];
      console.warn(`\nExporting ${table} failed (attempt ${attempt} of ${attempts}); trying again in ${pause / 1000}s.`);
      await sleep(pause);
      if (interrupted) return 'interrupted';
    }
  }
}

let stopped = null;
try {
  for (const table of TABLES) {
    const outcome = await exportTable(table);
    if (outcome !== 'done') {
      stopped = { table, outcome };
      break;
    }
  }
} finally {
  if (config) removeRemoteConfig();
}

if (stopped?.outcome === 'interrupted') {
  console.error(`\nBackup interrupted at ${stopped.table}. The tables before it are in ${dir}/.`);
  process.exit(130);
}
if (stopped) {
  console.error(
    `\nBackup incomplete: ${stopped.table} failed on every attempt, so the tables after it weren't exported.\n` +
      `The ones before it are in ${dir}/. Try again in a few minutes.`,
  );
  process.exit(1);
}

console.log(`\nBackup written to ${dir}/`);
console.log(`Restore: apply migrations to the target db, then execute in order: ${TABLES.join(' → ')}`);
