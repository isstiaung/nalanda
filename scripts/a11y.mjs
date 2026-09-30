// The runtime half of the accessibility audit (ARCH.md §18, §16 #50): axe-core in a real browser, on every page
// of a freshly seeded instance, in both themes, at desktop and phone widths — plus the htmx swaps and a keyboard
// walk. The static half is `npm run lint` (eslint-plugin-jsx-a11y).
//
//   npm run a11y                  # the whole audit; exits 1 on any violation
//   npm run a11y -- --only=shelf  # just the pages whose name contains "shelf"
//   npm run a11y -- --keep        # leave the server running afterwards, to look around
//
// It never touches your development database or port: it starts its own `wrangler dev` on 127.0.0.1:8817 with
// its own --persist-to state in a temporary directory, removed afterwards. Everything it needs comes from here:
// a throwaway session secret and connections key, seed data from scripts/seed-demo.mjs (offline, --no-covers),
// and cover images from a tiny server on :8818 that the Worker fetches like any cover URL. The one step that
// needs the internet is looking up a book on the Add page (Open Library): when that finds nothing, the report
// says which states went unaudited, and A11Y_REQUIRE_LOOKUP=1 turns that into a failure.
//
// A11Y_CHROMIUM=/path/to/chrome uses an installed Chromium-family browser instead of Playwright's
// (`npx playwright install chromium`).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const KEEP = process.argv.includes('--keep');
const USERNAME = 'librarian'; // seed-demo.mjs's admin
const PASSWORD = 'demo-password';

// WCAG 2.0, 2.1 and 2.2, levels A and AA — the bar (ARCH.md §18) — plus the few best-practice rules that check
// structure a screen-reader user navigates by: one main landmark, content inside landmarks, one h1, headings that
// don't skip levels, and a skip link that goes somewhere.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const BEST_PRACTICE = ['heading-order', 'page-has-heading-one', 'landmark-one-main', 'region', 'skip-link', 'empty-heading', 'empty-table-header', 'landmark-unique'];

const VARIANTS = [
  { name: 'light 1280', scheme: 'light', width: 1280, height: 900 },
  { name: 'dark 1280', scheme: 'dark', width: 1280, height: 900 },
  { name: 'light 390', scheme: 'light', width: 390, height: 844 },
  { name: 'dark 390', scheme: 'dark', width: 390, height: 844 },
];

// ── report ────────────────────────────────────────────────────────────────────────────────────────────────────

const violations = new Map(); // rule id → { impact, help, helpUrl, hits: Map<"page · target", {summary, variants:Set}> }
const failures = []; // keyboard, reachability, scripting problems: plain lines
const audited = []; // "page [variant]"
const unaudited = []; // states the audit couldn't reach, with why

function record(where, variant, results) {
  audited.push(`${where} [${variant}]`);
  for (const v of results.violations) {
    const rule = violations.get(v.id) ?? { impact: v.impact, help: v.help, helpUrl: v.helpUrl, hits: new Map() };
    violations.set(v.id, rule);
    for (const node of v.nodes) {
      const key = `${where} · ${node.target.join(' ')}`;
      const hit = rule.hits.get(key) ?? { summary: node.failureSummary?.split('\n').slice(1).join(' ').trim() ?? '', html: node.html, variants: new Set() };
      hit.variants.add(variant);
      rule.hits.set(key, hit);
    }
  }
}

async function axe(page, where, variant) {
  const results = await page.evaluate(
    async ({ tags, extra }) => {
      return window.axe.run(document, {
        runOnly: { type: 'tag', values: tags },
        rules: Object.fromEntries(extra.map((id) => [id, { enabled: true }])),
        resultTypes: ['violations'],
      });
    },
    { tags: WCAG_TAGS, extra: BEST_PRACTICE },
  );
  // runOnly by tag leaves the best-practice rules out; run them on their own and merge
  const extra = await page.evaluate(
    (ids) => window.axe.run(document, { runOnly: { type: 'rule', values: ids }, resultTypes: ['violations'] }),
    BEST_PRACTICE,
  );
  record(where, variant, { violations: [...results.violations, ...extra.violations] });
}

// ── the throwaway instance ────────────────────────────────────────────────────────────────────────────────────

const WRANGLER = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const stateDir = mkdtempSync(join(tmpdir(), 'nalanda-a11y-'));
let server = null;
let coverServer = null;
let browser = null;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' }, ...opts });
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

async function startServer() {
  await run(WRANGLER, ['d1', 'migrations', 'apply', 'nalanda', '--local', '--persist-to', stateDir]);
  const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  let log = '';
  server = spawn(
    WRANGLER,
    [
      'dev',
      '--ip', '127.0.0.1',
      '--port', String(PORT),
      '--inspector-port', String(INSPECTOR_PORT),
      '--persist-to', stateDir,
      '--show-interactive-dev-session=false',
      '--var', `SESSION_SECRET:${secret}`,
      // connections switched on, so Feed, Notifications, Borrowed and Connections render (without a peer)
      '--var', `FEDERATION_PRIVATE_KEY:${await federationKey()}`,
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, CI: '1' } },
  );
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`wrangler dev exited ${server.exitCode}\n${log}`);
    try {
      const res = await fetch(`${BASE}/setup`, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not answer on ${BASE} within 2 minutes\n${log}`);
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
  return new Promise((resolve) => coverServer.listen(COVER_PORT, '127.0.0.1', resolve));
}

async function cleanup() {
  await browser?.close().catch(() => {});
  coverServer?.close();
  if (server && server.exitCode === null) {
    try {
      if (process.platform === 'win32') server.kill();
      else process.kill(-server.pid, 'SIGTERM'); // wrangler's workerd children too
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  rmSync(stateDir, { recursive: true, force: true });
}

// ── driving the app ───────────────────────────────────────────────────────────────────────────────────────────

/** A form POST through the browser context's cookie jar; returns the response (redirects not followed). */
async function post(context, path, form) {
  const res = await context.request.post(`${BASE}${path}`, { form, maxRedirects: 0 });
  if (res.status() >= 400) throw new Error(`POST ${path} → ${res.status()}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function html(context, path) {
  return (await context.request.get(`${BASE}${path}`)).text();
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

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
  const book = await addWithCover({ libraryId: String(shelves.books), mediaType: 'book', title: 'The Audit Book', creators: 'A. Writer', status: 'completed', completedOn: daysAgo(30), length: '320', isbn13: '9780000000002' }, 1);
  const game = await addWithCover({ libraryId: String(shelves.games), mediaType: 'boardgame', title: 'The Audit Game', status: 'completed', details: '{"bgg_id":266192,"players_min":1,"players_max":5}' }, 2);
  const record = await addWithCover({ libraryId: String(shelves.vinyl), mediaType: 'vinyl', title: 'The Audit Record', status: 'completed' }, 3);

  const reading = await find('The Dispossessed'); // seeded "in progress", 387 pages
  const reread = await find('The Left Hand of Darkness'); // seeded completed
  const overdue = await find('Azul');

  // reading: a page recorded, a second finish (so "Read 2 times" and ×2 show), a loan past its due date
  await post(admin, `/items/${reading}/progress`, { page: '120' });
  await post(admin, `/items/${reread}/reads`, { status: 'completed', beganOn: '2019-01-02', endedOn: '2019-02-03' });
  await post(admin, `/items/${overdue}/loan`, { borrower: 'Meera', contact: '', dueOn: daysAgo(3) });

  // a second member — the reading and review sections then name people
  const minted = await (await post(admin, '/settings/users', { username: 'ravi', role: 'member' })).text();
  const temp = minted.match(/<code>([^<]+)<\/code>/)?.[1];
  if (!temp) throw new Error('No temporary password shown for the new member');
  const people = await html(admin, '/settings/users');
  const raviId = Number(people.match(/action="\/settings\/users\/(\d+)\/display-name"[\s\S]*?Display name for ravi/)?.[1]);
  const adminId = Number(people.match(/action="\/settings\/users\/(\d+)\/display-name"[\s\S]*?Display name for librarian/)?.[1]);
  await post(admin, `/settings/users/${adminId}/display-name`, { displayName: 'Lakshmi' });
  if (raviId) await post(admin, `/settings/users/${raviId}/display-name`, { displayName: 'Ravi' });

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

  const shares = [...(await html(admin, '/shares')).matchAll(/\/share\/([A-Za-z0-9_-]{16,})/g)].map((m) => m[1]);
  return { shelves, book, game, record, reading, reread, overdue, temp, shares: [...new Set(shares)], member };
}

// ── pages ─────────────────────────────────────────────────────────────────────────────────────────────────────

function pageList(ids) {
  const s = ids.shelves;
  const [shareA, shareB, shareC, shareD, shareE] = ids.shares;
  const list = [
    ['Overview', '/'],
    ['Shelf: books, table', `/libraries/${s.books}`],
    ['Shelf: books, covers', `/libraries/${s.books}?view=grid`],
    ['Shelf: games, table', `/libraries/${s.games}`],
    ['Shelf: vinyl, covers', `/libraries/${s.vinyl}?view=grid`],
    ['Shelf: filtered, nothing matches', `/libraries/${s.vinyl}?type=book`],
    ['Item: book, being read', `/items/${ids.reading}`],
    ['Item: book, read twice', `/items/${ids.reread}`],
    ['Item: book with cover', `/items/${ids.book}`],
    ['Item: board game (BGG)', `/items/${ids.game}`],
    ['Item: vinyl', `/items/${ids.record}`],
    ['Item: lent, overdue', `/items/${ids.overdue}`],
    ['Edit: book', `/items/${ids.reading}/edit`],
    ['Edit: board game', `/items/${ids.game}/edit`],
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
  for (const [i, token] of [shareA, shareB, shareC, shareD, shareE].entries()) {
    if (token) list.push([`Share ${i + 1}: list`, `/share/${token}`]);
  }
  list.push(['Share: not found', '/share/not-a-real-token', 404]);
  return list;
}

/** The share item pages: every item linked from each share list, one per media type, plus a book with progress. */
async function shareItemPages(context, tokens) {
  const out = [];
  const seen = new Set();
  for (const token of tokens) {
    const list = await html(context, `/share/${token}`);
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

async function open(page, path, expected = 200) {
  const res = await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
  const status = res?.status() ?? 0;
  const landed = new URL(page.url()).pathname;
  const wanted = new URL(`${BASE}${path}`).pathname;
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
      const s = getComputedStyle(el);
      const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
      const shadow = s.boxShadow && s.boxShadow !== 'none';
      // a date input's calendar button: focus sits inside the browser's own control, which draws its own ring
      const native = el.matches(':focus-within') && !el.matches(':focus');
      const r = el.getBoundingClientRect();
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ');
      return {
        id: el.getAttribute('data-a11y-k'),
        label: `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? ` class="${el.className.trim()}"` : ''}> "${name.slice(0, 40)}"`,
        inMain: !!el.closest('main'),
        skip: el.classList.contains('skip-link'),
        visible: outline || shadow || native,
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
  if (!first) return fail('the first Tab focused nothing');
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
  const total = await page.evaluate(
    () =>
      [...document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]')].filter(
        (el) => !el.disabled && el.getAttribute('tabindex') !== '-1' && el.type !== 'hidden' && el.checkVisibility?.({ visibilityProperty: true }) !== false,
      ).length,
  );
  const limit = total * 4 + 25;
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
  if (mainHasStops && !reachedMain) fail('Tab never reached anything in <main>');
  if (!wrapped) {
    const tail = seen.slice(-6).map((s) => s.label).join(' → ');
    fail(`Tab never came back round after ${limit} presses — focus is trapped (last stops: ${tail})`);
  }
}

// ── htmx interactions (the ones on main: the Add page's lookups, the reading section, the Holding toggle) ──────

async function interactions(context, ids, variant) {
  const where = (s) => `htmx: ${s}`;
  // each step on its own: one that can't be done is a failure in the report, and the rest still run
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      failures.push(`htmx · ${name} [${variant.name}]: ${err.message.split('\n')[0]}`);
    }
  };
  await withVariant(context, variant, async (page) => {
    // Add → Scan: typing a barcode, the path that needs no camera
    await step('Add → typed barcode', async () => {
      await open(page, '/add');
      const barcode = page.getByLabel(/barcode/i);
      await barcode.fill('12345', { timeout: 5000 });
      await barcode.press('Enter');
      await page.locator('#scan-results .notice').waitFor({ timeout: 10_000 });
      await axe(page, where('Add → typed barcode, not valid'), variant.name);

      await barcode.fill('9780441478125');
      await barcode.press('Enter');
      const card = page.locator('#scan-results .candidate');
      await card.first().waitFor({ timeout: 20_000 }).catch(() => {});
      if (await card.count()) await axe(page, where('Add → typed ISBN, a book found'), variant.name);
      else unaudited.push(`Add → typed ISBN → candidate card [${variant.name}]: the lookup found nothing (offline?)`);
    });

    await step('Add → Search', async () => {
      await open(page, '/add');
      await page.getByRole('button', { name: /search/i }).first().click();
      const q = page.locator('#tab-search input[name="q"]');
      await q.fill('Piranesi');
      await q.press('Enter');
      await page.locator('#search-results .candidate, #search-results .notice').first().waitFor({ timeout: 20_000 }).catch(() => {});
      if (await page.locator('#search-results .candidate').count()) await axe(page, where('Add → search results'), variant.name);
      else unaudited.push(`Add → Search → results [${variant.name}]: the search found nothing (offline?)`);
      await page.getByRole('button', { name: /manual/i }).click();
      await axe(page, where('Add → Manual tab'), variant.name);
    });

    // the reading section: every form in it swaps the section
    const reading = page.locator('#reading');
    const swapped = async (fn) => {
      const before = await reading.innerHTML();
      await fn();
      await page.waitForFunction((b) => document.querySelector('#reading')?.innerHTML !== b, before, { timeout: 10_000 });
    };
    await step('Reading', async () => {
      await open(page, `/items/${ids.reading}`);
      await swapped(async () => {
        await reading.getByLabel('Page reached').fill('999999');
        await reading.getByRole('button', { name: 'Record' }).click();
      });
      await axe(page, where('Reading → Record, refused'), variant.name);
      await swapped(async () => {
        await reading.getByLabel('Page reached').fill('150');
        await reading.getByRole('button', { name: 'Record' }).click();
      });
      await axe(page, where('Reading → Record a page'), variant.name);
      await reading.locator('summary', { hasText: 'Add a past read' }).click();
      await swapped(async () => {
        const form = reading.locator('details.read-add form');
        await form.getByLabel('Began').fill('2015-05-01');
        await form.getByLabel('Ended').fill('2015-06-01');
        await form.getByRole('button', { name: 'Add' }).click();
      });
      await axe(page, where('Reading → Add a past read'), variant.name);
      await reading.locator('.read-history summary', { hasText: 'Edit' }).first().click();
      await axe(page, where('Reading → a read opened for editing'), variant.name);
      await swapped(() => reading.locator('.read-history details[open] form').first().getByRole('button', { name: 'Save' }).click());
      await axe(page, where('Reading → Save a read'), variant.name);
      await swapped(() => reading.getByRole('button', { name: 'Finish' }).click());
      await axe(page, where('Reading → Finish'), variant.name);
      await swapped(() => reading.getByRole('button', { name: /Read again/ }).click());
      await axe(page, where('Reading → Read again'), variant.name);
      await swapped(() => reading.getByRole('button', { name: /Stop/ }).click());
      await axe(page, where('Reading → Stop'), variant.name);
      // open again, as it was, for the next variant
      await swapped(() => reading.getByRole('button', { name: /Read again|Start again/ }).click());
    });

    // the Holding toggle, on a shelf's table
    await step('Shelf → Holding toggle', async () => {
      await open(page, `/libraries/${ids.shelves.books}`);
      const toggle = page.locator(`button[hx-post="/items/${ids.book}/mark-not-owned"]`);
      await toggle.click();
      const back = page.locator(`button[hx-post="/items/${ids.book}/mark-owned"]`);
      await back.waitFor({ timeout: 10_000 });
      await axe(page, where('Shelf → Holding toggled to Not owned'), variant.name);
      await back.click();
      await toggle.waitFor({ timeout: 10_000 });
      await axe(page, where('Shelf → Holding toggled back to Owned'), variant.name);
    });

    // not htmx, but states a page only reaches by a refused submit: the error must sit with its fields
    await step('Edit → refused', async () => {
      await open(page, `/items/${ids.game}/edit`);
      await page.getByLabel('Began').fill('2024-05-02');
      await page.getByLabel('Completed').fill('2024-05-01');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await page.locator('.error').waitFor({ timeout: 10_000 });
      await page.addScriptTag({ content: AXE });
      await axe(page, 'Edit → refused, dates out of order', variant.name);
    });
    await step('Account → refused', async () => {
      await open(page, '/account');
      await page.getByLabel('Current password').fill('not-the-password');
      await page.getByLabel(/^New password/).fill('another-password');
      await page.getByLabel('Confirm new password').fill('another-password');
      await page.getByRole('button', { name: 'Change password' }).click();
      await page.locator('.error').waitFor({ timeout: 10_000 });
      await page.addScriptTag({ content: AXE });
      await axe(page, 'Account → refused, wrong password', variant.name);
    });
  });
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
  const memberPages = [
    ['Account: must change password (member)', '/account'],
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
      }
    });
    await withVariant(member, variant, async (page) => {
      for (const [name, path] of memberPages) {
        if (!chosen(name)) continue;
        await open(page, path);
        await axe(page, name, variant.name);
      }
    });
    if (chosen('htmx')) await interactions(admin, ids, variant);
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
      if (hit.summary) lines.push(`      ${hit.summary.slice(0, 240)}`);
    }
  }
  const states = new Set(audited.map((a) => a.replace(/ \[.*\]$/, '')));
  console.log(`\na11y: ${audited.length} axe runs over ${states.size} pages and states (WCAG 2.0/2.1/2.2 A+AA, light and dark, 1280 and 390 wide)`);
  if (unaudited.length) {
    console.log('\nNot audited (needs the internet):');
    for (const u of unaudited) console.log(`  – ${u}`);
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
