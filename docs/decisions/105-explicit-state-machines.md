# §16 #105 — Explicit state machines: declared lifecycles, one "pending" state, and the scanner's states

**Decided:** 2026-11-26. Cited as `ARCH.md §16 #105`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Nalanda had state machines nobody had written down. On the server they were safe but scattered: every move of a
borrow request, a recommendation or a connection was already a compare-and-set, but the states it could start from
were spelled out at each call site (`setRequestStatus(…, 'withdrawn', ['pending'])`) and inside raw SQL
(`status IN ('pending', 'withdrawn')`). Reading a lifecycle meant finding all of them. In the browser they were
loose variables, and three of them broke. A sweep at four widths, two of them with touch, and on a throttled
connection found these:

- **The camera scanner** opened a second camera on a double tap of Start (still running after Stop). It left a
  camera on when the camera answered after the 8-second timeout. During one slow download of the decoder, it
  initialised ZXing 18 times, with 18 frame reads running at once.
- **The review list** missed a barcode held while it was already reading the queue: the device held two barcodes
  and the list showed one.
- **Every request** looked like nothing had happened until its answer came, which on a phone on 3G is seconds. The
  only per-request feedback was htmx's `htmx-request` class, which nothing styled.

**Decided:**

- **Declared lifecycles.** A status column that moves has its moves in `src/lib/lifecycles.ts`: its states, the
  states a row is inserted in, and each move's `from`, `to` and why. These are `BORROW_REQUEST`, `RECOMMENDATION`
  and `CONNECTION`. Every statement in `src/db` that moves one takes `to` and `from` from the table (`inArray`, or
  `fromSql()` for raw SQL). `setRequestStatus()` takes an event (`'withdraw'`, `'decline'`), not a status and a list.
  `activateConnection()` takes no `from`. Behaviour is unchanged: the same moves from the same states.
- **Checked.** `test/lifecycles.spec.ts` checks that every move is between real states, that every state is
  reachable, and that each machine has an end. It checks that no statement in `src/db` writes a status literal by
  hand, and that [docs/state-machines.md](../state-machines.md) draws exactly what is declared (Mermaid, from
  `diagram()`). That page also lists the derived states (loans, sessions, links, pairings: dates and rows, no status
  column, and none to be added) and the browser's machines.
- **One "pending" state for every request.** The form or button a request went out from carries
  `aria-busy="true"` until its answer is in (`public/app.js`). For htmx, that is from `htmx:beforeRequest` to
  `htmx:afterRequest`. For a plain POST form, it lasts until the next page, and a second submit meanwhile is
  refused. It is released by bfcache and, as a backstop, after 20 s. htmx does not drop a repeat itself: its default
  queues one and sends it after the first, so a double tap on Look up asked the providers twice. The same request
  again while pending (the same form values, or the same button) is dropped at `htmx:confirm`; a form sent with new
  values still goes. The stylesheet draws a sheen across the busy button after 150 ms. Its background longhands are
  `!important`, since a tapped button on a phone stays `:hover` and every hover rule sets the `background`
  shorthand. With reduced motion there is no sheen, which would sit still behind the label; a dotted ring shows instead. aria-busy, not `disabled`: a disabled button drops focus, and the request
  is not refused, only waiting.
- **The scanner's states are idle, starting and live**, held in one variable and mirrored as `data-scanner` on its
  section. Start acts only when idle and is `aria-disabled` and `aria-busy` while starting (not `disabled`, which drops keyboard focus); when the camera goes live, focus on Start moves to Stop. The decoder's promise is the WASM itself (`fireImmediately`), purged when it fails, so a retry is real. Each Start is a numbered
  attempt, which Stop and leaving the page end; a camera that answers for an ended attempt is closed on arrival.
  Frames are read one at a time, each scheduled after the last. The decoder is one shared promise, forgotten if it
  fails. The refusal says why in words someone can act on: no HTTPS (`isSecureContext`, not a hostname check),
  permission refused, or timed out.
- **The review list** asks for one more pass when a load is requested during a load.
- **On a touchscreen** (`pointer: coarse`), a disclosure's summary gets 0.6rem of padding above and below, at no
  specificity, so a summary with its own size keeps it. A read's Began and Ended fields are labelled visibly, as the
  Lend form's Due is.

**Rejected:** a state-machine library (a runtime dependency for three tables); `disabled` on every busy control
(focus loss and lost submitter values); `hx-disabled-elt` inherited from `<body>` (htmx resolves its selector per
element, which is surprising, and it disables).
