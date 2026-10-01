# §16 #29 — Connections between self-hosted instances — approved, built in phases

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #29`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Two households
that both run Nalanda can connect by invite, then see a feed of each other's reading,
comment on each other's reviews, and borrow from each other. This reverses the "social
features" non-goal in §14 deliberately and narrowly: connections are strictly pairwise,
never a network, with no fediverse interop. ActivityPub was rejected because its value is
reaching the wider network, and its open inbox is exactly where its spam problem lives.
Instead: invite-only connections confirmed by an admin, RFC 9421 HTTP Message Signatures
on every later request, and ActivityStreams 2.0 as the JSON format — with no new
Cloudflare products and no new runtime dependency. "Background jobs of any kind" stays a
non-goal: pulls happen only when someone opens a page. Additive by construction — off
unless the instance has a federation key. The design, decisions and threat model live in
`docs/proposals/connections.md`; each phase's pull request updates it where the build
has to differ.
