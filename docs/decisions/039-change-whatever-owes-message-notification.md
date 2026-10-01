# §16 #39 — A change and whatever it owes — a message, a notification, a replay marker — are one batch

**Decided:** 2026-09-28 (measured, not assumed). Cited as `ARCH.md §16 #39`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Two pre-deploy reviews proved the same failure in a dozen places: a write, then a
second write that depends on it, as separate D1 calls. A failure between them — a transient
D1 error, an exceeded CPU limit, or an outbox pull out of budget — kept the first alone, and
the path's own idempotency check then treated the job as done: a comment stored here, never
sent, and doubled on a second Send; a lend or a decline the other household was never told
about; a notification that never came; a connection message whose replay marker turned every
retry away. Now the message is queued in the same batch as its change (`queueWith`), only
while the change's own precondition holds, and the change runs only once the message is in
the outbox — a fresh activity id makes that exact, and lets lending pick up its new loan's
id inside the batch. A borrow request is queued only while none for that book is waiting, so
a double submit makes one request. Notifications ride along the same way (`notifyIf`), and so do replay
markers (`applyConnectionMessage`). Anything after the batch — the push, a prune — must be
unable to fail the request, or the person's retry repeats a change already made. Drizzle's
batch can't take raw SQL with parameters, so batches that need both are built as plain D1
statements (`statement()`).
