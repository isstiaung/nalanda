// The runtime half of the accessibility audit (ARCH.md §18, §16 #50): axe-core in a real browser, on every page
// of a freshly seeded instance, in both themes, at desktop and phone widths — plus the htmx swaps and a keyboard
// walk. The static half is `npm run lint` (eslint-plugin-jsx-a11y).
//
//   npm run a11y                  # the whole audit; exits 1 on any violation
//   npm run a11y -- --only=shelf  # just the pages and htmx steps whose name contains "shelf" (--only=htmx: every step)
//   npm run a11y -- --keep        # leave the server running afterwards, to look around
//   A11Y_VARIANT='dark 390' npm run a11y   # one theme and width only (CI runs the four in parallel)
//
// It never touches your development database or port: it starts its own `wrangler dev` on 127.0.0.1:8817 with
// its own --persist-to state in a temporary directory, removed afterwards. It brings what it needs: a throwaway
// session secret and connections key (in an --env-file in that state, so a .dev.vars is never read and its
// provider tokens never used), seed data from scripts/seed-demo.mjs (offline, --no-covers), and cover images from
// a tiny server on :8818 that the Worker fetches like any cover URL. Wrangler runs --local, with no Cloudflare
// credentials in its environment and its config home (where a stored login lives) pointed into the scratch
// state: a local run is as offline as CI's. The steps that need the internet look up books on the Add page (Open
// Library, keyless: a typed ISBN, a search and its More results): when one finds nothing, the report says which
// states went unaudited (a warning annotation on GitHub Actions), and A11Y_REQUIRE_LOOKUP=1 turns that into a failure.
// The Refresh from Discogs / BGG buttons render only with a provider token, so they get a second scratch server of
// their own on :8819 (A11Y_PORT + 2), with a placeholder token and one record and one game, whose refreshes the
// browser answers itself — nothing reaches Discogs or BGG (refreshInPlace(), below).
//
// A11Y_USE_DEV_VARS=1 lets .dev.vars load after all — your BGG or Discogs tokens, for lookups CI can't do.
// A11Y_CPU_THROTTLE=4 (or 6) slows the browser that much, with network latency, to reproduce a slow CI runner.
// A11Y_CHROMIUM=/path/to/chrome uses an installed Chromium-family browser instead of Playwright's
// (`npx playwright install chromium`).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const PORT = Number(process.env.A11Y_PORT ?? 8817);
const COVER_PORT = PORT + 1;
const INSPECTOR_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
// a second, small instance for the Refresh buttons alone (refreshInPlace(), below), with dummy provider tokens
const REFRESH_PORT = PORT + 2;
const REFRESH_BASE = `http://127.0.0.1:${REFRESH_PORT}`;
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const KEEP = process.argv.includes('--keep');
const USERNAME = 'librarian'; // seed-demo.mjs's admin
const PASSWORD = 'demo-password';

// WCAG 2.0, 2.1 and 2.2, levels A and AA — the bar (ARCH.md §18) — plus axe's best-practice rules (the structure
// a screen-reader user navigates by: landmarks, one h1, headings that don't skip levels, a skip link that goes
// somewhere) and the experimental WCAG rules that tag selection leaves out: a visible label that's part of the
// accessible name (2.5.3), and a bold paragraph standing in for a heading.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice'];
const EXPERIMENTAL = ['label-content-name-mismatch', 'p-as-heading'];
// what axe can't decide on its own (text over an image, a background it can't compute) for these is reported for
// a person to look at; it doesn't fail the run, but it is never silent
const REVIEW = ['color-contrast', 'target-size'];

const ALL_VARIANTS = [
  { name: 'light 1280', scheme: 'light', width: 1280, height: 900 },
  { name: 'dark 1280', scheme: 'dark', width: 1280, height: 900 },
  { name: 'light 390', scheme: 'light', width: 390, height: 844 },
  { name: 'dark 390', scheme: 'dark', width: 390, height: 844 },
];
// A11Y_VARIANT="dark 390" (or several, comma-separated) audits only those; CI runs the four side by side
const PICKED = (process.env.A11Y_VARIANT ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const VARIANTS = PICKED.length ? ALL_VARIANTS.filter((v) => PICKED.includes(v.name)) : ALL_VARIANTS;
if (PICKED.length && VARIANTS.length !== PICKED.length) {
  console.error(`a11y: A11Y_VARIANT names ${PICKED.join(', ')}; the variants are ${ALL_VARIANTS.map((v) => v.name).join(', ')}`);
  process.exit(2);
}

// ── report ────────────────────────────────────────────────────────────────────────────────────────────────────

const violations = new Map(); // rule id → { impact, help, helpUrl, hits: Map<"page · target", {summary, variants:Set}> }
const failures = []; // keyboard, reachability, scripting problems: plain lines
const audited = []; // "page [variant]"
const unaudited = []; // states the audit couldn't reach, with why
const needsReview = new Map(); // "rule · page · target" → variants, from axe's incomplete results

function record(where, variant, results) {
  audited.push(`${where} [${variant}]`);
  for (const v of results.violations) {
    const rule = violations.get(v.id) ?? { impact: v.impact, help: v.help, helpUrl: v.helpUrl, hits: new Map() };
    violations.set(v.id, rule);
    for (const node of v.nodes) {
      const key = `${where} · ${node.target.join(' ')}`;
      // the element a check blames besides this one (target-size's too-close neighbour, a duplicate id's twin)
      const related = [...node.any, ...node.all, ...node.none].flatMap((c) => c.relatedNodes ?? []).map((r) => r.html)[0];
      const summary = (node.failureSummary?.split('\n').slice(1).join(' ').trim() ?? '') + (related ? ` [related: ${related.slice(0, 100)}]` : '');
      const hit = rule.hits.get(key) ?? { summary, html: node.html, variants: new Set() };
      hit.variants.add(variant);
      rule.hits.set(key, hit);
    }
  }
}

let symbolsOnly = 0; // incomplete contrast checks on text that is only symbols: stars, media icons

/** `off`: rules this one run can't judge fairly, each with its reason where it's passed. */
async function axe(page, where, variant, off = []) {
  // from the top: after a keyboard walk the page is scrolled, and the phone's sticky bar would sit over text
  // (and a table the walk scrolled sideways would hide its first column under its own edge)
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('.data-table')) el.scrollLeft = 0;
  });
  // A select's chevron (--chevron in app.css) is a background image, and axe won't judge text over any background
  // image: every select would land in "needs review" unjudged. The chevron sits in padding kept clear of the text,
  // so axe runs with it off and judges a select's text as it does an input's. (The chevron itself is --ink-2 on
  // --surface, past the 3:1 a control's graphics need in both themes.)
  const results = await page.evaluate(
    async ({ tags, extra, off }) => {
      const style = document.createElement('style');
      style.textContent = 'select { background-image: none !important; }';
      document.head.append(style);
      try {
        return await window.axe.run(document, {
          runOnly: { type: 'tag', values: tags },
          rules: Object.fromEntries([...extra.map((id) => [id, { enabled: true }]), ...off.map((id) => [id, { enabled: false }])]),
          resultTypes: ['violations', 'incomplete'],
        });
      } finally {
        style.remove();
      }
    },
    { tags: TAGS, extra: EXPERIMENTAL, off },
  );
  record(where, variant, results);
  // Reflow (WCAG 1.4.10), which axe doesn't test: on a phone the page itself never scrolls sideways. A table may
  // scroll inside its own frame; nothing else may stick out past the screen's edge.
  if ((page.viewportSize()?.width ?? 1280) < 500) {
    const over = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth <= w + 1) return null;
      let worst = null;
      for (const el of document.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.right <= w + 1 || r.width === 0 || !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) continue;
        let inScroller = false;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          if (getComputedStyle(a).overflowX !== 'visible') {
            inScroller = true;
            break;
          }
        }
        if (!inScroller && (!worst || r.right > worst.right)) worst = { right: r.right, html: el.outerHTML.slice(0, 120) };
      }
      return `the page is ${document.documentElement.scrollWidth}px wide on a ${w}px screen${worst ? `; ${worst.html} reaches ${Math.round(worst.right)}px` : ''}`;
    });
    if (over) failures.push(`reflow · ${where} [${variant}]: ${over}`);
  }
  for (const r of results.incomplete.filter((i) => REVIEW.includes(i.id))) {
    for (const node of r.nodes) {
      // ★★★★½ and the media icons: axe won't rate symbols. The stars' colours are set for 4.5:1 (ARCH.md §18)
      if (/only non-text characters/.test(node.any[0]?.message ?? '')) {
        symbolsOnly++;
        continue;
      }
      const key = `${r.id} · ${where} · ${node.target.join(' ')} — ${(node.any[0]?.message ?? '').slice(0, 140)}`;
      needsReview.set(key, (needsReview.get(key) ?? new Set()).add(variant));
    }
  }
}

// ── the throwaway instance ────────────────────────────────────────────────────────────────────────────────────

const WRANGLER = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const stateDir = mkdtempSync(join(tmpdir(), 'nalanda-a11y-'));
// Everything here is local: wrangler runs with --local and a temporary --persist-to, and never with --remote.
// Its environment also drops any Cloudflare credentials and the production database id, so no wrangler call
// made by this script could reach a Cloudflare account even by mistake, and sends no usage metrics.
// XDG_CONFIG_HOME points into the scratch state, so wrangler can't see a stored login (its OAuth token file) either.
const LOCAL_ENV = {
  ...process.env,
  CI: '1',
  WRANGLER_SEND_METRICS: 'false',
  XDG_CONFIG_HOME: join(stateDir, 'xdg'),
  // the Worker's variables come from the --env-file below and nothing else: not this process's environment
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'true',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
};
for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'D1_DATABASE_ID']) {
  delete LOCAL_ENV[key];
}
mkdirSync(LOCAL_ENV.XDG_CONFIG_HOME, { recursive: true });
// A11Y_USE_DEV_VARS=1 lets a developer's .dev.vars load (their BGG or Discogs tokens, for lookups CI can't do).
let server = null;
let refreshServer = null;
let coverServer = null;
let browser = null;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: LOCAL_ENV, ...opts });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out}`))));
  });
}

async function federationKey() {
  const { subtle } = globalThis.crypto;
  const keys = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', keys.privateKey);
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d });
}

/**
 * Starts a `wrangler dev` and waits for it to answer. The main instance takes the defaults. `dummyTokens` starts the
 * Refresh buttons' own instance instead: its Discogs and BGG tokens are a placeholder, so the buttons render, and
 * nothing else is on it — the main instance's Add-page lookups (a held non-ISBN barcode goes to Discogs when a token
 * is set) never run against a token, and the only requests that could use one, the refreshes, are answered by the
 * browser (page.route) or reach the Worker only when there is no id to look up.
 */
async function startServer({ port = PORT, dir = stateDir, dummyTokens = false } = {}) {
  const base = `http://127.0.0.1:${port}`;
  mkdirSync(dir, { recursive: true });
  await run(WRANGLER, ['d1', 'migrations', 'apply', 'nalanda', '--local', '--persist-to', dir]);
  const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  // The Worker's secrets, from a file in the scratch state rather than .dev.vars: given --env-file, wrangler doesn't
  // read .dev.vars at all — and it must not, since a .dev.vars value outranks a --var one, so a developer's real
  // provider tokens would otherwise be sent to BGG and Discogs from the audit. The tokens are there, empty: off.
  // Connections switched on (a throwaway key), so Feed, Notifications, Borrowed and Connections render.
  const useDevVars = process.env.A11Y_USE_DEV_VARS === '1' && !dummyTokens;
  const envFile = join(dir, 'a11y.env');
  writeFileSync(
    envFile,
    [
      `SESSION_SECRET=${secret}`,
      `FEDERATION_PRIVATE_KEY='${await federationKey()}'`,
      ...(useDevVars ? [] : ['GOOGLE_BOOKS_KEY=', 'HOME_SHARE_TOKEN=']),
      ...(useDevVars ? [] : dummyTokens ? ['DISCOGS_TOKEN=a11y-placeholder', 'BGG_TOKEN=a11y-placeholder'] : ['DISCOGS_TOKEN=', 'BGG_TOKEN=']),
    ].join('\n') + '\n',
  );
  let log = '';
  const child = spawn(
    WRANGLER,
    [
      'dev',
      '--local', // no remote bindings, whatever the config ever says
      '--ip', '127.0.0.1',
      '--port', String(port),
      '--inspector-port', String(port + 1000),
      '--persist-to', dir,
      '--show-interactive-dev-session=false',
      ...(useDevVars ? ['--env-file', '.dev.vars', '--env-file', envFile] : ['--env-file', envFile]),
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: LOCAL_ENV },
  );
  if (dummyTokens) refreshServer = child;
  else server = child;
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited ${child.exitCode}\n${log}`);
    try {
      const res = await fetch(`${base}/setup`, { redirect: 'manual' });
      if (res.status < 500) {
        // which file the Worker's variables came from — never .dev.vars unless A11Y_USE_DEV_VARS=1
        for (const line of log.split('\n').filter((l) => /Using (secrets|vars|environment variables) defined in/i.test(l))) console.log(`a11y: wrangler: ${line.trim()}`);
        return;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not answer on ${base} within 2 minutes\n${log}`);
}

// A real PNG, noisy enough to be over the 500 bytes storeCover() insists on, served for the Worker to fetch.
function coverPng(seed) {
  const w = 60;
  const h = 90;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let x = seed;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let i = 1; i <= w * 3; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      raw[y * (w * 3 + 1) + i] = (i % 3 === 0 ? 60 : 120) + (x % 60);
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function startCoverServer() {
  coverServer = createServer((req, res) => {
    const seed = Number(req.url?.match(/\d+/)?.[0] ?? 1);
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(coverPng(seed));
  });
  // a port already taken (another audit still running) fails the run cleanly, rather than crashing past cleanup
  return new Promise((resolve, reject) => {
    coverServer.once('error', (err) => reject(new Error(`the cover server can't listen on ${COVER_PORT}: ${err.code} — is another audit running?`)));
    coverServer.listen(COVER_PORT, '127.0.0.1', resolve);
  });
}

async function cleanup() {
  await browser?.close().catch(() => {});
  coverServer?.close();
  for (const child of [server, refreshServer]) {
    if (!child || child.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGTERM'); // wrangler's workerd children too
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  rmSync(stateDir, { recursive: true, force: true });
}

// ── driving the app ───────────────────────────────────────────────────────────────────────────────────────────

/** A form POST through the browser context's cookie jar; returns the response (redirects not followed). */
async function post(context, path, form, { htmx = false } = {}) {
  // as htmx: the reading routes answer a refusal with the section and its error, where a plain post would redirect
  // and drop it
  const headers = htmx ? { 'HX-Request': 'true' } : {};
  const res = await context.request.post(`${BASE}${path}`, { form, headers, maxRedirects: 0 });
  // many handlers refuse with a 200 and the page again, its error on it: a refused step fails the audit rather
  // than quietly leaving it to check a poorer page
  const body = res.status() < 300 ? await res.text() : '';
  const refused = body.match(/<p class="error"[^>]*>([\s\S]*?)<\/p>/)?.[1];
  if (res.status() >= 400 || refused) {
    throw new Error(`POST ${path} → ${res.status()}: ${(refused ?? body).replace(/<[^>]+>/g, '').trim().slice(0, 300)}`);
  }
  return res;
}

async function html(context, path) {
  return (await context.request.get(`${BASE}${path}`)).text();
}

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const today = () => daysAgo(0);

/** Everything the page list below needs that the seed doesn't make. Returns the ids it found or made. */
async function furnish(admin, member) {
  const nav = await html(admin, '/');
  const shelf = (name) => Number(nav.match(new RegExp(`href="/libraries/(\\d+)"[^>]*>\\s*<span>${name}</span>`))?.[1]);
  const shelves = { books: shelf('Books'), games: shelf('Board games'), vinyl: shelf('Vinyl') };
  if (!shelves.books || !shelves.games || !shelves.vinyl) throw new Error('Could not find the seeded shelves in the sidebar');

  const find = async (title) => {
    const page = await html(admin, `/search?q=${encodeURIComponent(title)}`);
    const id = Number(page.match(/href="\/items\/(\d+)"/)?.[1]);
    if (!id) throw new Error(`Seeded item "${title}" not found`);
    return id;
  };

  // one item of each media type with a cover (the seed runs offline, so it has none)
  const addWithCover = async (fields, seed) => {
    const res = await post(admin, '/items', {
      creators: '', isbn13: '', isbn10Upc: '', publisher: '', published: '2021', length: '', description: 'A description, for the page.',
      rating: '8', copies: '1', beganOn: '', completedOn: '', tags: 'audit', review: '', reviewedIn: '', notes: 'A private note.',
      details: '{}', coverUrl: `http://127.0.0.1:${COVER_PORT}/cover-${seed}.png`, ...fields,
    });
    const id = Number(res.headers().location?.match(/\/items\/(\d+)/)?.[1]);
    if (!id) throw new Error(`Adding "${fields.title}" did not land on its page`);
    return id;
  };
  // a book in a series with a gap (1 and 3 held), with a location; a record graded, with its pressing and tracklist
  const book = await addWithCover({ libraryId: String(shelves.books), mediaType: 'book', title: 'The Audit Book', creators: 'A. Writer', status: 'completed', completedOn: daysAgo(30), length: '320', isbn13: '9780000000002', location: 'Study, 2nd shelf', seriesName: 'The Audit Cycle', seriesNumber: '1' }, 1);
  await addWithCover({ libraryId: String(shelves.books), mediaType: 'book', title: 'The Audit Book, Part Three', creators: 'A. Writer', status: 'not_started', seriesName: 'The Audit Cycle', seriesNumber: '3' }, 4);
  const game = await addWithCover({ libraryId: String(shelves.games), mediaType: 'boardgame', title: 'The Audit Game', status: 'completed', details: '{"bgg_id":266192,"players_min":1,"players_max":5}' }, 2);
  const pressing = {
    discogs_id: 1, label: 'Audit Records, EMI', catno: 'AUD 001', country: 'UK', year: 1971, format: 'Vinyl, LP, Album',
    tracklist: [{ heading: 'Side A' }, { position: 'A1', title: 'Opening', duration: '3:41' }, { position: 'A2', title: 'Second', duration: '4:02' }, { heading: 'Side B' }, { position: 'B1', title: 'Closing', duration: '6:15' }],
  };
  const record = await addWithCover({ libraryId: String(shelves.vinyl), mediaType: 'vinyl', title: 'The Audit Record', status: 'completed', details: JSON.stringify(pressing), mediaCondition: 'VG+', sleeveCondition: 'VG', location: 'Living room, crate 2' }, 3);

  const reading = await find('The Dispossessed'); // seeded "in progress", 387 pages
  const reread = await find('The Left Hand of Darkness'); // seeded completed
  const overdue = await find('Azul');

  // reading: a page recorded, a second finish (so "Read 2 times" and ×2 show), a loan past its due date
  await post(admin, `/items/${reading}/progress`, { page: '120' }, { htmx: true });
  await post(admin, `/items/${reread}/reads`, { status: 'completed', beganOn: '2019-01-02', endedOn: '2019-02-03' }, { htmx: true });
  await post(admin, `/items/${overdue}/loan`, { borrower: 'Meera', contact: '', dueOn: daysAgo(3) });
  // "Lent before": a loan of the book, returned
  await post(admin, `/items/${book}/loan`, { borrower: 'Priya', contact: '', dueOn: '' });
  const loanId = (await html(admin, `/items/${book}`)).match(/action="\/loans\/(\d+)\/return"/)?.[1];
  if (!loanId) throw new Error('furnishing: the book\'s loan has no return form');
  await post(admin, `/loans/${loanId}/return`, {});
  // a play log for the game and a listening log for the record
  for (const [id, date] of [[game, today()], [game, daysAgo(12)], [game, daysAgo(40)], [record, daysAgo(2)]]) {
    await post(admin, `/items/${id}/plays`, { date }, { htmx: true });
  }

  // a second member — the reading and review sections then name people
  const minted = await (await post(admin, '/settings/users', { username: 'ravi', role: 'member' })).text();
  const temp = minted.match(/<code>([^<]+)<\/code>/)?.[1];
  if (!temp) throw new Error('No temporary password shown for the new member');
  // each member's display-name form: its action's id, and the name its field is labelled with
  const people = new Map(
    [...(await html(admin, '/settings/users')).matchAll(/action="\/settings\/users\/(\d+)\/display-name"[\s\S]*?aria-label="Display name for ([^"]+)"/g)].map((m) => [m[2], Number(m[1])]),
  );
  const raviId = people.get('ravi');
  const adminId = people.get(USERNAME);
  await post(admin, `/settings/users/${adminId}/display-name`, { displayName: 'Lakshmi' });
  if (!raviId || !adminId) throw new Error('Could not find the members on /settings/users');
  await post(admin, `/settings/users/${raviId}/display-name`, { displayName: 'Ravi' });
  // this year's reading goal for the admin: the Overview's goal card and /goals show it
  await post(admin, '/goals', { userId: String(adminId), year: today().slice(0, 4), target: '12' });

  // names and progress on share pages, so their fullest form is audited; a tag share and a board-game share too
  await post(admin, '/shares/settings', { setting: 'progress', progressOnShares: 'on' });
  await post(admin, '/shares/settings', { setting: 'names', namesOnShares: 'on' });
  await post(admin, '/shares', { libraryId: String(shelves.books), name: 'Everything on the book shelf', sort: 'title' });
  await post(admin, '/shares', { libraryId: String(shelves.games), name: 'Our games', sort: 'title' });
  await post(admin, '/shares', { tag: 'favourites', name: 'Favourites' });

  // connections, without a peer: named, a view shared and an invitation made, so those tables render
  await post(admin, '/connections/settings', { householdName: 'The Audit Library' });
  await post(admin, '/connections/views', { name: 'Finished books', libraryId: String(shelves.books), mediaType: 'book', status: 'completed', owned: '' });
  await post(admin, '/connections/invites', {});

  // an empty shelf, and enough books that a shelf has a second page (60 to a page)
  const wishlist = Number((await post(admin, '/libraries', { name: 'Wishlist' })).headers().location?.match(/\/libraries\/(\d+)/)?.[1]);
  const filler = Array.from({ length: 55 }, (_, i) => ({ Title: `Ledger volume ${i + 1}`, Creators: 'The Registrar', 'Item Type': 'Books', Status: 'not begun', Copies: '1' }));
  const imported = await admin.request.post(`${BASE}/api/import`, { data: { libraryId: shelves.books, rows: filler, defaultType: 'book' } });
  if (!imported.ok()) throw new Error(`Importing the filler books failed: ${imported.status()}`);

  // want lists (§16 #53): the filler books made not owned and wanted, so the Wanted badge shows on shelves and on
  // the Read next card; a purchase link on one; and the admin's list published as a gift list
  const shelfPage = await html(admin, `/libraries/${shelves.books}?q=Ledger`);
  const fillers = [...new Set([...shelfPage.matchAll(/href="\/items\/(\d+)" title="Ledger volume/g)].map((m) => m[1]))];
  if (fillers.length < 50) throw new Error(`furnishing: found ${fillers.length} filler books`);
  const bulk = await admin.request.post(`${BASE}/bulk`, {
    data: new URLSearchParams([['action', 'not-owned'], ['back', '/'], ...fillers.map((id) => ['id', id])]).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
  });
  if (bulk.status() >= 400) throw new Error(`furnishing: bulk not-owned → ${bulk.status()}`);
  for (const id of fillers) await post(admin, `/items/${id}/want`, { want: '1' });
  const wanted = Number(fillers[0]);
  await post(admin, `/items/${wanted}/links`, { label: 'Bookshop', url: 'https://example.org/ledger-volume' }, { htmx: true });
  const stamp = (await html(admin, '/wants')).match(/name="wantStamp" value="([^"]+)"/)?.[1];
  if (!stamp) throw new Error('furnishing: /wants offers no gift-list publish form');
  const before = new Set([...(await html(admin, '/shares')).matchAll(/\/share\/([A-Za-z0-9_-]{16,})/g)].map((m) => m[1]));
  await post(admin, '/shares', { wantUserId: String(adminId), wantStamp: stamp });

  const shares = [...new Set([...(await html(admin, '/shares')).matchAll(/\/share\/([A-Za-z0-9_-]{16,})/g)].map((m) => m[1]))];

  // what the pages below rely on is really there — a check that fails here names the step, instead of the audit
  // quietly looking at a poorer page
  const expect = async (path, what, pattern) => {
    if (!pattern.test(await html(admin, path))) throw new Error(`furnishing: ${path} does not show ${what}`);
  };
  await expect(`/items/${reading}`, 'the page recorded', /p\. 120/);
  await expect(`/items/${reread}`, 'a second finish', /read 2 times/);
  await expect(`/items/${overdue}`, 'the overdue loan', /overdue/);
  await expect(`/items/${book}`, 'its cover', /<img class="cover-img"/);
  await expect('/connections', 'the shared view', /Finished books/);
  await expect(`/libraries/${shelves.books}?page=2`, 'a second page', /class="pagination"/);
  await expect(`/items/${book}`, 'its location and a returned loan', /Study, 2nd shelf[\s\S]*Lent before|Lent before[\s\S]*Study, 2nd shelf/);
  await expect(`/items/${record}`, 'its pressing and tracklist', /AUD 001[\s\S]*Side A|Side A[\s\S]*AUD 001/);
  await expect(`/items/${game}`, 'its plays', /Played[\s\S]*times/);
  await expect('/', 'the goal and a book to read next', /Reading goal[\s\S]*Read next/);
  const seriesId = Number((await html(admin, '/series')).match(/href="\/series\/(\d+)"/)?.[1]);
  if (!seriesId) throw new Error('furnishing: /series lists no series');
  const creator = (await html(admin, '/creators')).match(/href="\/creators\/([^"]+)"/)?.[1];
  if (!creator) throw new Error('furnishing: /creators lists nobody');
  const publisher = (await html(admin, '/publishers')).match(/href="\/publishers\/([^"]+)"/)?.[1];
  if (!publisher) throw new Error('furnishing: /publishers lists nobody');
  if (shares.length < 5 || !wishlist) throw new Error(`furnishing: ${shares.length} share links and wishlist ${wishlist}`);
  const giftToken = shares.find((t) => !before.has(t));
  if (!giftToken) throw new Error('furnishing: the gift list was not published');
  await expect(`/libraries/${shelves.books}`, 'the Wanted badge', /pill wanted/);
  await expect('/wants', 'the want list and its purchase link', /want-card[\s\S]*Bookshop/);
  return { shelves, wishlist, seriesId, creator, publisher, book, game, record, reading, reread, overdue, temp, shares, giftToken, wanted, raviId, member };
}

// ── pages ─────────────────────────────────────────────────────────────────────────────────────────────────────

function pageList(ids) {
  const s = ids.shelves;
  const list = [
    ['Overview', '/'],
    ['Shelf: books, table', `/libraries/${s.books}`],
    ['Shelf: books, covers', `/libraries/${s.books}?view=grid`],
    ['Shelf: games, table', `/libraries/${s.games}`],
    ['Shelf: vinyl, covers', `/libraries/${s.vinyl}?view=grid`],
    ['Shelf: filtered, nothing matches', `/libraries/${s.vinyl}?type=book`],
    ['Shelf: empty', `/libraries/${ids.wishlist}`],
    ['Shelf: books, second page', `/libraries/${s.books}?page=2`],
    ['Item: book, being read', `/items/${ids.reading}`],
    ['Item: book, read twice', `/items/${ids.reread}`],
    ['Item: book with cover', `/items/${ids.book}`],
    ['Item: board game (BGG)', `/items/${ids.game}`],
    ['Item: vinyl', `/items/${ids.record}`],
    ['Item: lent, overdue', `/items/${ids.overdue}`],
    ['Edit: book', `/items/${ids.reading}/edit`],
    ['Edit: board game', `/items/${ids.game}/edit`],
    ['Edit: record (grades)', `/items/${ids.record}/edit`],
    ['Plays: every play of a game', `/items/${ids.game}/plays`],
    ['Series', '/series'],
    ['Series: one series', `/series/${ids.seriesId}`],
    ['Creators', '/creators'],
    ['Creators: narrowed', '/creators?q=le'],
    ['Creator: one author', `/creators/${ids.creator}`],
    ['Publishers', '/publishers'],
    ['Publisher: one publisher', `/publishers/${ids.publisher}`],
    ['Reading goals', '/goals'],
    ['Want list: yours', '/wants'],
    ['Want list: a member\'s', `/wants?member=${ids.raviId}`],
    ['Add items', '/add'],
    ['Search: empty', '/search'],
    ['Search: results', '/search?q=le+guin'],
    ['Search: no results', '/search?q=zzzzqqq'],
    ['Tags', '/tags'],
    ['Tag', '/tags/favourites'],
    ['Loans', '/loans'],
    ['Shared links', '/shares'],
    ['Import / export', '/import'],
    ['Account', '/account'],
    ['Members', '/settings/users'],
    ['Connections', '/connections'],
    ['Feed', '/feed'],
    ['Notifications', '/notifications'],
    ['Borrowed', '/borrowed'],
    ['Not found (signed in)', '/no-such-page', 404],
  ];
  for (const [i, token] of ids.shares.entries()) list.push([`Share ${i + 1}${token === ids.giftToken ? ' (gift list)' : ''}: list`, `/share/${token}`]);
  list.push(['Share: not found', '/share/not-a-real-token', 404]);
  return list;
}

/** The share item pages: every item linked from each share list, one per media type, plus a book with progress. */
async function shareItemPages(context, tokens) {
  const out = [];
  const seen = new Set();
  for (const token of tokens) {
    const list = await html(context, `/share/${token}`);
    // every list's first item, whatever its markup (a gift list's cards differ from a shelf's)
    const first = list.match(/href="(\/share\/[^"]+\/items\/\d+)"/)?.[1];
    if (first && !out.some(([, path]) => path === first)) out.push([`Share item: first on /share/${token.slice(0, 6)}…`, first]);
    for (const m of list.matchAll(/href="(\/share\/[^"]+\/items\/\d+)"[\s\S]*?<small class="muted">([^<]+)<\/small>/g)) {
      const kind = m[2];
      const title = list.slice(m.index, m.index + 600).match(/<strong>([^<]+)<\/strong>/)?.[1] ?? '';
      const key = /Dispossessed|Audit|Darkness/.test(title) ? title : kind;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([`Share item: ${title}`, m[1]]);
    }
  }
  return out;
}

async function open(page, path, expected = 200, base = BASE) {
  const res = await page.goto(`${base}${path}`, { waitUntil: 'load' });
  const status = res?.status() ?? 0;
  const landed = new URL(page.url()).pathname;
  const wanted = new URL(`${base}${path}`).pathname;
  if (status !== expected || landed !== wanted) {
    throw new Error(`${path}: expected ${expected} at ${wanted}, got ${status} at ${landed}`);
  }
  await page.addScriptTag({ content: AXE });
}

async function withVariant(context, variant, fn) {
  const page = await context.newPage();
  await page.setViewportSize({ width: variant.width, height: variant.height });
  await page.emulateMedia({ colorScheme: variant.scheme, reducedMotion: 'reduce' });
  page.on('pageerror', (err) => failures.push(`script error on ${page.url()}: ${err.message}`));
  // A11Y_CPU_THROTTLE=4 (or 6…) runs the browser that many times slower, and adds network latency, to reproduce a
  // slow CI runner's pace locally (Chromium's own CPU throttling, over the DevTools protocol)
  const rate = Number(process.env.A11Y_CPU_THROTTLE ?? 1);
  if (rate > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: -1, uploadThroughput: -1 });
  }
  try {
    await fn(page);
  } finally {
    await page.close();
  }
}

// ── keyboard ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Tabs through the whole page from the top: the first stop must be the skip link where there is a sidebar (and
 * following it must land in <main>), some stop must be inside <main>, every stop must show a focus indicator, and
 * the walk must come back round to the start — a page that never lets go of focus traps it.
 */
async function keyboard(page, where, variant) {
  const hasSidebar = await page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll('*')) el.setAttribute('data-a11y-k', String(n++));
    return document.querySelector('.sidebar') !== null;
  });
  const stop = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      // A focus indicator, judged by what it would draw, not merely that a style is set:
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const alpha = (color) => {
        const parts = color.match(/rgba?\(([^)]*)\)/)?.[1].split(/[\s,/]+/).filter(Boolean) ?? [];
        return parts.length > 3 ? parseFloat(parts[3]) : 1;
      };
      // - an outline that is drawn, not faint, and not clipped away on two or more sides by an ancestor that hides
      //   its overflow (a 2px ring inside a rounded toggle clipped top and bottom reads as nothing)
      const ow = parseFloat(s.outlineWidth) || 0;
      let outline = s.outlineStyle !== 'none' && ow > 0 && alpha(s.outlineColor) >= 0.5;
      const grow = ow + (parseFloat(s.outlineOffset) || 0);
      if (outline && grow > 0) {
        for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
          const as = getComputedStyle(a);
          if (as.overflowX === 'visible' && as.overflowY === 'visible') continue;
          const ar = a.getBoundingClientRect();
          const clipped = [r.top - grow < ar.top - 0.5, r.bottom + grow > ar.bottom + 0.5, r.left - grow < ar.left - 0.5, r.right + grow > ar.right + 0.5];
          if (clipped.filter(Boolean).length >= 2) outline = false;
          break;
        }
      }
      // - a box-shadow ring that isn't a faint tint (input:focus's 9% indigo glow is not, on its own, an indicator)
      const shadow = s.boxShadow !== 'none' && alpha(s.boxShadow.match(/rgba?\([^)]*\)/)?.[0] ?? 'rgb(0,0,0)') >= 0.3;
      // - or a border or background that changes on focus (a field's border turning indigo): compared with an
      //   unfocused twin of the element, placed beside it for a moment
      const twin = el.cloneNode(false);
      twin.removeAttribute('id');
      el.after(twin);
      const t = getComputedStyle(twin);
      const changed =
        (parseFloat(s.borderTopWidth) > 0 && s.borderTopColor !== t.borderTopColor) || s.backgroundColor !== t.backgroundColor;
      twin.remove();
      // - a date input's calendar button: focus sits inside the browser's own control, which draws its own ring
      const native = el.matches(':focus-within') && !el.matches(':focus');
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ');
      return {
        id: el.getAttribute('data-a11y-k'),
        label: `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? ` class="${el.className.trim()}"` : ''}> "${name.slice(0, 40)}"`,
        inMain: !!el.closest('main'),
        skip: el.classList.contains('skip-link'),
        visible: outline || shadow || changed || native,
        onScreen: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
      };
    });
  // Start from the top of the page, whatever has focus (a search box with autofocus, say): focus a throwaway
  // element placed first in <body>, then remove it — the next Tab goes to the page's first stop.
  const fromTop = () =>
    page.evaluate(() => {
      window.scrollTo(0, 0);
      const start = document.createElement('span');
      start.tabIndex = -1;
      document.body.prepend(start);
      start.focus();
      start.remove();
    });
  const mainHasStops = await page.evaluate(
    () => !!document.querySelector('main a[href], main button, main input:not([type="hidden"]), main select, main textarea, main summary'),
  );

  const fail = (msg) => failures.push(`keyboard · ${where} [${variant}]: ${msg}`);
  await fromTop();
  await page.keyboard.press('Tab');
  const first = await stop();
  if (!first) {
    // a page with nothing to focus (a share link that's gone) has no tab order to walk
    const focusable = await page.evaluate(() => !!document.querySelector('a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]'));
    return focusable ? fail('the first Tab focused nothing') : undefined;
  }
  if (hasSidebar) {
    if (!first.skip) fail(`the first Tab stop is ${first.label}, not the "Skip to content" link`);
    else {
      if (!first.onScreen) fail('the skip link is focused but not on screen');
      if (!first.visible) fail('the skip link has no visible focus indicator');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      const after = await stop();
      if (mainHasStops && !after?.inMain) fail(`after the skip link, Tab went to ${after?.label ?? 'nothing'}, not into <main>`);
    }
    await fromTop();
    await page.keyboard.press('Tab');
  }

  // Every stop, once round: each must show focus, and the walk must come back to the start — a page that never
  // lets go of focus traps it. A date input is up to four stops (month, day, year, calendar), hence the margin.
  const tabbable = await page.evaluate(() =>
    [...document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]')]
      .filter(
        (el) =>
          !el.disabled &&
          el.getAttribute('tabindex') !== '-1' &&
          el.type !== 'hidden' &&
          !el.closest('[inert]') &&
          el.checkVisibility?.({ visibilityProperty: true }) !== false,
      )
      .map((el) => [el.getAttribute('data-a11y-k'), `<${el.tagName.toLowerCase()}> "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`]),
  );
  const limit = tabbable.length * 4 + 25;
  const seen = [];
  const invisible = new Set();
  let reachedMain = false;
  let wrapped = false;
  let cur = await stop();
  for (let i = 0; i < limit; i++) {
    if (cur) {
      if (seen.length && cur.id === seen[0].id) {
        wrapped = true;
        break;
      }
      seen.push(cur);
      if (cur.inMain) reachedMain = true;
      if (!cur.visible) invisible.add(cur.label);
    } else if (seen.length) {
      wrapped = true; // focus left the document: the end of the tab order
      break;
    }
    await page.keyboard.press('Tab');
    cur = await stop();
  }
  for (const label of invisible) fail(`no visible focus indicator on ${label}`);
  // every visible control was a stop: focus jumping back to the start, or out to <body>, early is no pass
  const visited = new Set(seen.map((st) => st.id));
  const missed = tabbable.filter(([id]) => !visited.has(id));
  if (wrapped && missed.length) fail(`Tab never reached ${missed.length}: ${missed.slice(0, 5).map(([, l]) => l).join(', ')}`);
  if (mainHasStops && !reachedMain) fail('Tab never reached anything in <main>');
  if (!wrapped) {
    const tail = seen.slice(-6).map((s) => s.label).join(' → ');
    fail(`Tab never came back round after ${limit} presses — focus is trapped (last stops: ${tail})`);
  }
}

// ── htmx interactions (the ones on main: the Add page's lookups, the reading section, the Holding toggle) ──────

async function interactions(context, ids, variant) {
  const where = (s) => `htmx: ${s}`;
  // each step on its own: one that can't be done is a failure in the report, and the rest still run. --only=htmx runs
  // them all; any other --only runs the steps whose name has it (--only="More results")
  const step = async (name, fn) => {
    if (ONLY && !'htmx'.includes(ONLY.toLowerCase()) && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
    try {
      await fn();
    } catch (err) {
      // the first line, and what Playwright was waiting for when it gave up
      const waiting = err.message.match(/waiting for (.*)/)?.[1];
      failures.push(`interaction · ${name} [${variant.name}]: ${err.message.split('\n')[0]}${waiting ? ` — waiting for ${waiting.slice(0, 160)}` : ''}`);
    }
  };
  // Runs `action` and waits for the htmx request it starts to finish swapping into `sel`: htmx's own
  // htmx:afterSettle, fired on the new content once the swap has settled. Not a change in the region's HTML — htmx
  // marks the requesting form with a class the moment the request starts, which reads as a change long before the
  // answer arrives (a slow CI runner then checked focus mid-swap, and pressed buttons in content about to be
  // replaced) — and not a fixed delay.
  const htmxDone = async (page, sel, action, timeout = 15_000) => {
    await page.evaluate(() => {
      if (!window.__a11ySettled) {
        window.__a11ySettled = [];
        document.addEventListener('htmx:afterSettle', (e) => window.__a11ySettled.push(e.target));
      }
      window.__a11yMark = window.__a11ySettled.length;
    });
    await action();
    await page.waitForFunction(
      (q) => {
        const region = document.querySelector(q);
        return !!region && window.__a11ySettled.slice(window.__a11yMark).some((t) => t.isConnected && (t === region || region.contains(t) || t.contains(region)));
      },
      sel,
      { timeout, polling: 25 },
    );
  };
  // after a swap, keyboard focus must be somewhere, not dropped back to <body> at the top of the page
  const focusKept = async (page, what) => {
    const lost = await page.evaluate(() => !document.activeElement || document.activeElement === document.body);
    if (lost) failures.push(`keyboard · ${what} [${variant.name}]: focus fell to <body> after the swap`);
  };
  // A lookup needs Open Library, which can be slow or refuse a burst: one retry, then it's reported as not audited
  // (and on GitHub Actions as a warning), with what came back instead — a notice says why.
  const lookup = async (page, submit, results, label) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      // empty first, so what was there from the last lookup can't pass for this one's answer
      await page.evaluate((sel) => {
        const box = document.querySelector(sel);
        if (box) box.innerHTML = '';
      }, results);
      await submit();
      const settled = page.locator(`${results} .candidate, ${results} .notice`).first();
      await settled.waitFor({ timeout: 20_000 }).catch(() => {});
      if (await page.locator(`${results} .candidate`).count()) return true;
      if (attempt === 2) {
        const notice = (await page.locator(`${results} .notice`).allTextContents()).join(' ').trim();
        unaudited.push(`${label} [${variant.name}]: ${notice ? `the lookup said "${notice.slice(0, 120)}"` : 'no answer within 20 s'}`);
      }
    }
    return false;
  };

  await withVariant(context, variant, async (page) => {
    page.on('dialog', (d) => d.accept()); // hx-confirm's "Delete this read…?"

    // Add → Scan: typing a barcode, the path that needs no camera
    await step('Add → typed barcode', async () => {
      await open(page, '/add');
      const barcode = page.getByLabel(/barcode/i);
      await barcode.fill('12345', { timeout: 5000 });
      await barcode.press('Enter');
      await page.locator('#scan-results .notice').waitFor({ timeout: 10_000 });
      await axe(page, where('Add → typed barcode, not valid'), variant.name);
      const found = await lookup(page, async () => {
        await barcode.fill('9780441478125');
        await barcode.press('Enter');
      }, '#scan-results', 'Add → typed ISBN → candidate card');
      if (found) await axe(page, where('Add → typed ISBN, a book found'), variant.name);
    });

    await step('Add → Search', async () => {
      await open(page, '/add');
      await page.getByRole('button', { name: /search/i }).first().click();
      if ((await page.getByRole('button', { name: /search/i }).first().getAttribute('aria-pressed')) !== 'true') {
        throw new Error('the Search button does not say it is pressed');
      }
      const q = page.locator('#tab-search input[name="q"]');
      const found = await lookup(page, async () => {
        await q.fill('Piranesi');
        await q.press('Enter');
      }, '#search-results', 'Add → Search → results');
      if (found) await axe(page, where('Add → search results'), variant.name);
      await page.getByRole('button', { name: /manual/i }).click();
      await axe(page, where('Add → Manual tab'), variant.name);
    });

    // More results (§16 #66): the next page of a name search swaps in where the button was, under the button's own
    // id, and focus lands on it (app.js), so Tab carries on into the new results. A common word, so there is a next
    // page. Both pages come from Open Library, which can refuse a burst: one more try from the top, a moment later,
    // then the state is reported as not audited.
    await step('Add → Search → More results', async () => {
      let id = null;
      for (let attempt = 1; attempt <= 2 && !id; attempt++) {
        if (attempt > 1) await page.waitForTimeout(2000);
        await open(page, '/add');
        await page.getByRole('button', { name: /search/i }).first().click();
        const q = page.locator('#tab-search input[name="q"]');
        const found = await lookup(page, async () => {
          await q.fill('history');
          await q.press('Enter');
        }, '#search-results', 'Add → Search → More results, the first page');
        if (!found) return;
        const more = page.locator('#search-results .results-more').last();
        if (!(await more.count())) {
          if (attempt === 2) unaudited.push(`Add → Search → More results [${variant.name}]: the first page offered no More results`);
          continue;
        }
        const next = await more.getAttribute('id');
        await htmxDone(page, `#${next}`, () => more.getByRole('button', { name: 'More results' }).press('Enter'), 25_000);
        if (await page.locator(`#${next} .candidate`).count()) id = next;
        else if (attempt === 2) {
          const notice = (await page.locator(`#${next} .notice`).allTextContents()).join(' ').trim();
          unaudited.push(`Add → Search → More results [${variant.name}]: the next page said "${notice.slice(0, 120) || 'nothing'}"`);
        }
      }
      if (!id) return;
      await axe(page, where('Add → Search → More results, the next page'), variant.name);
      await focusKept(page, where('Add → Search → More results'));
      const focused = await page.evaluate(() => document.activeElement?.id ?? '');
      if (focused !== id) failures.push(`keyboard · ${where('Add → Search → More results')} [${variant.name}]: focus is on ${focused ? `#${focused}` : 'an element with no id'}, not the next page's #${id}`);
    });

    // The reading section: every form in it swaps the section. Driven from the keyboard (Enter on the field or
    // the button), so what happens to focus afterwards is what a keyboard user gets.
    const reading = page.locator('#reading');
    const swap = async (label, fn) => {
      await htmxDone(page, '#reading', fn);
      await axe(page, where(`Reading → ${label}`), variant.name);
      await focusKept(page, where(`Reading → ${label}`));
    };
    // the viewer's own block: with more than one member, everyone's reading is on the page, the viewer's first
    const own = () => reading.locator('.reader-self');
    await step('Reading', async () => {
      await open(page, `/items/${ids.reading}`);
      await swap('Record, refused', async () => {
        await reading.getByLabel('Page reached').fill('999999');
        await reading.getByLabel('Page reached').press('Enter');
      });
      await swap('Record a page', async () => {
        await reading.getByLabel('Page reached').fill('150');
        await reading.getByRole('button', { name: 'Record' }).press('Enter');
      });
      await swap('Remove a page', () => own().locator('.progress-log button', { hasText: 'Remove' }).first().press('Enter'));
      await reading.locator('summary', { hasText: 'Add a past read' }).press('Enter');
      await swap('Add a past read', async () => {
        const form = reading.locator('details.read-add form');
        await form.getByLabel('Began').fill('2015-05-01');
        await form.getByLabel('Ended').fill('2015-06-01');
        await form.getByRole('button', { name: 'Add' }).press('Enter');
      });
      await reading.locator('.read-history summary', { hasText: 'Edit' }).first().press('Enter');
      await axe(page, where('Reading → a read opened for editing'), variant.name);
      await swap('Save a read', () => reading.locator('.read-history details[open] form').first().getByRole('button', { name: 'Save' }).press('Enter'));
      // the past read just added, deleted (hx-confirm, accepted above) — the last line of the viewer's history
      await own().locator('.read-history > li', { hasText: '2015-05-01' }).locator('summary').press('Enter');
      await swap('Delete a read', () => own().locator('.read-history details[open] button', { hasText: 'Delete this read' }).press('Enter'));
      await swap('Finish', () => reading.getByRole('button', { name: 'Finish' }).first().press('Enter'));
      await swap('Read again', () => reading.getByRole('button', { name: /Read again/ }).press('Enter'));
      await swap('Stop', () => reading.getByRole('button', { name: /Stop/ }).first().press('Enter'));
      // an admin moves a finished read of theirs to another member
      await own().locator('.read-history > li summary', { hasText: 'Edit' }).first().press('Enter');
      await swap('Move a read to another member', () => own().locator('.read-history details[open] button', { hasText: /^Move/ }).first().press('Enter'));
      // open again, as it was, for the next variant
      await swap('Read again, to leave it open', () => reading.getByRole('button', { name: /Read again|Start again/ }).first().press('Enter'));
    });

    // the Holding toggle, on a shelf's table
    await step('Shelf → Holding toggle', async () => {
      await open(page, `/libraries/${ids.shelves.books}`);
      const toggle = `button[hx-post="/items/${ids.book}/mark-not-owned"]`;
      const back = `button[hx-post="/items/${ids.book}/mark-owned"]`;
      await htmxDone(page, back, () => page.locator(toggle).press('Enter'));
      await axe(page, where('Shelf → Holding toggled to Not owned'), variant.name);
      await focusKept(page, where('Shelf → Holding toggle'));
      await htmxDone(page, toggle, () => page.locator(back).press('Enter'));
      await axe(page, where('Shelf → Holding toggled back to Owned'), variant.name);
    });

    // Read next's "Another" (hx-get into #read-next): a new suggestion in place, focus kept on the button
    await step('Overview → Read next → Another', async () => {
      await open(page, '/');
      await htmxDone(page, '#read-next', () => page.locator('#read-next-another').press('Enter'));
      await axe(page, where('Overview → Read next → Another'), variant.name);
      await focusKept(page, where('Overview → Read next → Another'));
    });

    // A failed htmx request (§16 #65): Another answered 500 by the browser itself, so nothing on the server changes.
    // htmx swaps nothing; app.js says so in the layout's message region, which is audited showing, in both themes and
    // at both widths — and the button pressed keeps focus.
    await step('Overview → Another fails', async () => {
      await open(page, '/');
      const route = (url) => url.pathname === '/' && url.searchParams.has('not');
      await page.route(route, (r) => r.fulfill({ status: 500, contentType: 'text/plain', body: 'Something went wrong.' }));
      try {
        await page.locator('#read-next-another').press('Enter');
        await page.locator('#app-status').filter({ hasText: /\S/ }).waitFor({ timeout: 10_000 });
        await axe(page, where('Overview → Another fails, the message showing'), variant.name);
        await focusKept(page, where('Overview → Another fails'));
      } finally {
        await page.unroute(route);
      }
    });

    // a board game's play log: Played, then the play removed, each swapping #plays
    await step('Play log', async () => {
      await open(page, `/items/${ids.game}`);
      const plays = page.locator('#plays');
      const swapPlays = async (label, fn) => {
        await htmxDone(page, '#plays', fn);
        await axe(page, where(`Play log → ${label}`), variant.name);
        await focusKept(page, where(`Play log → ${label}`));
      };
      await swapPlays('Played', () => plays.getByRole('button', { name: 'Played' }).press('Enter'));
      await swapPlays('Remove a play', () => plays.locator('.play-log button', { hasText: 'Remove' }).first().press('Enter'));
    });

    // the item page's want toggle (#want-bar) and Where to buy's add and remove (#buy), each swapped in place
    await step('Want list and Where to buy', async () => {
      await open(page, `/items/${ids.wanted}`);
      const swapIn = async (sel, label, fn) => {
        await htmxDone(page, sel, fn);
        await axe(page, where(label), variant.name);
        await focusKept(page, where(label));
      };
      const toggle = () => page.locator('#want-bar button.want-toggle').press('Enter');
      await swapIn('#want-bar', 'Item → taken off the want list', toggle);
      await swapIn('#want-bar', 'Item → back on the want list', toggle);
      await page.locator('#buy summary', { hasText: 'Add a link' }).press('Enter');
      await swapIn('#buy', 'Where to buy → a link refused', async () => {
        await page.locator('#buy input[name="url"]').fill('not a link');
        await page.locator('#buy form.buy-form').evaluate((f) => (f.noValidate = true));
        await page.locator('#buy').getByRole('button', { name: 'Add link' }).press('Enter');
      });
      await swapIn('#buy', 'Where to buy → a link added', async () => {
        await page.locator('#buy input[name="label"]').fill(`Shop ${variant.scheme} ${variant.width}`);
        await page.locator('#buy input[name="url"]').fill(`https://example.org/${variant.scheme}-${variant.width}`);
        await page.locator('#buy').getByRole('button', { name: 'Add link' }).press('Enter');
      });
      await swapIn('#buy', 'Where to buy → a link removed', () => page.locator('#buy .buy-links button', { hasText: 'Remove' }).last().press('Enter'));
    });

    // Read next's card with the Wanted badge: nearly every candidate is a wanted, not-owned book here
    await step('Overview → Read next, wanted', async () => {
      for (let i = 0; i < 10; i++) {
        await open(page, '/');
        if (await page.locator('#read-next .pill.wanted').count()) {
          await axe(page, 'Overview → Read next with the Wanted badge', variant.name);
          return;
        }
      }
      throw new Error('ten suggestions, none of them a wanted book');
    });

    // bulk edit: pick two items, the bar says so; a tag added in bulk leaves its notice; a bulk delete asks first
    await step('Bulk edit', async () => {
      await open(page, `/libraries/${ids.shelves.books}`);
      const picks = page.locator('input.bulk-pick');
      await picks.nth(0).check();
      await picks.nth(1).check();
      await axe(page, where('Shelf → two items picked, the bulk bar'), variant.name);
      await page.selectOption('form.bulk-bar select[name="action"]', 'tag-add');
      await page.locator('form.bulk-bar input[name="tag"]').fill('audit-bulk');
      await page.locator('form.bulk-bar').getByRole('button', { name: 'Apply' }).click();
      await page.waitForLoadState('load');
      await page.locator('output.notice, .notice').first().waitFor({ timeout: 10_000 });
      await page.addScriptTag({ content: AXE });
      await axe(page, 'Shelf → bulk tag added, its notice', variant.name);
      const picks2 = page.locator('input.bulk-pick');
      await picks2.nth(0).check();
      await picks2.nth(1).check();
      await page.selectOption('form.bulk-bar select[name="action"]', 'delete');
      await page.locator('form.bulk-bar').getByRole('button', { name: 'Apply' }).click();
      await page.waitForLoadState('load');
      await page.getByRole('link', { name: 'Cancel' }).waitFor({ timeout: 10_000 });
      await page.addScriptTag({ content: AXE });
      await axe(page, 'Bulk delete → its confirmation', variant.name);
      if (variant.scheme === 'light') await keyboard(page, 'Bulk delete → its confirmation', variant.name);
    });

    // the Add page's review list: barcodes held on the device while offline, looked up now (ARCH.md §16 #48)
    await step('Add → scans held offline', async () => {
      await open(page, '/add');
      const held = await page.evaluate(async () => {
        const q = window.nalandaScanQueue;
        await q.clear();
        await q.hold('9780441478125');
        await q.hold('12345678');
        return q.count();
      });
      if (held < 1) throw new Error('the scan queue held nothing (no owner stamp on this device?)');
      await open(page, '/add');
      await page.locator('#scan-review:not([hidden])').waitFor({ timeout: 10_000 });
      // every held scan looked up and listed
      await page.waitForFunction((n) => document.querySelectorAll('#scan-review-list > *').length >= n, held, { timeout: 30_000 });
      await axe(page, 'Add → scans held offline, the review list', variant.name);
      if (variant.scheme === 'light') await keyboard(page, 'Add → scans held offline, the review list', variant.name);
      await page.evaluate(() => window.nalandaScanQueue.clear());
    });

    // the phone drawer: open, it's the page's navigation; Escape closes it and hands focus back
    if (variant.width < 881) {
      await step('Phone menu', async () => {
        await open(page, '/');
        const toggle = page.locator('#nav-toggle');
        await toggle.click();
        await page.locator('#sidebar .nav-link').first().waitFor({ state: 'visible', timeout: 5000 });
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') throw new Error('the menu button does not say it is expanded');
        await axe(page, 'Phone menu open', variant.name);
        await page.keyboard.press('Escape');
        const back = await page.evaluate(() => document.activeElement?.id);
        if (back !== 'nav-toggle') throw new Error(`Escape left focus on ${back || 'nothing'}, not the menu button`);
      });
    }

    // Not htmx, but states a page only reaches by submitting a form in the browser: refusals, whose error must sit
    // with its fields, and what an admin is shown once (a temporary password, an invitation link).
    const submitted = async (name, fn) => {
      await fn();
      await page.waitForLoadState('load');
      await page.addScriptTag({ content: AXE });
      await axe(page, name, variant.name);
    };
    await step('Edit → refused', async () => {
      // a book: a game or record has no reading dates on its form (they take plays)
      await open(page, `/items/${ids.book}/edit`);
      await submitted('Edit → refused, dates out of order', async () => {
        await page.locator('input[name="beganOn"]').fill('2024-05-02');
        await page.locator('input[name="completedOn"]').fill('2024-05-01');
        await page.getByRole('button', { name: 'Save changes' }).click();
        await page.locator('.error').waitFor({ timeout: 10_000 });
      });
    });
    await step('Account → refused', async () => {
      await open(page, '/account');
      await submitted('Account → refused, wrong password', async () => {
        await page.getByLabel('Current password').fill('not-the-password');
        await page.getByLabel(/^New password/).fill('another-password');
        await page.getByLabel('Confirm new password').fill('another-password');
        await page.getByRole('button', { name: 'Change password' }).click();
        await page.locator('.error').waitFor({ timeout: 10_000 });
      });
    });
    await step('Members → add a member', async () => {
      const username = `guest-${variant.scheme}-${variant.width}`;
      await open(page, '/settings/users');
      await submitted('Members → a new member\'s temporary password', async () => {
        await page.getByLabel('Username').fill(username);
        await page.getByRole('button', { name: 'Create account' }).click();
        await page.locator('article.notice code').waitFor({ timeout: 10_000 });
      });
      await submitted('Members → refused, username taken', async () => {
        await page.getByLabel('Username').fill(username);
        await page.getByRole('button', { name: 'Create account' }).click();
        await page.locator('.error').waitFor({ timeout: 10_000 });
      });
    });
    await step('Connections → invitation', async () => {
      await open(page, '/connections');
      await submitted('Connections → a new invitation link', async () => {
        await page.getByRole('button', { name: 'Create an invitation' }).click();
        await page.locator('article.notice').first().waitFor({ timeout: 10_000 });
      });
    });
  });
}

// ── Refresh from Discogs / Refresh from BGG, in place (ARCH.md §16 #55, #60) ─────────────────────────────────────
//
// The buttons render only with a provider token, and the main instance has none (its Add-page lookups would use
// one: a held non-ISBN barcode goes to Discogs). So they get an instance of their own, with a placeholder token
// and nothing on it but one record and one game, and nothing there reaches Discogs or BGG: the browser answers
// each refresh itself (page.route) — the handler's answer in its shape, a 500, a dropped connection — except the
// one that goes through to the Worker after the item's id was removed, which the handler answers without asking
// anyone ("nosource", "noid"). Checked each time: what the live region says while waiting and after, that the
// button is disabled while it waits and has focus again after (from the keyboard, and after a mouse double-click
// whose second click lands on the disabled button), and axe on the page after the swap.

const REFRESH_KINDS = [
  {
    name: 'Refresh from Discogs',
    what: 'discogs',
    button: '#discogs-refresh-button',
    status: 'discogs-status',
    target: '#pressing-body',
    busy: 'Asking Discogs…',
    details: { discogs_id: 1, label: 'Audit Records', catno: 'AUD 001' },
    fields: { mediaType: 'vinyl', title: 'The Refresh Record', creators: 'The Audit Band' },
    filled: 'Filled from Discogs: country, year, format, publisher, published.',
    // what the handler sends for a fill (test/refresh-in-place.spec.ts holds the real one to this shape)
    answer: (sentence) =>
      '<div id="pressing-body"><dl class="details-list"><dt>Label</dt><dd>Audit Records</dd><dt>Catalog #</dt><dd>AUD 001</dd>' +
      '<dt>Country</dt><dd>UK</dd><dt>Year</dt><dd>1971</dd><dt>Format</dt><dd>Vinyl, LP, Album</dd></dl></div>' +
      '<div id="pressing-more" hx-swap-oob="true"></div>' +
      '<div id="item-filled" class="props-group" hx-swap-oob="true"><dt>Published</dt><dd>1971</dd><dt>Publisher</dt><dd>Audit Records</dd></div>' +
      `<output id="discogs-status" hx-swap-oob="innerHTML">${sentence}</output>`,
    swapped: 'Vinyl, LP, Album',
    unfound: 'Nothing to look it up by: add its barcode, or its Discogs release id as discogs_id in details.',
  },
  {
    name: 'Refresh from BGG',
    what: 'bgg',
    button: '#bgg-refresh-button',
    status: 'bgg-status',
    target: '#game-details',
    busy: 'Asking BGG…',
    details: { bgg_id: 266192, players_min: 1 },
    fields: { mediaType: 'boardgame', title: 'The Refresh Game', creators: 'A. Designer' },
    filled: 'Filled from BoardGameGeek: max players, min playtime, max playtime, weight, length.',
    answer: (sentence) =>
      '<div id="game-details"><dl class="details-list"><dt>BGG ID</dt><dd>266192</dd><dt>Min players</dt><dd>1</dd>' +
      '<dt>Max players</dt><dd>5</dd><dt>Min playtime</dt><dd>40</dd><dt>Max playtime</dt><dd>70</dd><dt>Weight (1–5)</dt><dd>2.44</dd></dl></div>' +
      '<div id="item-filled" class="props-group" hx-swap-oob="true"><dt>Length</dt><dd class="mono">70 min play time</dd></div>' +
      `<output id="bgg-status" hx-swap-oob="innerHTML">${sentence}</output>`,
    swapped: '2.44',
    unfound: 'Nothing to look it up by: add its BoardGameGeek id as bgg_id in details.',
  },
];
const REFRESH_FAILED = 'Something went wrong — try again.';

async function refreshInPlace(variants) {
  console.log(`a11y: the Refresh buttons, on a scratch server of their own at ${REFRESH_BASE}`);
  await startServer({ port: REFRESH_PORT, dir: join(stateDir, 'refresh'), dummyTokens: true });
  const context = await browser.newContext();
  const form = (fields) => ({ form: fields, maxRedirects: 0 });
  await context.request.post(`${REFRESH_BASE}/setup`, form({ username: 'refresher', password: 'refresh-password', confirm: 'refresh-password' }));
  const made = await context.request.post(`${REFRESH_BASE}/libraries`, form({ name: 'Refresh' }));
  const shelf = made.headers().location?.match(/\/libraries\/(\d+)/)?.[1];
  if (!shelf) throw new Error('the Refresh instance: could not make a shelf (setup failed?)');
  const itemFields = (kind, details) => ({ libraryId: shelf, copies: '1', status: 'not_started', ...kind.fields, details: JSON.stringify(details) });
  for (const kind of REFRESH_KINDS) {
    const res = await context.request.post(`${REFRESH_BASE}/items`, form(itemFields(kind, kind.details)));
    kind.id = Number(res.headers().location?.match(/\/items\/(\d+)/)?.[1]);
    if (!kind.id) throw new Error(`the Refresh instance: adding "${kind.fields.title}" did not land on its page`);
  }

  for (const variant of variants) {
    await withVariant(context, variant, async (page) => {
      for (const kind of REFRESH_KINDS) {
        const where = (state) => `${kind.name} → ${state}`;
        const url = `**/items/${kind.id}/${kind.what}`;
        const button = page.locator(kind.button);
        const saying = (text, timeout = 10_000) =>
          page.waitForFunction(({ id, text }) => document.getElementById(id)?.textContent === text, { id: kind.status, text }, { timeout, polling: 25 });
        const focusBack = async (state) => {
          await page.waitForFunction((sel) => !document.querySelector(sel)?.disabled, kind.button, { timeout: 5000 });
          const at = await page.evaluate(() => {
            const a = document.activeElement;
            return a ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}` : 'nothing';
          });
          if (at !== `button${kind.button}`) failures.push(`keyboard · ${where(state)} [${variant.name}]: focus on ${at}, not back on the button`);
        };
        // answers the next refresh with `reply` once the returned function is called, so the wait can be checked
        const answerWith = async (reply) => {
          let open;
          const gate = new Promise((r) => (open = r));
          await page.unroute(url);
          await page.route(url, async (route) => {
            await gate;
            await reply(route);
          });
          return () => open();
        };
        const step = async (state, fn) => {
          try {
            await fn();
          } catch (err) {
            failures.push(`interaction · ${where(state)} [${variant.name}]: ${err.message.split('\n')[0]}`);
          }
        };

        await step('the page', async () => {
          await open(page, `/items/${kind.id}`, 200, REFRESH_BASE);
          await axe(page, `Item with ${kind.name}`, variant.name);
        });

        // from the keyboard: "Asking…" and a disabled button while it waits, then the answer, swapped in place
        await step('filled, from the keyboard', async () => {
          const go = await answerWith((route) => route.fulfill({ status: 200, contentType: 'text/html; charset=UTF-8', body: kind.answer(kind.filled) }));
          await button.focus();
          await page.keyboard.press('Enter');
          await saying(kind.busy);
          if (!(await button.isDisabled())) failures.push(`interaction · ${where('waiting')} [${variant.name}]: the button can be pressed again while it waits`);
          go();
          await saying(kind.filled);
          if (!(await page.locator(kind.target).innerText()).includes(kind.swapped)) throw new Error(`${kind.target} was not swapped`);
          await focusBack('filled, from the keyboard');
          await axe(page, where('filled, in place'), variant.name);
        });

        // a mouse double-click: the second click lands on the disabled button, and the browser moves focus to <main>
        await step('filled, after a double-click', async () => {
          const go = await answerWith((route) => route.fulfill({ status: 200, contentType: 'text/html; charset=UTF-8', body: kind.answer(kind.filled) }));
          await page.evaluate((id) => (document.getElementById(id).textContent = ''), kind.status);
          await button.dblclick();
          await saying(kind.busy);
          go();
          await saying(kind.filled);
          await focusBack('filled, after a double-click');
        });

        // no connection: nothing to swap, and a fixed sentence rather than "Asking…" left standing
        await step('no connection', async () => {
          const go = await answerWith((route) => route.abort('connectionreset'));
          await button.focus();
          await page.keyboard.press('Enter');
          await saying(kind.busy);
          go();
          await saying(REFRESH_FAILED);
          await focusBack('no connection');
          await axe(page, where('no connection'), variant.name);
        });

        // the Worker itself, after the id it looks up by was removed meanwhile: its own answer, without asking anyone
        await step('the Worker’s answer', async () => {
          await context.request.post(`${REFRESH_BASE}/items/${kind.id}`, form(itemFields(kind, {})));
          await page.unroute(url);
          await page.route(url, (route) => route.continue());
          await button.focus();
          await page.keyboard.press('Enter');
          await saying(kind.unfound);
          await focusBack('the Worker’s answer');
          await axe(page, where('nothing to look it up by, from the Worker'), variant.name);
          await context.request.post(`${REFRESH_BASE}/items/${kind.id}`, form(itemFields(kind, kind.details)));
        });

        // a server error: htmx swaps nothing on a 500, so the same fixed sentence
        await step('a server error', async () => {
          const go = await answerWith((route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'Something went wrong.' }));
          await button.focus();
          await page.keyboard.press('Enter');
          await saying(kind.busy);
          go();
          await saying(REFRESH_FAILED);
          await focusBack('a server error');
        });
        await page.unroute(url);
      }
    });
  }
  await context.close();
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const chosen = (name) => !ONLY || name.toLowerCase().includes(ONLY.toLowerCase());
  console.log(`a11y: starting a scratch server on ${BASE} (state in ${stateDir})`);
  await Promise.all([startServer(), startCoverServer()]);
  browser = await chromium.launch(process.env.A11Y_CHROMIUM ? { executablePath: process.env.A11Y_CHROMIUM } : {});

  // setup: only a fresh instance shows it, so before anything else
  const anon = await browser.newContext();
  for (const variant of VARIANTS) {
    if (!chosen('Setup')) break;
    await withVariant(anon, variant, async (page) => {
      await open(page, '/setup');
      await axe(page, 'Setup', variant.name);
      await keyboard(page, 'Setup', variant.name);
      await page.locator('input[name="password"]').fill('short');
      await page.locator('input[name="confirm"]').fill('short');
      await page.locator('input[name="username"]').fill('x');
      await page.locator('form').evaluate((f) => f.noValidate = true);
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.waitForLoadState('load');
      await page.addScriptTag({ content: AXE });
      await axe(page, 'Setup → refused', variant.name);
    });
  }

  console.log('a11y: seeding demo data');
  await run(process.execPath, [join(ROOT, 'scripts', 'seed-demo.mjs'), `--url=${BASE}`, '--no-covers']);

  // log in through the form, as a person would
  const admin = await browser.newContext();
  {
    const page = await admin.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Username').fill(USERNAME);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL(`${BASE}/`);
    await page.close();
  }
  const member = await browser.newContext();
  const ids = await furnish(admin, member);

  // the member signs in with the temporary password: the forced password change is a page of its own
  {
    const page = await member.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Username').fill('ravi');
    await page.getByLabel('Password').fill(ids.temp);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL(/\/account$/);
    await page.close();
  }

  const pages = pageList(ids);
  pages.push(...(await shareItemPages(admin, ids.shares)));

  // the member's forced password change, in every variant, then the change itself: after it, the app as a member
  // sees it (other people's reads without their forms, a shelf without the share panel)
  for (const variant of VARIANTS) {
    if (!chosen('member')) break;
    await withVariant(member, variant, async (page) => {
      await open(page, '/account');
      await axe(page, 'Member: must change password', variant.name);
    });
  }
  {
    const page = await member.newPage();
    await page.goto(`${BASE}/account`);
    await page.getByLabel('Current password').fill(ids.temp);
    await page.getByLabel(/^New password/).fill('member-password');
    await page.getByLabel('Confirm new password').fill('member-password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await page.waitForURL(`${BASE}/`);
    await page.close();
  }
  // the member wants a book too, so their list isn't empty when the admin looks at it
  await post(member, `/items/${ids.book}/want`, { want: '1' });
  const memberPages = [
    ['Member: overview', '/'],
    ['Member: item, book being read', `/items/${ids.reading}`],
    ['Member: item, book read twice', `/items/${ids.reread}`],
    ['Member: shelf', `/libraries/${ids.shelves.books}`],
    ['Member: search', '/search?q=le+guin'],
    ['Member: account', '/account'],
    ['Member: reading goals', '/goals'],
    ['Member: want list', '/wants'],
  ];

  for (const variant of VARIANTS) {
    console.log(`a11y: ${variant.name}`);
    await withVariant(anon, variant, async (page) => {
      if (chosen('Log in')) {
        await open(page, '/login');
        await axe(page, 'Log in', variant.name);
        await keyboard(page, 'Log in', variant.name);
        await page.getByLabel('Username').fill('nobody');
        await page.getByLabel('Password').fill('wrong-password');
        await page.getByRole('button', { name: 'Log in' }).click();
        await page.waitForLoadState('load');
        await page.addScriptTag({ content: AXE });
        await axe(page, 'Log in → wrong password', variant.name);
      }
      // the page the installed app shows when it can't reach the server
      if (chosen('Offline')) {
        try {
          await open(page, '/offline.html');
          await axe(page, 'Offline page (offline.html)', variant.name);
          if (variant.scheme === 'light') await keyboard(page, 'Offline page (offline.html)', variant.name);
        } catch (err) {
          failures.push(`unreachable · Offline page [${variant.name}]: ${err.message}`);
        }
      }
      // an invitation link opened in a browser: it only explains itself (connections are on and named here)
      if (chosen('Invitation')) {
        try {
          await open(page, '/connect');
          await axe(page, 'Invitation link (/connect)', variant.name);
          if (variant.scheme === 'light') await keyboard(page, 'Invitation link (/connect)', variant.name);
        } catch (err) {
          failures.push(`unreachable · Invitation link [${variant.name}]: ${err.message}`);
        }
      }
    });
    await withVariant(admin, variant, async (page) => {
      for (const [name, path, status] of pages) {
        if (!chosen(name)) continue;
        try {
          await open(page, path, status);
        } catch (err) {
          failures.push(`unreachable · ${name} [${variant.name}]: ${err.message}`);
          continue;
        }
        await axe(page, name, variant.name);
        // the keyboard walk once per width, in light: focus styles are the same tokens in both themes
        if (variant.scheme === 'light') await keyboard(page, name, variant.name);
        // What a closed <details> holds (shelf settings, a read's Edit form, the toolbar's filter menus) is hidden
        // from axe until it opens. Panels all open together; the toolbar menus drop down over each other, so
        // those open one at a time, as a person opens them.
        const shut = await page.evaluate(() => {
          const closed = [...document.querySelectorAll('details:not([open])')];
          closed.forEach((d, i) => d.setAttribute('data-a11y-shut', String(i)));
          const menus = closed.filter((d) => d.classList.contains('filter'));
          for (const d of closed) if (!menus.includes(d)) d.open = true;
          return { panels: closed.length - menus.length, menus: menus.map((d) => [d.dataset.a11yShut, d.querySelector('summary')?.textContent?.trim()]) };
        });
        if (shut.panels) {
          await axe(page, `${name} (closed sections opened)`, variant.name);
          // the forms they hold get the keyboard walk too
          if (variant.scheme === 'light') await keyboard(page, `${name} (closed sections opened)`, variant.name);
        }
        for (const [i, label] of shut.menus) {
          // Only this menu open, the page otherwise as it loaded. What the open menu covers can't be tapped
          // while it's open, but axe's target-size still counts it as a neighbour of the menu's checkboxes: set
          // those covered controls invisible for this one run (they were audited above, uncovered). "Covered"
          // means the browser says the menu is on top where they overlap, so a menu that slipped under the page
          // (a z-index slip) hides nothing, and the overlap is reported.
          // opened, then past its toggle event, which app.js answers by lining the menu up with the screen's edge
          await page.evaluate(
            (n) =>
              new Promise((resolve) => {
                const menu = document.querySelector(`details[data-a11y-shut="${n}"]`);
                if (menu.open) return resolve();
                menu.addEventListener('toggle', () => setTimeout(resolve), { once: true });
                for (const d of document.querySelectorAll('details[data-a11y-shut]')) d.open = d.dataset.a11yShut === n;
              }),
            i,
          );
          await page.evaluate((n) => {
            const menu = document.querySelector(`details[data-a11y-shut="${n}"] .filter-menu`);
            if (!menu) return;
            const m = menu.getBoundingClientRect();
            for (const el of document.querySelectorAll('a[href], button, input, select, textarea, summary')) {
              if (menu.contains(el) || el.closest('details.filter[open]')) continue;
              const r = el.getBoundingClientRect();
              if (!(r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top)) continue;
              // on top where the two overlap: the menu, or the page has put the menu underneath (reported, then)
              const x = (Math.max(r.left, m.left) + Math.min(r.right, m.right)) / 2;
              const y = (Math.max(r.top, m.top) + Math.min(r.bottom, m.bottom)) / 2;
              const top = document.elementFromPoint(x, y);
              if (top && menu.contains(top)) {
                el.style.visibility = 'hidden';
                el.setAttribute('data-a11y-covered', '');
              }
            }
          }, i);
          // Everything but target size, over the whole page; target size for the menu's own checkboxes only — the
          // page under a dropdown was measured above, and a card half under the menu measures as a smaller
          // neighbour than anyone can tap. (A header cell whose only control is set invisible reads as empty for
          // this run, too: it was audited above, uncovered.)
          await axe(page, `${name} (menu "${label}" open)`, variant.name, ['empty-table-header', 'target-size']);
          const menuTargets = await page.evaluate(
            (n) => window.axe.run({ include: [[`details[data-a11y-shut="${n}"] .filter-menu`]] }, { runOnly: { type: 'rule', values: ['target-size'] } }),
            i,
          );
          record(`${name} (menu "${label}" open, its checkboxes)`, variant.name, menuTargets);
          await page.evaluate(() => {
            for (const el of document.querySelectorAll('[data-a11y-covered]')) {
              el.style.visibility = '';
              el.removeAttribute('data-a11y-covered');
            }
          });
          // and the menu's checkboxes get the keyboard walk, once per width
          if (variant.scheme === 'light') await keyboard(page, `${name} (menu "${label}" open)`, variant.name);
        }
      }
    });
    await withVariant(member, variant, async (page) => {
      for (const [name, path] of memberPages) {
        if (!chosen(name)) continue;
        try {
          await open(page, path);
        } catch (err) {
          failures.push(`unreachable · ${name} [${variant.name}]: ${err.message}`);
          continue;
        }
        await axe(page, name, variant.name);
        if (variant.scheme === 'light') await keyboard(page, name, variant.name);
      }
    });
    // every step checks --only itself: --only=htmx runs them all, another word the steps whose name has it
    await interactions(admin, ids, variant);
  }
  if (chosen('Refresh')) {
    try {
      await refreshInPlace(VARIANTS);
    } catch (err) {
      failures.push(`interaction · the Refresh buttons: ${err.message.split('\n')[0]}`);
    }
  }

  // ── the report ──
  const lines = [];
  let nodes = 0;
  for (const [id, rule] of [...violations].sort()) {
    lines.push(`\n✖ ${id} (${rule.impact}) — ${rule.help}\n  ${rule.helpUrl}`);
    for (const [key, hit] of rule.hits) {
      nodes++;
      lines.push(`  • ${key}  [${[...hit.variants].join(', ')}]`);
      lines.push(`      ${hit.html.slice(0, 160)}`);
      if (hit.summary) lines.push(`      ${hit.summary.slice(0, 400)}`);
    }
  }
  const states = new Set(audited.map((a) => a.replace(/ \[.*\]$/, '')));
  console.log(`\na11y: ${audited.length} axe runs over ${states.size} pages and states (WCAG 2.0/2.1/2.2 A+AA; ${VARIANTS.map((v) => v.name).join(', ')}):`);
  for (const s of states) console.log(`  · ${s}`);
  if (unaudited.length) {
    console.log('\nNot audited (needs the internet):');
    for (const u of unaudited) console.log(`  – ${u}`);
    // on GitHub Actions, an annotation on the run, so a flaky lookup can't pass unnoticed
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=a11y::${unaudited.length} Add-page lookup states not audited: ${unaudited.join('; ')}`);
  }
  if (symbolsOnly) console.log(`\n(${symbolsOnly} contrast checks on symbol-only text — stars, media icons — which axe leaves to a person)`);
  if (needsReview.size) {
    console.log(`\nFor a person to check (${needsReview.size}): axe couldn't decide these itself`);
    for (const [key, variants] of needsReview) console.log(`  ? ${key}  [${[...variants].join(', ')}]`);
    // on GitHub Actions, the count on the run's summary, so a jump shows without opening the log; never a failure
    if (process.env.GITHUB_ACTIONS) console.log(`::notice title=a11y::${needsReview.size} contrast/target-size checks need a person (see the log)`);
  }
  // an audit that looked at nothing (an --only that matched no page) proves nothing
  if (!audited.length) failures.push('no page was audited');
  if (lines.length) console.log(`\n${violations.size} rules violated, ${nodes} distinct elements:${lines.join('\n')}`);
  if (failures.length) console.log(`\n${failures.length} other failures:\n${failures.map((f) => `  ✖ ${f}`).join('\n')}`);
  const lookupMissing = process.env.A11Y_REQUIRE_LOOKUP === '1' && unaudited.length > 0;
  const ok = !lines.length && !failures.length && !lookupMissing;
  console.log(ok ? '\na11y: no violations ✓' : '\na11y: FAILED');
  return ok;
}

// Ctrl-C (or a CI cancel) still stops the server and removes the scratch state
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup().finally(() => process.exit(130));
  });
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  console.error(`\na11y: the audit itself failed — ${err.stack ?? err}`);
} finally {
  if (KEEP && server) {
    console.log(`--keep: server still running on ${BASE} (state ${stateDir}); Ctrl-C to stop`);
    await new Promise(() => {});
  }
  await cleanup();
}
process.exit(ok ? 0 : 1);
