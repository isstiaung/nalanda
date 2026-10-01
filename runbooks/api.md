# Runbook: The read-only API

A script, a blog or another app can read your library as JSON with a **token** made on your
Account page (ARCH.md §16 #88). A token reads what you see when signed in — your shelves with
their filters, an item with its reads and reviews, search, loans, your want list and goals — and
can change nothing.

## Make a token

**Account** → **API tokens** → give it a name (what it is for) → **Make a token**. The secret
(`nal_…`) is shown **once**, on that page: copy it then. Only its hash is kept. Revoke it there
whenever you like; you can hold ten.

A token stops working when you **sign out other devices**, change your password, or an admin
resets it — make a new one after. A removed member's tokens go with them.

## Use it

Every request is a `GET` with the token as a bearer:

```
curl -H "Authorization: Bearer nal_…" https://your-instance.example/api/v1/me
```

Answers are JSON. A refused request says why: `401` (no token, or one that no longer signs
in), `403` (change your password first), `405` (not a GET), `400` (a bad parameter), `404`.

| Route | What it returns |
|---|---|
| `/api/v1/me` | `{ id, username, role, version }` — whose token this is |
| `/api/v1/libraries` | `{ libraries: [{ id, name, itemCount }] }` |
| `/api/v1/items` | `{ items: [...], next? }` — see below |
| `/api/v1/items/:id` | `{ item, reads, reviews, progress, loans, people }` — the item with its tags; every read with its reader (`readerId`), the reviews, the pages recorded, the loans out; `people` names the ids |
| `/api/v1/search?q=…` | `{ items }` — the search box, with its operators (`author:`, `tag:`, `status:`…), the fifty best; `readBy` as on a shelf |
| `/api/v1/loans` | `{ out, returned }` — what is out on loan, and the latest hundred returns |
| `/api/v1/wants` | `{ items, next? }` — your own want list |
| `/api/v1/goals?year=2026` | `{ year, goal }` — your reading goal for the year (this year unless said), or `null` |

### Items

`/api/v1/items` takes the same parameters a shelf's address carries, so copy them from the
filter bar's URL: `library=<id>` for one shelf (every shelf without it), `type`, `status`,
`owned` (`1`, `0`, `b` for borrowed), `format`, `tag`, `q`, `readBy`, `addedYears`,
`unplayedMonths`. Items come **250 a request, by id**: when more follow, the answer carries
`next` — the last id of the page — and the next request adds `after=<next>`:

```
GET /api/v1/items?library=3&status=not_started
GET /api/v1/items?library=3&status=not_started&after=1250
```

Each item is the row as the app holds it — title, creators, publisher, ISBNs, status, rating,
review, notes, location, copies, formats, language, prices, details — plus `tags`. **It is your
view, not a share page's**: private fields are included because you can see them. Treat the
token like your password.

## Privacy

A token is yours alone: it reads as you, and never more than you. Nothing here is public — the
API is not a share link, and no share link reaches it. Tokens are listed on your Account page
and nowhere else; admins can't see members' tokens.
