// vitest-pool-workers v0.20 replaced `defineWorkersConfig` + `test.poolOptions.workers`
// with a plain Vitest config and a `cloudflareTest()` Vite plugin carrying the same
// options. (The package ships a codemod for this, but it only handles the object form —
// ours builds migrations asynchronously first.)
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  // relative to project root, where vitest runs
  const migrations = await readD1Migrations('./migrations');
  return {
    // public/ is the Worker's static files, bound below as ASSETS for tests to fetch as served; Vite's own notion of a
    // publicDir would refuse to import a module from it, and test/quotes.spec.ts imports public/kindle.js, the browser's
    // Kindle parser, to run the very code the browser runs (ARCH.md §16 #77).
    publicDir: false as const,
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Tests only: the Worker never reads its static files — Cloudflare serves them before it runs, which
          // SELF skips. Binding them lets a test fetch /sw.js or the manifest as a browser gets them, headers
          // and all, from the same asset server `wrangler dev` uses (test/pwa.spec.ts).
          assets: { directory: './public', binding: 'ASSETS' },
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: 'test-secret-not-for-production',
            // Whatever a developer's .dev.vars holds, tests see what CI sees: none of the optional secrets.
            // A test that wants one passes it itself. (A FEDERATION_PRIVATE_KEY there turned connections
            // on for every test and failed the ones that expect an instance without them.)
            FEDERATION_PRIVATE_KEY: '',
            BGG_TOKEN: '',
            DISCOGS_TOKEN: '',
            GOOGLE_BOOKS_KEY: '',
            HOME_SHARE_TOKEN: '',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      // agents' git worktrees live under .claude/ — their copies of the suite test their own code
      exclude: [...configDefaults.exclude, '.claude/**'],
    },
  };
});
