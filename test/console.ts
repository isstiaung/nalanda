// Tests that make the app fail on purpose — out of D1 budget at every point in turn, or handed a malformed key —
// would print every error the app logs into the test output, where a real one would hide among them. These take
// console.error in and check it instead: only what the test expects may be logged, and anything else fails it.
import { expect, onTestFinished, vi } from 'vitest';
import { isBudgetSpent } from '../src/federation/budget';

/** console.error until the test ends: kept out of the output and handed back, for the test to check. */
export function captureErrors() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  return spy;
}

/**
 * For a test that runs the app out of query budget on purpose: the app may log the spent budget — alone or
 * wrapped, as Drizzle wraps it — and nothing else. Anything else logged fails the test.
 */
export function expectOnlyBudgetErrors(): void {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => {
    const other = spy.mock.calls.filter((args) => !args.some(isBudgetSpent));
    spy.mockRestore();
    expect(other, 'logged an error other than the spent budget').toEqual([]);
  });
}
