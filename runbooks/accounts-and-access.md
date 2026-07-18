# Runbook: Accounts & access

## Add a family member

1. Log in as admin → **Settings** (`/settings/users`).
2. Enter a username, pick a role (`member` for everyone except co-admins), **Create**.
3. A temporary password is shown **once** — send it to them however you like.
4. They log in with it and are forced to set their own password before doing anything else.

Members can do everything except manage users and publish/rotate share links.

## Someone forgot their password

Settings → *Reset password* next to their name → a new one-time temp password is shown.
The reset takes effect immediately — their old password stops working the moment you click,
and they set their own again at next login.

## Remove someone

Settings → *Remove*. Revocation is immediate — every request re-checks that the user row
still exists, so their session dies on their next click.

## Admin lockout (you forgot the admin password)

You can reset any password from the CLI. **The hash contains `$` characters — never paste
it inside a double-quoted shell string (zsh/bash will expand the `$…` runs and silently
corrupt it).** The shell-safe pattern:

```sh
HASH=$(node scripts/hash-password.mjs 'your-new-password')
echo "UPDATE users SET password_hash='$HASH', must_change_password=0 WHERE username='<admin username>';" > reset.sql
npx wrangler d1 execute nalanda --remote --file=reset.sql && rm reset.sql
```

(Expanding `$HASH` is fine — shells don't re-expand a variable's *value*.) For local dev,
same commands with `--local`.

Log in with the new password. If you racked up failed attempts first, either wait 10
minutes or clear the throttle:

```sh
npx wrangler d1 execute nalanda --remote --command "DELETE FROM login_attempts"
```

## Log everyone out everywhere

Sessions are signed cookies, so rotating the signing secret invalidates all of them:

```sh
npx wrangler secret put SESSION_SECRET    # enter a NEW value: openssl rand -base64 32
```

Everyone (including you) logs in again. Use after a device is lost or a link/cookie may
have leaked.

## Share links (admin-only)

- **Publish a view**: shelf page → apply any filters you want public (type, status,
  owned/not owned) → *Shelf settings* → name the link → *Publish current view*. The
  link shows exactly that view; publish with no filters for the whole shelf. Any
  number of links per shelf — e.g. a "My reviews" link (holding: Not owned) alongside
  the full catalog.
- **What's exposed**: title, creators, cover, publisher, date, description, media details,
  tags, rating, review, and the "Not owned" badge. **Never**: private notes,
  loans/borrowers, copy counts, who added it. A link can't be browsed beyond its
  filters, even by guessing item URLs. Pages carry `noindex`.
- **Rotate** if a link spread further than intended — old URL 404s instantly, new one is
  minted.
- **Remove** to unpublish that view; other links on the same shelf keep working.
