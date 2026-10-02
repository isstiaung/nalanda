# Runbook: Accounts & access

## Add a family member

1. Log in as admin → **Settings** (`/settings/users`).
2. Enter a username, pick a role (`member` for everyone except co-admins), **Create account**.
3. An **invite link** is shown **once**, with its QR code — send them the link however you like, or
   let them scan the code from your screen. It works once, for seven days (ARCH.md §16 #97).
4. They open it, choose their own password, and are signed in. You never see their password.

The Members table says *Invited · until <date>* while the link is out, and *Invite expired* once the
week has passed. If it expired or went astray, **New invite link** beside their name makes another and
the old one stops working.

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

**Interface language** (ARCH.md §16 #93). The interface follows the household language set under
**Members → Household language** where a translation is shipped — हिन्दी and தமிழ் so far, both
machine-drafted until a native reader checks them — and stays English otherwise. Each member can
pick another for themselves under **Account → Language**; share pages always show the household's.
To correct a draft or add a language: download the strings from Account (`/strings/hi.json`,
`/strings/ta.json`; `/strings/en.json` for the English source), edit the file, and either import it
under **Members → Interface translations** (this household's own words, key by key, share pages
included; **Remove** clears it) or open a pull request so everyone gets it. A file larger than 200 KB
is refused; keys the table doesn't know are ignored and counted in the message.

**Display font** (ARCH.md §16 #96). Titles and the brand are set in Eczar, with Tiro Tamil for Tamil.
Under **Members → Display font** an admin can upload a face of the household's own for a language —
a `.woff2`, `.woff`, `.ttf` or `.otf` file of 1 KB to 2 MB, recognised by its contents, not its name —
and every page in that language, the login page and share pages included, sets its titles in it;
any letter it lacks falls back to the shipped faces. Uploading again for that language replaces it;
**Remove** goes back to the shipped faces. The file becomes public like a cover (anyone with its
address can download it), and its licence is the household's responsibility: upload only a font you
may use on a website. Keep the file — unlike covers, nothing can fetch it again
([backup runbook](backup-and-restore.md)).

## Someone forgot their password

Settings → *Reset password* next to their name → a **reset link** is shown once, with its QR code.
The reset takes effect immediately — their old password stops working the moment you click, they
are signed out on every device at the same moment, and their API tokens are revoked. They open the
link, choose a new password, and are signed in. So a reset is also the remedy for a member's lost
phone: reset, send them the link, and the phone's session is dead. Your own row offers no reset — it would
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

## Sign out one device

Account → **Devices** lists every device signed in to your account: its browser and system
("Chrome · macOS"), when it signed in and when it was last used. **Sign out** beside any of them
ends that one at once; it logs in again with your password. This device signs out with **Log out**.
A device left unused for 30 days is signed out on its own; one in use stays signed in. An account keeps
at most 20 devices: past that, the one used least recently signs out as a new one signs in (ARCH.md
§16 #98). A device that signed in before this list existed isn't named in it until it signs in again;
*Sign out other devices* ends it too.

## Sign in a device without its password

Two ways, both from a device already signed in (ARCH.md §16 #99):

- **A code.** On the signed-in device, Account → **Devices** → **Sign in another device** shows a
  code like `ABCD-EFGH` and a QR code. On the new device, Log in → *Sign in with a code from a
  signed-in device*, and type it, or scan the QR, which opens that page with the code filled in, then
  *Sign in*. A code works once, within five minutes; making another replaces it. Ten wrong codes in
  ten minutes from one address get *Too many attempts* — counted apart from wrong passwords, so
  neither locks the other out; a typo that can't be a code at all doesn't count.
- **Your phone.** On the new device, Log in → **Sign in with your phone** shows a QR code and a
  two-digit number. Scan the QR with a phone signed in to the library: it names the device asking and
  asks for the number. Type the one on the new device's screen and it signs in within a couple of
  seconds. A wrong number or *Don't sign it in* ends the request; start again on the new device. A
  phone that isn't signed in is sent to log in first; scan again after. **Never approve a link someone
  sent you, or type a number someone told you**: approving lets that device into your account.

Either way the new device appears under Devices like any other, and **Sign out** ends it. A device
on a temporary password can do neither until its password is changed.

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
- **What's exposed** (`toPublicItem()` in `src/lib/share.ts`): title, creators, cover, type,
  publisher, date, length, description, media details (money stripped), tags, formats, language
  and original title, the household's average rating and latest review with no author, the
  "Not owned" badge and "Wanted" beside it while someone wants the item; on a book's own page,
  "Read N times" from two finishes on (only while it's owned), its series name and number, and
  the quotes a member marked shared; on a game's or record's page, "Played N times"; reading
  progress only while **Reading progress on share pages** is on, and only for a book being read
  now; and, with **Names on share pages** on, each member's rating and review under their
  display name. **Never**: private notes, where it lives, loans/borrowers, what's borrowed from
  whom, copy counts, a record's condition, what was paid, who added it, usernames, reads or
  their dates, who read what, item history, another edition's ISBN, a series' gaps or anyone's
  next up, reading goals, a play's date or who logged it. A gift list shows less — title,
  creators, cover, type, publisher, date, length, description, formats, language, "On the
  shelves" for something you already have — plus its purchase links, which appear on no other
  public page. A link can't be browsed beyond its filters, even by guessing item URLs. Pages
  carry `noindex`. [docs/privacy.md](../docs/privacy.md) has every rule with the code that holds it.
- **Rotate** if a link spread further than intended — a new URL is minted immediately.
  Public pages are cached up to 1 hour per Cloudflare location; any edit you make in
  the app refreshes the location that served you instantly, but a rotated/removed
  link can keep answering from a location you haven't touched for up to an hour.
  If a leak is genuinely urgent, rotate AND remove, and accept the tail.
- **Remove** to unpublish that view; other links on the same shelf keep working.

## Custom fields

**Members → Custom fields** (admins only, ARCH.md §16 #95). Up to ten fields of the household's own, each a
name and a kind — **text** (up to 500 characters), **yes / no**, or a **date** — and a **Show on share pages**
switch, off until you turn it on. Every item's add and edit form shows the fields; the item's page lists what
is set under **Fields**. Members fill them in like any other field; only an admin defines, renames, switches
or deletes one.

- **Private by default.** A field's values appear on a shared item's page only while its switch is on, by the
  field's name, and never on a share link's listing or feed, and never to connected households whatever the
  switch says. Turning a switch off takes the values off share pages at once (a cached page can lag up to an
  hour on other isolates, as any share change can).
- **Renaming keeps the values.** A field's kind can't change: the values already hold it.
- **Deleting a field deletes every item's value for it**, in the same step — there is no undo, and the confirm
  says so. Each changed item's History names you for it.
- **The CSV carries them** in a `custom` column, as JSON by the field's name: `{"Signed":true,"Gifted by":"Ravi"}`.
  Importing a Nalanda export keeps every value whose field exists here under the same name (case doesn't
  matter) and drops the rest — the preview says "N custom values had no field here" — so define the fields
  under Members **before** importing a file from another household, or your own backup after a field was
  deleted. A `custom` column in a libib, Goodreads, StoryGraph or LibraryThing file is dropped, never kept in
  the item's details.
- **Backups** carry the `custom_fields` table; the restore order in the backup runbook has it before `items`.

