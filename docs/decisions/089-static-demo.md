# §16 #89 — A static demo: a seeded instance crawled into HTML behind a skeletal sign-in, every form intercepted, published to GitHub Pages on release

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #89`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Someone deciding whether to self-host wants to click around first. A hosted demo instance
would be a second deployment to pay for, keep patched and keep clean. **The owner decided** on
a static one: no database, no R2, no Worker — an interface to click through that changes
nothing underneath — with a skeletal login that accepts a default username and password, as
long as it says it isn't security.

**What was decided:**
- **Built from the real app, never written by hand.** `npm run demo:build`
  (`scripts/demo-build.mjs`) starts a scratch `wrangler dev` on its own port and temporary state
  — the accessibility audit's pattern, with this process's Cloudflare credentials dropped from the
  child's environment and no provider token — seeds it with `scripts/seed-demo.mjs` (the same
  collection the README's screenshots come from), signs in as the seed's librarian, and crawls
  every page a signed-in member can reach, breadth first from the Overview, up to 600 pages. So
  the demo is the app as released, on each release.
- **Plain files, links intact.** A page lands at `<path>/index.html`, a filtered one at
  `<path>/q/<query>.html`, a file the app serves (stylesheet, scripts, fonts, covers from the
  scratch R2, a feed) at its own path; every same-origin link, form action, image and script in a
  page is pointed at its file under the site's base (`/<repo>/` on GitHub Pages), the
  stylesheet's font references too (`scripts/demo-static.mjs`, the pure part, tested). What the
  crawl never follows: anything that writes or signs out, the export, the APIs, connections, the
  service worker's files, the token page, and pages past the first of a long shelf.
- **Every form is intercepted** by the demo's own script, injected into each page: a POST gets a
  toast — "Read-only demo — nothing is saved"; a GET form (the search box, a shelf's filter bar)
  lands on its pre-built page when the crawl made one, else a note. **A handful of canned
  searches** are crawled on purpose ("le guin", "pratchett", "dune", and two operators, #80) so
  the box does something. Buttons that htmx would have handled get the toast; htmx itself is
  cut from every page, as are the manifest and the app metas — **no service worker**, nothing
  installed, nothing kept.
- **A banner** on every page says what it is and links to the repository and to "Sign out".
- **A skeletal sign-in.** The site's root is the app's own login page as rendered, with a note:
  use `demo` / `demo`; this is not security — every page is public and read-only, and the sign-in
  is a check in the browser alone (`sessionStorage`), with the app's own "Wrong username or
  password." otherwise. Pages behind it send the visitor to the sign-in when the mark is missing
  — a gate for the look of the thing, as the owner asked, and nothing more.
- **Published on release**, by `.github/workflows/demo.yml`: on a `v*.*.*` tag (and by hand), the
  build runs on the runner and `actions/deploy-pages` publishes `demo/` — no secret, no
  Cloudflare, the job's own token allowed to write Pages. Pages has to be switched to "GitHub
  Actions" as its source once ([runbooks/demo.md](../../runbooks/demo.md)). `demo/` is
  gitignored.

**What it rules out:** a hosted demo instance (a bill and a surface to keep clean); a demo that
can be written to (then it needs resetting, and someone will type something that shouldn't stay
on a public page); a demo published on every push (it is the release's face, not main's);
treating the sign-in as access control — the pages are public files, and the page says so.

`test/demo-static.spec.ts` holds the pure parts: where each kind of address lands and how it is
linked under a base; what is an asset; what the crawl never follows; every address a page refers
to, once, without fragments; the rewriting of links, forms, images and scripts with other origins
left alone; what a page loses and gains; the sign-in's words and the canned searches' files. The
build itself runs in the Demo workflow.
