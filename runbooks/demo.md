# Runbook: The read-only demo

A static copy of Nalanda on seeded data, published to GitHub Pages so anyone can click around
before deciding to self-host (ARCH.md §16 #89). Nothing in it can be changed: every page is a
file, every form is answered with "read-only demo", and the sign-in is a check in the browser.

**Address:** `https://<owner>.github.io/<repo>/` — for this repository,
https://isstiaung.github.io/nalanda/ — or a custom domain set under Pages (below). Sign in with
**demo** / **demo**.

## What it is, and isn't

- Built from the released app by `npm run demo:build`: a scratch `wrangler dev` is seeded with
  the demo collection (`scripts/seed-demo.mjs`, the README's screenshots' data), signed into, and
  crawled — every page a member sees, with its links pointed at the files. Covers come from Open
  Library during the build (keyless); games and records have none, since no provider token is
  set.
- The search box answers a handful of canned searches ("le guin", "pratchett", "dune",
  `tag:favourites`, `status:unread`); a shelf's filter bar lands on a pre-built combination or
  says it isn't pre-built. POST forms show a toast. No service worker, nothing installed.
- **The sign-in is not security.** The pages are public files; `demo` / `demo` is a check in
  `sessionStorage` so the demo looks like the app, and the page says so in small print.
- Nothing of yours is in it: the seed is fiction, and the build never touches a real instance
  (`--local`, a temporary state directory, Cloudflare credentials dropped from the environment).

## Publishing

`.github/workflows/demo.yml` builds and publishes on every release tag (`v*.*.*`), and by hand
from the Actions tab ("Demo" → Run workflow). It needs no secret.

**Once, in the repository's settings:** Settings → Pages → *Build and deployment* → Source:
**GitHub Actions**. Without that the deploy job fails with "Get Pages site failed". The first run
after enabling may take a few minutes to appear at the address above.

**A custom domain** (Settings → Pages → *Custom domain*, e.g. `nalanda-demo.isstiaung.me`): first
**verify the domain under your GitHub account** (your profile's Settings → Pages → *Verified
domains*, a `TXT` record GitHub names) — otherwise, if Pages is ever switched off or the repository
removed while the DNS record still points at GitHub, anyone's repository could claim the name.
Then at the DNS provider add a `CNAME` record for the subdomain pointing at `<owner>.github.io` —
on Cloudflare DNS, *DNS only*, not proxied, or GitHub's check and its certificate fail. GitHub re-checks the
record itself ("DNS check unsuccessful" means it isn't there yet); once it passes, tick *Enforce
HTTPS* when the certificate has been issued. Nothing in the repository changes: the workflow asks
Pages for the site's base path at build time (`actions/configure-pages`), so links are written for
`/<repo>/` on github.io and for `/` on a custom domain alike.

The workflow also passes Pages' **origin** (`--origin`): the app writes some addresses in full — a share's
address, its QR code and copy button on Shared links, a share page's link-preview tags, a feed's entries — from
the address it was crawled at, so the build points every one of them at the demo's own copy on the site's origin.
A local build without `--origin` links them by path alone.

**Release tags may deploy.** The `github-pages` environment (Settings → Environments → *github-pages* →
*Deployment branches and tags*) allows only `main` by default, so the run a release tag starts builds the demo and
then fails to publish it ("Tag … is not allowed to deploy to github-pages due to environment protection rules").
Add a tag rule `v*` there once.

## Building locally

```sh
npm run demo:build                      # → demo/, for serving at the root: npx serve demo
npm run demo:build -- --base=/nalanda   # for the Pages address (links written under /nalanda/)
npm run demo:build -- --no-covers       # offline: no cover fetches
```

The build starts its own server on `127.0.0.1:8818` (`DEMO_PORT` to change) with temporary
state — never your development database on 8787 — and removes it afterwards. `demo/` is
gitignored. To look at a build made for Pages, serve it under the same base, e.g.
`npx serve` from a directory holding `nalanda/ → demo/`.

## Updating the demo's data

Edit `scripts/seed-demo.mjs` — it is the one source for the screenshots and the demo — and
rebuild. The seed drives the real import routes, so it can never write a shape the app wouldn't.

## Troubleshooting

- *The deploy job fails with "Resource not accessible by the integration" or a 404 on Pages:*
  Pages isn't set to GitHub Actions as its source (above), or the repository's Actions settings
  forbid the `pages: write` permission.
- *Links on the demo lead to the repository root:* a local build was made without `--base`; the
  workflow takes the base from Pages itself (`/<repo>` on github.io, nothing on a custom domain).
- *A release tag's run builds but doesn't publish* ("not allowed to deploy to github-pages"): add the `v*`
  tag rule above, then re-run it or start the workflow by hand from `main`.
- *Links or QR codes on the demo point at `127.0.0.1`:* a build made without `--origin`; the workflow passes it.
- *"DNS check unsuccessful" under Custom domain:* the `CNAME` record isn't there or is proxied —
  see above.
- *A page in the demo is missing:* the crawl stops at 600 pages and never follows `?page=`,
  `?after=`, the APIs or the export; an item not linked from any crawled page isn't in it.
