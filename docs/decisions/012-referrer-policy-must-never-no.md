# §16 #12 — Referrer policy must never be `no-referrer`

**Decided:** 2026-07-11 (production readiness). Cited as `ARCH.md §16 #12`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Referrer policy must never be `no-referrer` (learned live: it broke every login):
browsers apply referrer policy to the **Origin** header too, sending `Origin: null`
on same-origin form posts, which our own CSRF check then rejects. Policy is
`strict-origin-when-cross-origin`, and the CSRF middleware now checks
`Sec-Fetch-Site` first (immune to referrer policy) with the Origin comparison as the
legacy fallback. Regression-tested with browser-faithful headers (test/csrf.spec.ts).
