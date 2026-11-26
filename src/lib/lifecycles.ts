// Every status column that moves is a state machine (ARCH.md §16 #105). Its moves are declared here, as data, and
// nowhere else: the statements in src/db/federation.ts that move a status take `to` and `from` from these tables, so a
// move can't happen from a state this file doesn't list, and a reader — a person or an agent — finds the whole of a
// lifecycle in one place instead of piecing it together from WHERE clauses. test/lifecycles.spec.ts checks the tables
// (every state reachable, every move between real states, the terminal ones stay put), that no statement in src/db
// writes one of these columns by hand, and that docs/state-machines.md draws exactly what is declared here.
//
// Pure data and functions: nothing here touches D1.
import {
  BORROW_STATUSES,
  CONNECTION_STATUSES,
  RECOMMENDATION_STATUSES,
  type BorrowStatus,
  type ConnectionStatus,
  type RecommendationStatus,
} from '../db/schema';

/** One move: the states it may start from, and the state it lands in. */
export type Move<S extends string> = { readonly from: readonly S[]; readonly to: S; readonly why: string };

export type Lifecycle<S extends string, E extends string> = {
  /** The column, as `table.column`. */
  readonly column: string;
  readonly states: readonly S[];
  /** The states a row is inserted in. */
  readonly initial: readonly S[];
  readonly moves: { readonly [event in E]: Move<S> };
};

function lifecycle<S extends string, E extends string>(
  column: string,
  states: readonly S[],
  initial: readonly S[],
  moves: { readonly [event in E]: Move<S> },
): Lifecycle<S, E> {
  return { column, states, initial, moves };
}

/**
 * A request to borrow one book (`borrow_requests.status`, connections phase 4). The same activity id names it on both
 * sides; each side moves its own row when the message arrives. "Returned" is not a status: it is an accepted request
 * whose Borrowed entry came back (recentOutgoing()).
 */
export const BORROW_REQUEST = lifecycle('borrow_requests.status', BORROW_STATUSES, ['pending'], {
  withdraw: { from: ['pending'], to: 'withdrawn', why: 'the asker took it back before an answer' },
  decline: { from: ['pending'], to: 'declined', why: 'the lender said no, or refused the request outright' },
  lend: { from: ['pending'], to: 'accepted', why: 'we lent the book asked for: a loan made in the same batch' },
  theyLent: {
    from: ['pending', 'withdrawn'],
    to: 'accepted',
    why: 'they lent ours — even after we withdrew, since the book is on its way; it goes on Borrowed',
  },
});
export type BorrowEvent = keyof typeof BORROW_REQUEST.moves;

/**
 * A recommendation between two households (`recommendations.status`, ARCH.md §16 #58). `incoming` rows are theirs to
 * us, answered here and never told back; outgoing rows are ours, and only their refusal moves one.
 */
export const RECOMMENDATION = lifecycle('recommendations.status', RECOMMENDATION_STATUSES, ['open'], {
  dismiss: { from: ['open'], to: 'dismissed', why: 'theirs, put aside here; the sender is never told' },
  want: { from: ['open'], to: 'wanted', why: 'theirs, onto a member’s want list; the sender is never told' },
  refuse: { from: ['open'], to: 'refused', why: 'ours, turned away for good by them' },
});
export type RecommendationEvent = keyof typeof RECOMMENDATION.moves;

/**
 * A connection with another household (`connections.status`). Made waiting on one side or the other, depending on
 * whose invite was redeemed; it ends by deleting the row (Disconnect, Decline), never by a status.
 */
export const CONNECTION = lifecycle('connections.status', CONNECTION_STATUSES, ['awaiting_us', 'awaiting_them'], {
  confirm: { from: ['awaiting_us'], to: 'active', why: 'an admin here confirmed them, and they took the confirmation' },
  confirmed: { from: ['awaiting_them'], to: 'active', why: 'their admin confirmed us (ConnectAccept)' },
});
export type ConnectionEvent = keyof typeof CONNECTION.moves;

/** Every declared lifecycle, each seen as any lifecycle — for what reads them all alike (the test, the docs). */
export const LIFECYCLES: readonly Lifecycle<string, string>[] = [BORROW_REQUEST, RECOMMENDATION, CONNECTION];

/** The SQL list of a move's starting states, `('pending', 'withdrawn')`, for a raw statement's `status IN …`. */
export function fromSql<S extends string>(move: Move<S>): string {
  // the values are this file's own constants, but a statement is no place to trust that: only [a-z_] gets through
  for (const s of move.from) if (!/^[a-z_]+$/.test(s)) throw new Error(`not a status: ${s}`);
  return `(${move.from.map((s) => `'${s}'`).join(', ')})`;
}

/** Whether a row in `status` may make `move` — the guard every statement also applies in its WHERE. */
export function canMove<S extends string>(move: Move<S>, status: S): boolean {
  return move.from.includes(status);
}

/** States no move leaves. */
export function terminal<S extends string, E extends string>(l: Lifecycle<S, E>): S[] {
  const moves = Object.values(l.moves) as Move<S>[];
  return l.states.filter((s) => !moves.some((m) => m.from.includes(s)));
}

/** The lifecycle as a Mermaid state diagram — what docs/state-machines.md shows, checked against this by a test. */
export function diagram<S extends string, E extends string>(l: Lifecycle<S, E>): string {
  const lines = ['stateDiagram-v2'];
  for (const s of l.initial) lines.push(`  [*] --> ${s}`);
  for (const [event, move] of Object.entries(l.moves) as [string, Move<S>][]) {
    for (const from of move.from) lines.push(`  ${from} --> ${move.to}: ${event}`);
  }
  for (const s of terminal(l)) lines.push(`  ${s} --> [*]`);
  return lines.join('\n');
}

// re-exported so a caller needs one import for a lifecycle and its states
export type { BorrowStatus, ConnectionStatus, RecommendationStatus };
