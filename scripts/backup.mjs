// Data-only, per-table D1 backup. Whole-database export is impossible here:
// D1 refuses to export databases containing virtual tables (our FTS5 index).
// Schema is NOT backed up — it lives in migrations/. Restore = apply migrations,
// then execute each file in TABLE order (items inserts rebuild FTS via triggers).
// See runbooks/backup-and-restore.md.
//
//   node scripts/backup.mjs           # production (--remote)
//   node scripts/backup.mjs --local   # local dev database
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// FK-safe restore order. login_attempts (transient) and d1_migrations
// (recreated by `wrangler d1 migrations apply`) are deliberately excluded.
export const TABLES = ['users', 'libraries', 'shares', 'items', 'tags', 'item_tags', 'loans'];

const local = process.argv.includes('--local');
const stamp = new Date().toISOString().slice(0, 10);
const dir = `backups/${local ? 'local' : 'remote'}-${stamp}`;
mkdirSync(dir, { recursive: true });

for (const table of TABLES) {
  execFileSync(
    'npx',
    [
      'wrangler', 'd1', 'export', 'nalanda',
      local ? '--local' : '--remote',
      `--table=${table}`,
      '--no-schema',
      `--output=${dir}/${table}.sql`,
    ],
    { stdio: 'inherit' },
  );
}

console.log(`\nBackup written to ${dir}/`);
console.log(`Restore: apply migrations to the target db, then execute in order: ${TABLES.join(' → ')}`);
