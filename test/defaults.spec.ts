// New defaults, same instance (ARCH.md §16 #49): a new instance starts with names on share pages, names to connections
// and goals to connections all on; an instance that already had members keeps exactly the switches it had — migration
// 0036 writes down the old defaults for one that never saved any, and a saved row is left alone.
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createFirstAdmin, getSiteSettings, outwardName, setDisplayName } from '../src/db/queries';

const settingsRow = () => env.DB.prepare('SELECT * FROM site_settings').all().then((r) => r.results);
const through = (last: string) => env.TEST_MIGRATIONS.filter((m) => m.name.slice(0, 4) <= last);

/**
 * An instance from before goals: migrated through `last` — 0034 for one on 1.4 or with the features after it, 0027
 * for one still on 1.3.0 — then set up, its admin made, and maybe a switch saved. The admin goes in by hand, since a
 * 1.3.0 schema has no session_key for createFirstAdmin to write.
 */
async function onVersionBefore(last: string, row?: Record<string, number>) {
  await reset();
  await applyD1Migrations(env.DB, through(last));
  const admin = (await env.DB.prepare("INSERT INTO users (username, password_hash, role) VALUES ('owner', 'pbkdf2$1$x$y', 'admin') RETURNING id").first<{ id: number }>())!.id;
  if (row) {
    const cols = Object.keys(row);
    await env.DB.prepare(`INSERT INTO site_settings (id, ${cols.join(', ')}) VALUES (1, ${cols.map((_, i) => `?${i + 1}`).join(', ')})`)
      .bind(...Object.values(row))
      .run();
  }
  return admin;
}

describe('the switches a household starts with', () => {
  it('a new instance: names on share pages, names to connections and goals to connections all on — with no row at all', async () => {
    // the harness migrates a new, empty database before every test: what a fresh deploy does before /setup
    expect(await settingsRow()).toEqual([]);
    expect(await getSiteSettings(env.DB)).toEqual({
      progressOnShares: false,
      progressToConnections: true,
      namesOnShares: true,
      namesToConnections: true,
      goalsToConnections: true,
      currency: null, // §16 #61: none until an admin sets one
    });
    // and setting it up writes no row: the defaults stand until an admin saves a switch
    const admin = (await createFirstAdmin(env.DB, { username: 'owner', passwordHash: 'pbkdf2$1$x$y' }, ['Books']))!.id;
    expect(await settingsRow()).toEqual([]);
    // the SQL fallback agrees with the code's: a comment goes out signed with the display name
    await setDisplayName(env.DB, admin, 'Asha');
    expect(await outwardName(env.DB, admin)).toBe('Asha');
  });

  it.each(['0034', '0027'])('an instance at %s upgraded with members and no saved switches: 0036 writes down the old defaults — everything stays off', async (last) => {
    const admin = await onVersionBefore(last);
    expect(await settingsRow()).toEqual([]); // it ran on its code's defaults: names off
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    // 1.4's session keys don't get in the way: the member is there, with a key from 0029's backfill or none yet
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>()).toEqual({ n: 1 });
    expect(await settingsRow()).toEqual([
      expect.objectContaining({ id: 1, progress_on_shares: 0, progress_to_connections: 1, names_on_shares: 0, names_to_connections: 0, goals_to_connections: 0 }),
    ]);
    expect(await getSiteSettings(env.DB)).toEqual({
      progressOnShares: false,
      progressToConnections: true,
      namesOnShares: false,
      namesToConnections: false,
      goalsToConnections: false,
      currency: null, // §16 #61: an upgrade sets none; the item form asks an admin to
    });
    await setDisplayName(env.DB, admin, 'Asha');
    expect(await outwardName(env.DB, admin)).toBe('A member'); // as before the upgrade
  });

  it('an instance upgraded with its switches saved keeps every one of them, and gets goals off', async () => {
    for (const row of [
      { progress_on_shares: 1, progress_to_connections: 0, names_on_shares: 0, names_to_connections: 1 }, // production's shape since 1.3.0
      { progress_on_shares: 0, progress_to_connections: 1, names_on_shares: 1, names_to_connections: 0 },
      { progress_on_shares: 0, progress_to_connections: 1, names_on_shares: 0, names_to_connections: 0 },
    ]) {
      await onVersionBefore('0034', row);
      const before = (await settingsRow())[0] as Record<string, unknown>;
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
      const after = (await settingsRow())[0] as Record<string, unknown>;
      // updated_at and all; 0037 adds the household currency, unset (§16 #61)
      expect(after, JSON.stringify(row)).toEqual({ ...before, goals_to_connections: 0, currency: null });
    }
  });

  it('an instance migrated but never set up is a new instance: no row, the new defaults', async () => {
    await reset();
    await applyD1Migrations(env.DB, through('0034'));
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await settingsRow()).toEqual([]);
    expect((await getSiteSettings(env.DB)).namesToConnections).toBe(true);
  });
});
