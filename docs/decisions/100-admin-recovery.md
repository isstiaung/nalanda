# §16 #100 — An admin locked out gets back in with a recovery code shown at setup, or with a reset link `npm run reset-admin` makes

**Decided:** 2026-10-02. Cited as `ARCH.md §16 #100`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A member who forgets their password asks an admin for a reset link (#97). An admin who forgets theirs
asks another admin — and a household often has only one. The way back was a runbook procedure: hash
a password on a laptop, paste it into a hand-written `UPDATE` run against production, mind the `$`
characters a shell would expand. Nalanda sends no mail, so there is no "forgot password" email. In the
auth relook **the owner decided** on both: **a recovery code shown at setup**, and **a
`reset-admin` command**.

**What was decided:**
- **A recovery code, shown at setup.** The batch that makes the first admin (#39) also makes their
  recovery code, and the page setup answers with shows it once, before the app.
  - The code is twenty characters from the 31 that can't be mistaken for each other (no 0/O,
    1/I/L), shown in fours: `ABCD-EFGH-JKMN-PQRS-TUVW`, about 99 bits.
  - It is kept only as its SHA-256 (`recovery_codes`, migration 0062), one per account, bound to
    the account's key (#56). Removing the admin deletes it.
  - The page says to keep it apart from the device: written down, or in a password manager.
- **Used at `/recover`**, linked from the log in page as *Forgot your password?*. The form takes a
  username, the code — read back as typed, in any case, with or without its dashes — and a new
  password twice.
  - **The checks run in order, cheapest first.** The new password is checked first, then whether the
    code could be one at all (its length, its 31 characters), so a short or unconfirmed password, or a
    typo, costs no try. Then **login's throttle** (§8): ten failures in ten minutes, by address and by
    the account named. Then the code is looked up, before anything is hashed. A wrong code and an
    unknown username get the same answer.
  - **One batch whose statements each find the account through the code** sets the new password,
    moves the generation on (every device signs out, #70), deletes the admin's API tokens and links,
    signs this device in (#98) and takes the try back. Last, it **replaces the code with a new one**,
    shown on the page the answer is. So a code works once, an admin is never left without one, and of
    two uses racing, one signs in.
- **Made again on Account**, by admins, under *Recovery code*. The panel says when the code was made,
  never the code, and *Make a new recovery code* asks for **the account's password**, checked under
  login's throttle as a password change is. A code outlives a password change and "Sign out other
  devices", so whoever holds only a stolen session mustn't be able to mint one. The new code is shown
  once and the old one stops working. An admin from before this version has none until they make one;
  the panel says so.
- **A member has no recovery code.** An admin resets them with a link (#97). `/recover` says so, and
  `POST /account/recovery` answers a member 403.
- **`npm run reset-admin -- <username> --url=https://…`**, run by whoever holds the Cloudflare
  credentials (as `npm run backup` is). It makes a **one-time reset link** for that admin, exactly as
  the app makes one (#97): a 256-bit secret kept as its SHA-256, bound to the key, good for seven days,
  an invite still for an account that never joined, replacing any other link. It prints the link to
  open.
  - It refuses a member, and an unknown name (listing the admins).
  - It gives an account with no key one first (#56).
  - **Nothing else changes until the link is used:** the password works and every device stays
    signed in. So it needs no backup first. Using the link is the app's own batch.
  - `--local` does the same against the dev database. The SQL lives in `scripts/reset-link.mjs`,
    which a test runs against a real database.
- **Backups carry `recovery_codes`** (hashes, after `users`), so an admin locked out of a restored copy
  still has their way back.

**What it rules out:**
- **Security questions, email or SMS.** Nalanda has no mail or messaging service, and questions are
  guessable.
- **A code that works more than once**, or one shown again later. A lost code is a new one, made with
  the password.
- **Recovery codes for members.** Their admin is their way back. One more secret per person is one
  more to lose.
- **The command setting a password itself.** A password typed into a terminal ends up in shell
  history. A link lets the admin choose theirs in the browser, as every other password is chosen.

**Upgrading.** Migration 0062 adds `recovery_codes`; existing admins have none until they make one on
Account (it asks for their password). `npm run reset-admin` needs `account_links` (#97), so it works
from the release that brings one-time links on.

**Tests:** `test/recovery-code.spec.ts` covers:
- **setup's code:** kept as a hash; used once with its replacement shown; every device, token and
  link ended;
- **refusals:** the same answer for a wrong code and an unknown name; the password checked first;
  the throttle; a race; a removed admin's code;
- **Account:** the date never the code; a new one only for the password; members refused and shown
  nothing; an admin with none;
- **`reset-admin`'s SQL** against a real database: the app's own link, nothing changed until it is
  used; an invite kept an invite; a keyless account keyed; a quote in a username; nothing for a
  member;
- **the code read back as typed.**
