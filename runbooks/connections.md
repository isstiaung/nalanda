# Runbook: Connections

Connections link your library with another household's Nalanda, one pair at a time. This
release covers the connection itself: naming your library, invitations, confirming and
disconnecting. What connected households can do together — a feed, comments on reviews,
borrowing — arrives in later releases. The design is in
[docs/proposals/connections.md](../docs/proposals/connections.md).

Connections are off until the instance has a key. Without one, every connections page and
endpoint answers 404 and nothing shows in the sidebar. Only admins see **Connections**.

## Turn connections on (once)

1. Generate this library's key:
   ```sh
   npm run federation:keygen
   ```
   It prints a fingerprint and the key, once, and writes nothing to disk.
2. Store the key as a runtime secret on the deployed Worker, pasting the whole JSON line
   when prompted:
   ```sh
   npx wrangler secret put FEDERATION_PRIVATE_KEY
   ```
   It's a runtime secret like `SESSION_SECRET` — not a build secret like
   `D1_DATABASE_ID`. `wrangler secret put` publishes a new version carrying it, so there's
   nothing to redeploy.
3. **Keep a copy in your password manager.** The key is your library's identity to every
   household you connect with. It isn't in D1, so `npm run backup` doesn't save it, and
   losing it means reconnecting with everyone (*Lost or leaked key*, below).
4. Reload the app as an admin. **Connections** appears under Circulation.

## Name your library

**Connections → This library** → enter a name → **Save**. Households you connect with see
this name and the address shown beneath it.

The address is whichever one you opened the page at, so save from the address you want
households to use — your custom domain or the `workers.dev` one. It must be `https://`.
Once you have any connection or pending request, the address stays fixed; see
*Changing address*.

## Connect with another household

Either side can invite. If you're inviting:

1. **Invite a household → Create an invitation.** The link is shown once. If you lose it,
   create another and revoke the unused one.
2. Send it privately, to someone you know. It works once, within 7 days. Whoever holds it
   can ask to connect, which is why you still confirm in step 4.
3. They paste it into **Accept an invitation** on their own library and press **Connect**.
   The request shows under **Waiting for them** on their side and **Waiting for your
   confirmation** on yours.
4. Check the address is the household you invited, then **Confirm**. Both sides move to
   **Connected**. **Decline** removes the request instead, and the invitation stays used.

If you're the one invited, it's step 3, then wait for them to confirm. **Cancel** withdraws
a request they haven't confirmed yet.

## Disconnect

**Connected → Disconnect.** It takes effect on your side immediately, and your library tells
theirs so the connection disappears there too. If their library is unreachable at that
moment it keeps showing you until they disconnect as well — but it can no longer act on
your library either way. Reconnecting needs a new invitation.

## Changing address

The address is part of your identity to connected households, so it can't change under
them. To move to a new domain:

1. Disconnect every connection, and revoke any unused invitations — their links point at
   the old address.
2. Open **Connections** from the new address and **Save**.
3. Reconnect with new invitations.

## Lost or leaked key

A lost key can't be recovered. A leaked key lets whoever holds it pose as your library to
your connections. Either way:

1. Run `npm run federation:keygen` and `npx wrangler secret put FEDERATION_PRIVATE_KEY`
   with the new key.
2. Disconnect every connection. Their libraries still hold your old key, so they'll reject
   the notice — ask each household to disconnect on their side too.
3. Reconnect with new invitations.

## Turn connections off

Disconnect everyone first, so their libraries hear about it. Then:

```sh
npx wrangler secret delete FEDERATION_PRIVATE_KEY
```

Every connections page and endpoint goes back to 404. Connection records stay in D1,
harmless, and return if the same key is put back.

## Try it locally with two libraries

Two local instances can connect over `http://localhost`. Give each its own state
directory, so your everyday dev database is never touched, and its own key through
`--env-file`. Everything below lives under `.wrangler/`, which git ignores.

1. Run `npm run federation:keygen` twice, one key per library.
2. Create `.wrangler/connections/a.env` and `.wrangler/connections/b.env`, each with
   ```
   SESSION_SECRET='<any long random string>'
   FEDERATION_PRIVATE_KEY='<the .dev.vars line from one keygen run>'
   ```
   `--env-file` replaces `.dev.vars` rather than adding to it, so anything else you need
   (a `DISCOGS_TOKEN`, say) goes in these files too.
3. Migrate and start each one, in separate terminals:
   ```sh
   npx wrangler d1 migrations apply nalanda --local --persist-to .wrangler/connections/a-state
   npx wrangler dev --port 8791 --persist-to .wrangler/connections/a-state --env-file .wrangler/connections/a.env

   npx wrangler d1 migrations apply nalanda --local --persist-to .wrangler/connections/b-state
   npx wrangler dev --port 8792 --persist-to .wrangler/connections/b-state --env-file .wrangler/connections/b.env
   ```
4. Open `http://localhost:8791` and `http://localhost:8792`, create an admin on each, name
   both libraries, and connect them as above.

Delete `.wrangler/connections/` to start over.

## Troubleshooting

- **No Connections link in the sidebar.** You're not an admin, or the key is missing or
  malformed. A malformed key is logged with the reason — `npx wrangler tail` while loading
  a page.
- **"Connections need this library to be served over https."** You opened the page over
  `http://` at an address other than localhost.
- **Connect fails.** The page says why. Most often the invitation was already used,
  expired or revoked — ask for a new one — or their library couldn't be reached.
- **"Couldn't reach … to confirm."** Their library was unreachable, and nothing changed.
  Try **Confirm** again later.
