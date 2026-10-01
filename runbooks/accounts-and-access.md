# Runbook: Accounts & access

## Add a family member

1. Log in as admin → **Settings** (`/settings/users`).
2. Enter a username, pick a role (`member` for everyone except co-admins), **Create**.
3. A temporary password is shown **once** — send it to them however you like.
4. They log in with it and are forced to set their own password before doing anything else.

Members can do everything except manage users, publish or rotate share links, and **delete items
in bulk**. Bulk edit's other actions (tag, untag, move to a shelf, owned, not owned) are open to
everyone. Its **Delete** shows only to admins, and the server refuses it to anyone else with a 403.
A member can still delete a single item from its page (ARCH.md §16 #47).

**Display names.** Each member can set a display name on their **Account** page, and an admin can set
anyone's in the Members table. It's optional, not a login, and not unique (two people can both be
"Sam"). It only ever appears outside Nalanda where an admin has switched names on — **Shared links →
Names on share pages** and **Connections → Show names to connected households** (ARCH.md §16 #45). Both
start on for a new instance; an instance upgraded from before reading goals keeps what it had — off unless an
admin turned them on (§16 #49). Without one, a member stays unnamed. Usernames never leave the app. Each person's
reads, recorded pages, rating and review are their own (ARCH.md §16 #43): members change only
theirs, and admins can change, delete or **move** anyone's — a read (with its pages) or a review
credited to the wrong person moves from the book's page, under *Edit* on it.

## Someone forgot their password

Settings → *Reset password* next to their name → a new one-time temp password is shown.
The reset takes effect immediately — their old password stops working the moment you click,
they are signed out on every device at the same moment, and they set their own password again
at next login. So a reset is also the remedy for a member's lost phone: reset, hand them the
temporary password, and the phone's session is dead. Your own row offers no reset — it would
sign out the device you are on — and points at **Account**, where you change your own password
(which signs out your other devices and keeps this one).

## Remove someone

Settings → *Remove*. Revocation is immediate — every request re-checks that the user row
still exists, so their session dies on their next click. A member added later may be given
the removed member's id; the removed member's old cookie still signs nobody in, because a
session names the account's random session key as well as its id, and every account gets
its own (ARCH.md §16 #56). Their reads, pages, ratings and reviews stay, shown as a *Former member*'s: nothing about a book changes on shelves, share
pages or connections. An admin can move any of them to someone still here. Their **want list
goes**, and so does every gift list published of it — its link stops working. The books on it,
and the purchase links on those books, stay.

## Admin lockout (you forgot the admin password)

You can reset any password from the CLI. **The hash contains `$` characters — never paste
it inside a double-quoted shell string (zsh/bash will expand the `$…` runs and silently
corrupt it).** The shell-safe pattern:

```sh
HASH=$(node scripts/hash-password.mjs 'your-new-password')
echo "UPDATE users SET password_hash='$HASH', must_change_password=0 WHERE username='<admin username>';" > reset.sql
npm run wrangler:remote -- d1 execute nalanda --remote --file=reset.sql && rm reset.sql
```

(Expanding `$HASH` is fine — shells don't re-expand a variable's *value*.) For local dev,
same commands with `--local`. Leave `session_key` alone: it is the account's identity, not
part of its password. **Never add an account with a hand-written `INSERT`**: create it under
Members, which gives it its own session key. (An account inserted without one gets a key at
its first password login, and nothing signs it in before.)

Log in with the new password. If you racked up failed attempts first — ten in ten minutes
from your address, or ten at the account from anywhere, and login answers "Too many attempts"
(HTTP 429) to the right password too — either wait 10 minutes or clear the throttle:

```sh
npm run wrangler:remote -- d1 execute nalanda --remote --command "DELETE FROM login_attempts"
```

The per-account count is also what someone who knows a username can lean on to keep that
account from signing in anew (ten wrong guesses every ten minutes, from anywhere); devices
already signed in are unaffected. To free one account without clearing everyone's throttle:

```sh
npm run wrangler:remote -- d1 execute nalanda --remote --command "DELETE FROM login_attempts WHERE username = 'the-username'"
```

## Sign one person out everywhere

Anyone can do it for themselves: Account → *Sign out other devices*. Every other device of
theirs is signed out at once and this one stays in; changing their password does the same.
For someone else, *Reset password* (above) signs them out everywhere as well. Neither touches
anyone else's sessions, and neither needs a deploy or a secret.

## Log everyone out everywhere

Sessions are signed cookies, so rotating the signing secret invalidates all of them:

```sh
npx wrangler secret put SESSION_SECRET    # enter a NEW value: openssl rand -base64 32
```

Everyone (including you) logs in again. Use after a device is lost or a link/cookie may
have leaked.

## Share links (admin-only)

- **See everything that's public**: *Shared links* in the sidebar, under Sharing & connections.
  One row per published link — its shelf, the filters it captured, how many items it
  exposes right now, and the URL — with rotate and remove on each. Start here when
  the question is "what have we published?"; the per-shelf panel below is for
  publishing.
- **Publish a view**: shelf page → apply any filters you want public (type, status,
  owned/not owned) → *Shelf settings* → name the link → *Publish current view*. The
  link shows exactly that view; publish with no filters for the whole shelf. Any
  number of links per shelf — e.g. a "My reviews" link (holding: Not owned) alongside
  the full catalog.
- **Publish a tag**: *Tags* → open the tag → *Publish this tag*. The link shows every
  item carrying that tag, on any shelf, owned or not — a hand-picked list such as
  "reviewed-books" that no combination of shelf filters could express. That tag's page
  lists its links with rotate and remove, and they appear under *Shared links* too.
- **Publish a want list as a gift list**: *Want list* in the sidebar, under Reading → pick the member →
  *Publish as a gift list*. The link shows everything on that member's want list as it
  stands — titles, covers, and the links under *Where to buy* on each item — so family can
  choose a present. It follows the list: an item taken off it (or finished — a finished book
  leaves its reader's list) leaves the page, and the link can't reach anything else by id.
  It's titled "A want list" unless *Names on share pages* is on and the member has a display
  name, when it reads "Priya's want list" — never their login. Rotate and remove are on the
  same page and under *Shared links*. It doesn't count towards a shelf's badge. Nothing on it
  says whether an item was already bought: tell a second giver yourself.
- **Reading the shelf badges**: a shelf reads *Shared* only when a link exposes it
  entire. If you've only published slices of it, it reads "2 views shared" instead —
  the shelf itself is not reachable, just those views.
- **What's exposed**: title, creators, cover, publisher, date, description, media details,
  tags, rating, review, and the "Not owned" badge. **Never**: private notes, where it lives,
  loans/borrowers, copy counts, who added it. A gift list shows less — title, creators,
  cover, type, publisher, date, length, description, "On the shelves" for something you
  already have — plus its purchase links, which appear on no other public page. A link can't be browsed beyond its
  filters, even by guessing item URLs. Pages carry `noindex`.
- **Rotate** if a link spread further than intended — a new URL is minted immediately.
  Public pages are cached up to 1 hour per Cloudflare location; any edit you make in
  the app refreshes the location that served you instantly, but a rotated/removed
  link can keep answering from a location you haven't touched for up to an hour.
  If a leak is genuinely urgent, rotate AND remove, and accept the tail.
- **Remove** to unpublish that view; other links on the same shelf keep working.
