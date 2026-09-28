// isBudgetSpent must see through the wrapper Drizzle puts around a failed query.
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { BudgetSpent, budgeted, isBudgetSpent } from '../src/federation/budget';

describe('isBudgetSpent', () => {
  it('recognizes a spent budget inside a Drizzle query error', async () => {
    const db = drizzle(budgeted(env.DB, { left: 0 }), { schema: s });
    const err = await db.select().from(s.items).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(BudgetSpent); // Drizzle wraps it…
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(BudgetSpent); // …with the original as its cause
    expect(isBudgetSpent(err)).toBe(true);
  });

  it('is false for any other error', () => {
    expect(isBudgetSpent(new Error('D1 is down'))).toBe(false);
    expect(isBudgetSpent(new Error('wrapped', { cause: new Error('still not a budget') }))).toBe(false);
    expect(isBudgetSpent(null)).toBe(false);
  });
});
