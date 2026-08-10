import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// vitest-pool-workers v0.20 removed automatic per-test isolated storage in favour of an
// explicit reset(), which empties every attached binding — D1 and R2 both. Tests here
// assume a clean, fully-migrated database (holdingsByType, for one, counts across the
// whole catalog), so wipe and re-migrate before each of them.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
