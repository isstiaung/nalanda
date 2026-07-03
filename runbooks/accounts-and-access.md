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

You can reset any password from the CLI. From the project directory:

```sh
node scripts/hash-password.mjs 'your-new-password'
# prints something like: pbkdf2$100000$…$…

npx wrangler d1 execute nalanda --remote --command \
  "UPDATE users SET password_hash='<paste the hash>', must_change_password=0 WHERE username='<admin username>'"
```

Log in with the new password. (For local dev, same command with `--local`.)

## Log everyone out everywhere

Sessions are signed cookies, so rotating the signing secret invalidates all of them:

```sh
npx wrangler secret put SESSION_SECRET    # enter a NEW value: openssl rand -base64 32
```

Everyone (including you) logs in again. Use after a device is lost or a link/cookie may
have leaked.

## Share links (admin-only)

- **Publish**: library page → *Library settings* → *Publish read-only link*. Anyone with
  the URL can view that shelf — no account, no login.
- **What's exposed**: title, creators, cover, publisher, date, description, media details,
  tags, rating, review. **Never**: private notes, loans/borrowers, copies, who added it.
  Pages carry `noindex`.
- **Rotate** if a link spread further than intended — old URL 404s instantly, new one is
  minted.
- **Disable** to unpublish entirely.
