// D1 calls are capped per Worker invocation, and work handed to waitUntil belongs to the invocation of the
// page that started it. The design budget is the documented free-plan figure, 50; measured on this account
// the runtime allows 1,000, and a batch counts as one call however many statements it holds (ARCH.md §16
// #37). Background work — pulling feeds and outboxes — runs against a handle that refuses the call that
// would overspend its share. The work stops cleanly at a point it can resume from, and the page that started
// it never runs short.
export class BudgetSpent extends Error {
  constructor() {
    super('this request’s D1 query budget for background work is spent');
  }
}

export const isBudgetSpent = (err: unknown): boolean => err instanceof BudgetSpent;

export type Budget = { left: number };

const INNER = Symbol('inner statement');

function counted(inner: D1PreparedStatement, spend: (n: number) => void): D1PreparedStatement {
  const statement = {
    [INNER]: inner,
    bind: (...values: unknown[]) => counted(inner.bind(...values), spend),
    first: (...args: unknown[]) => {
      spend(1);
      return (inner.first as (...a: unknown[]) => Promise<unknown>)(...args);
    },
    run: () => {
      spend(1);
      return inner.run();
    },
    all: () => {
      spend(1);
      return inner.all();
    },
    raw: (...args: unknown[]) => {
      spend(1);
      return (inner.raw as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
  return statement as unknown as D1PreparedStatement;
}

const unwrap = (statement: D1PreparedStatement): D1PreparedStatement =>
  (statement as unknown as Record<symbol, D1PreparedStatement>)[INNER] ?? statement;

/** A D1 handle that counts every call it makes against `budget` — a batch is one call, as the runtime counts it. */
export function budgeted(d1: D1Database, budget: Budget): D1Database {
  const spend = (n: number) => {
    if (budget.left < n) throw new BudgetSpent();
    budget.left -= n;
  };
  const handle = {
    prepare: (query: string) => counted(d1.prepare(query), spend),
    batch: (statements: D1PreparedStatement[]) => {
      spend(1); // one request to D1, however many statements: measured, §16 #37
      return d1.batch(statements.map(unwrap));
    },
    exec: (query: string) => {
      spend(1);
      return d1.exec(query);
    },
    dump: () => d1.dump(),
  };
  return handle as unknown as D1Database;
}
