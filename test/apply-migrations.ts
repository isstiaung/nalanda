import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect } from 'vitest';

// vitest-pool-workers v0.20 removed automatic per-test isolated storage in favour of an
// explicit reset(), which empties every attached binding — D1 and R2 both. Tests here
// assume a clean, fully-migrated database (holdingsByType, for one, counts across the
// whole catalog), so wipe and re-migrate before each of them.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// No test may log an error it didn't ask for. An error the app logs is either a bug or something a test
// provoked on purpose — and a test that provokes one captures it and checks it (test/console.ts). Left in
// the output, they piled up until a real one (a spent budget Drizzle had wrapped) passed as noise.
// The record lives on the wrapper, so a test file that finds console.error already wrapped by another shares
// it, rather than keeping a list of its own that nothing writes to.
type Recorder = ((...args: unknown[]) => void) & { logged: unknown[][] };
const RECORDER = Symbol.for('nalanda.test.console-error');
const holder = globalThis as unknown as Record<symbol, Recorder | undefined>;
if (!holder[RECORDER]) {
  const original = console.error.bind(console);
  const recorder = Object.assign((...args: unknown[]) => {
    recorder.logged.push(args);
    original(...args);
  }, { logged: [] as unknown[][] });
  holder[RECORDER] = recorder;
  console.error = recorder;
}
const recorder = holder[RECORDER]!;
beforeEach(() => {
  recorder.logged.length = 0;
});
afterEach(() => {
  expect(recorder.logged, 'logged an error the test did not capture — see test/console.ts').toEqual([]);
});
