import { applyD1Migrations, env } from 'cloudflare:test';

// Runs in each isolated test storage — gives every test a fully migrated D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
