// vitest-pool-workers v0.20 replaced `defineWorkersConfig` + `test.poolOptions.workers`
// with a plain Vitest config and a `cloudflareTest()` Vite plugin carrying the same
// options. (The package ships a codemod for this, but it only handles the object form —
// ours builds migrations asynchronously first.)
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  // relative to project root, where vitest runs
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: 'test-secret-not-for-production',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
