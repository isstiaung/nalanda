// Migrations are additive only, from 0063 on (ARCH.md §16 #102): a household's fork applies a release's migrations the
// moment it presses Sync fork, unattended, usually with no backup taken — so a migration adds, and never removes or
// rewrites. Everything up to 0062 (released by 1.10.0) is as it was.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const FIRST_ADDITIVE = '0063';

/** Migrations let past the rule, each with the decision that allows it: none. */
const EXCEPTIONS: Record<string, string> = {};

/** What a statement does that a migration may not — '' when it only adds. A trigger's body is code for later, not a
 *  change now, and the full-text index (`*_fts`) holds only a copy of the items' text, rebuilt in the same migration. */
export function notAdditive(statement: string): string {
  const sql = statement.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (/^CREATE\s+TRIGGER\b/i.test(sql)) return '';
  const drop = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)/i.exec(sql);
  if (drop) return /_fts$/.test(drop[1]!) ? '' : `drops the table ${drop[1]}`;
  if (/\bDROP\s+COLUMN\b/i.test(sql)) return 'drops a column';
  if (/\bRENAME\b/i.test(sql)) return 'renames';
  if (/^DELETE\s+FROM\b/i.test(sql)) return 'deletes rows';
  if (/^UPDATE\b/i.test(sql)) return 'updates rows';
  if (/^(REPLACE\s+INTO|INSERT\s+OR\s+REPLACE)\b/i.test(sql)) return 'replaces rows';
  return '';
}

describe('migrations from 0063 on', () => {
  it('only add: no table or column dropped, nothing renamed, no row updated, deleted or replaced', () => {
    const found: string[] = [];
    for (const migration of env.TEST_MIGRATIONS) {
      if (migration.name.slice(0, 4) < FIRST_ADDITIVE || EXCEPTIONS[migration.name]) continue;
      for (const query of migration.queries) {
        const why = notAdditive(query);
        if (why) found.push(`${migration.name}: ${why} — ${query.slice(0, 80)}`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe('the rule', () => {
  it('lets through what only adds', () => {
    for (const ok of [
      'CREATE TABLE `shelf_notes` (`id` integer PRIMARY KEY)',
      'ALTER TABLE `items` ADD `subtitle` text',
      "ALTER TABLE `items` ADD `kept` integer DEFAULT 0 NOT NULL",
      'CREATE INDEX `idx_items_subtitle` ON `items` (`subtitle`)',
      'DROP INDEX IF EXISTS `idx_items_subtitle`',
      'DROP TRIGGER IF EXISTS `items_fts_au`',
      'DROP TABLE IF EXISTS `items_fts`',
      "INSERT INTO items_fts(items_fts) VALUES('rebuild')",
      'INSERT INTO `shelf_notes` (`id`) SELECT id FROM libraries',
      'CREATE TRIGGER t AFTER UPDATE ON items BEGIN UPDATE items SET updated_at = 1 WHERE id = new.id; END',
    ]) {
      expect(notAdditive(ok), ok).toBe('');
    }
  });

  it('stops what removes or rewrites — a drizzle table rebuild included', () => {
    for (const [bad, why] of [
      ['DROP TABLE `items`', 'drops the table items'],
      ['DROP TABLE IF EXISTS `loans`', 'drops the table loans'],
      ['ALTER TABLE `items` DROP COLUMN `notes`', 'drops a column'],
      ['ALTER TABLE `__new_items` RENAME TO `items`', 'renames'],
      ['ALTER TABLE `items` RENAME COLUMN `notes` TO `memo`', 'renames'],
      ['DELETE FROM `login_attempts`', 'deletes rows'],
      ["UPDATE `items` SET `status` = 'completed'", 'updates rows'],
      ["-- a comment first\nUPDATE items SET status = 'x'", 'updates rows'],
      ['INSERT OR REPLACE INTO `site_settings` (`id`) VALUES (1)', 'replaces rows'],
      ['REPLACE INTO `site_settings` (`id`) VALUES (1)', 'replaces rows'],
    ] as const) {
      expect(notAdditive(bad), bad).toBe(why);
    }
  });
});
