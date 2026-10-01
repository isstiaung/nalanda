# §16 #92 — `FEDERATION_OFFLINE`: a plain runtime variable under which an instance contacts no connected household, for a copy of the database restored anywhere but production

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #92`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

On 2026-09-30 a production backup was restored into a local instance whose `.dev.vars` held a
development `FEDERATION_PRIVATE_KEY`. Its `connections` table still named the real households, so
the first page load pulled every peer's outbox and retried every undelivered push against them,
signed with the wrong key; their 401 was taken as a refusal (fixed beside this, in `outbox.ts`), the
copy's outbox was purged and its pending requests marked declined. With the production key in
`.dev.vars`, the pushes would have landed. Nothing in the code stood between a restored copy and its
peers; the restore runbook had no step for it. **The owner decided** on a switch in the code — a
runbook step alone is forgotten, and a restore script that blanks `connections.base_url` would
change the data being inspected.

**What was decided:**
- **`FEDERATION_OFFLINE` is a plain runtime variable, not a secret** — a `vars` entry in
  `wrangler.jsonc` or a line in `.dev.vars` (never `wrangler secret put`), typed beside the bindings
  in `src/env.ts` and read by `federationOffline()` in `src/federation/offline.ts`. Set to anything
  but blank, `0`, `false`, `no` or `off`, it is on. **Production leaves it unset**: it is for a copy
  of the database running anywhere else — a local restore, a rehearsal, a second environment.
- **On, the instance contacts no connected household.** Checked in `refreshInBackground()` (no
  outbox or feed pull, no push retry, after any page), `pushQueued()` and `pushNow()` (a message a
  page writes is queued in the outbox as always and never pushed), `notifyPeer()` (a decline or a
  disconnect is applied here and not sent), the connect handshake (`/connections/redeem` and
  `/connections/:id/confirm` refuse with the notice), a recommendation's descriptor check (every
  household is out of reach to the form), and the live reads of a connection's shelves, items and
  shared views, which render the notice instead. The Connections page shows the notice at the top.
- **What peers sign to this instance is answered as before** — the descriptor, views, feeds, shelves,
  the inbox. The switch is about what leaves, not what arrives; a copy that should take nothing in
  either runs without a key or behind no public address.
- **Nothing is deleted or rewritten.** The connections, outbox, subscriptions and requests stay as
  the backup holds them, so the copy can be inspected whole; messages a page queues while the switch
  is on wait in the outbox, and go — bounded by `PUSH_RETRY_DAYS` — only if the same database is ever
  run with the switch off and the right key, which a restored copy never is.
- **The restore runbook sets it before the first page load** (`runbooks/backup-and-restore.md`,
  local restore): the variable in `.dev.vars` before `npm run dev`, or
  `UPDATE connections SET base_url = …` to an address nobody serves, for a copy that will run without
  the variable.

**What it rules out:** a check in `loadIdentity()` that disables connections wholesale (the pages
and the inbox are what a restored copy is run to look at); a restore script that blanks peers'
addresses by default (it would change the data under inspection and silently); a secret for the
switch (there is nothing to protect, and a secret is set on a deployed Worker — exactly where it
must never be); reading `connections.base_url` for "localhost" or the like to guess at a copy (a
second real deployment is the case that bit, and guessing would be wrong both ways).

Touches §8 (nothing about sessions), §9 (nothing published changes), the connections proposal
(docs/proposals/connections.md §8: background work runs only when the switch is off). Tests:
`test/federation-offline.spec.ts` — with the variable set, page loads that would pull outboxes and
feeds, a lend, a borrow request, a disconnect, a confirm and a redeem make no outbound request at
all, while a signed read from a peer is still served.
