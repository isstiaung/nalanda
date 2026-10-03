// The static demo (ARCH.md §16 #89): `npm run demo:build` starts a scratch `wrangler dev` on its own port and state
// (as the accessibility audit does), seeds it with the demo collection (scripts/seed-demo.mjs), signs in, crawls every
// page a signed-in member can reach, and writes them as static HTML into demo/ — links pointed at the files, every
// form intercepted by demo.js ("read-only demo"), a handful of canned searches pre-built, no service worker, a
// banner — behind a skeletal login page that accepts demo / demo in the browser. The workflow in
// .github/workflows/demo.yml publishes demo/ to GitHub Pages on each release.
//
//   npm run demo:build                      # → demo/, for http://localhost:8000/ (npx serve demo)
//   npm run demo:build -- --base=/nalanda   # for a project site at https://<owner>.github.io/nalanda/
//   npm run demo:build -- --origin=https://nalanda-demo.example  # where the site is served: full addresses (a
//                                           # share's, its QR code's, a feed's) are written for it
//   npm run demo:build -- --no-covers       # offline: no cover fetches from the providers
//
// Everything is local: wrangler runs --local with a temporary --persist-to, never --remote, and this process's
// Cloudflare credentials are dropped from the child's environment, as the audit drops them.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressesIn, bannerHtml, CANNED_SEARCHES, crawlable, DEMO_PASSWORD, DEMO_USER, fileFor, fullAddressesIn, hrefFor, inject, isAsset, LOGIN_NOTE, rewriteFullAddresses, rewriteLinks } from './demo-static.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'demo');
const PORT = Number(process.env.DEMO_PORT ?? 8818);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const base = (process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? '').replace(/\/$/, '');
// the site's own origin, for the addresses the app writes in full: nothing for a local build, whose pages then link
// by path alone
const origin = (process.argv.find((a) => a.startsWith('--origin='))?.slice(9) ?? '').replace(/\/$/, '');
const covers = !process.argv.includes('--no-covers');
const MAX_PAGES = 600;
const WRANGLER = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const stateDir = mkdtempSync(join(tmpdir(), 'nalanda-demo-'));

const LOCAL_ENV = {
  ...process.env,
  CI: '1',
  WRANGLER_SEND_METRICS: 'false',
  XDG_CONFIG_HOME: join(stateDir, 'xdg'),
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'true',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
};
for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'D1_DATABASE_ID']) {
  delete LOCAL_ENV[key];
}
mkdirSync(LOCAL_ENV.XDG_CONFIG_HOME, { recursive: true });

let server = null;
const log = (msg) => console.log(`demo: ${msg}`);

function run(cmd, args, env = LOCAL_ENV) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out}`))));
  });
}

/** The scratch server's session secret: /setup asks for it (§16 #101), and the seed types it. */
let secret = '';

async function startServer() {
  await run(WRANGLER, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir]); // the binding, whatever the database is called
  secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const envFile = join(stateDir, 'demo.env');
  // no provider tokens: the seed's vinyl and game covers stay empty, and nothing here could reach BGG or Discogs
  writeFileSync(envFile, [`SESSION_SECRET=${secret}`, 'DISCOGS_TOKEN=', 'BGG_TOKEN=', 'GOOGLE_BOOKS_KEY=', 'HOME_SHARE_TOKEN=', 'FEDERATION_PRIVATE_KEY='].join('\n') + '\n');
  let output = '';
  server = spawn(
    WRANGLER,
    ['dev', '--local', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-port', String(PORT + 1000), '--persist-to', stateDir, '--show-interactive-dev-session=false', '--env-file', envFile],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: LOCAL_ENV },
  );
  server.stdout.on('data', (d) => (output += d));
  server.stderr.on('data', (d) => (output += d));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`wrangler dev exited ${server.exitCode}\n${output}`);
    try {
      const res = await fetch(`${BASE_URL}/setup`, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not answer on ${BASE_URL} within 2 minutes\n${output}`);
}

async function cleanup() {
  if (server && server.exitCode === null) {
    try {
      if (process.platform === 'win32') server.kill();
      else process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  rmSync(stateDir, { recursive: true, force: true });
}

/** Signs in as the seed's librarian; the cookie the crawl carries. */
async function signIn() {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE_URL },
    body: new URLSearchParams({ username: 'librarian', password: 'demo-password' }),
    redirect: 'manual',
  });
  // the session cookie among whatever else the response sets (getSetCookie keeps them apart; get() would join them)
  const cookie = (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).find((c) => c.startsWith('nalanda_session='));
  if (!cookie) throw new Error(`sign-in failed (${res.status}; location ${res.headers.get('location')})`);
  return cookie;
}

/** The demo's own script: the login check, the gate, the intercepted forms, the canned searches, the toast. */
function demoJs() {
  return `// The static demo (ARCH.md §16 #89): nothing here is kept. Forms are intercepted, a GET form lands on a pre-built
// page when there is one, the sign-in is a check in this browser alone.
(function () {
  var D = window.NALANDA_DEMO || { base: '', pages: {} };
  var base = D.base || '';
  var here = location.pathname.replace(/\\/index\\.html$/, '/');
  var atLogin = here === base + '/' || here === base + '/index.html';
  var signedIn = false;
  try { signedIn = sessionStorage.getItem('nalanda-demo') === '1'; } catch (e) {}
  if (!atLogin && !signedIn) { location.replace(base + '/'); return; }
  function toast(text) {
    var el = document.getElementById('demo-toast');
    if (!el) { el = document.createElement('div'); el.id = 'demo-toast'; el.className = 'demo-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = text; el.classList.add('shown');
    clearTimeout(el._t); el._t = setTimeout(function () { el.classList.remove('shown'); }, 3500);
  }
  function fileFor(path, query) {
    var dir = path === '/' ? 'home' : path.replace(/^\\/|\\/$/g, '');
    var plain = query; try { plain = decodeURIComponent(query); } catch (e) {}
    return query ? dir + '/q/' + plain.replace(/[^A-Za-z0-9=&+._-]+/g, '_') + '.html' : dir + '/index.html';
  }
  document.addEventListener('submit', function (e) {
    var form = e.target; if (!(form instanceof HTMLFormElement)) return;
    e.preventDefault();
    if (atLogin && form.querySelector('input[name="password"]')) {
      var u = (form.username && form.username.value || '').trim(), p = form.password && form.password.value || '';
      if (u === ${JSON.stringify(DEMO_USER)} && p === ${JSON.stringify(DEMO_PASSWORD)}) {
        try { sessionStorage.setItem('nalanda-demo', '1'); } catch (err) {}
        location.href = base + '/home/'; return;
      }
      var old = form.parentElement.querySelector('.error'); if (old) old.remove();
      var msg = document.createElement('p'); msg.className = 'error'; msg.setAttribute('role', 'alert');
      msg.textContent = 'Wrong username or password.'; form.insertAdjacentElement('beforebegin', msg); return;
    }
    if ((form.method || 'get').toLowerCase() !== 'get') { toast('Read-only demo — nothing is saved.'); return; }
    var action = form.getAttribute('action') || here;
    var path = action.indexOf(base) === 0 ? action.slice(base.length) : action;
    path = path.replace(/\\/$/, '') || '/';
    var query = new URLSearchParams(new FormData(form)).toString();
    var file = fileFor(path, query);
    if (D.pages[file]) { location.href = base + '/' + file; return; }
    if (path === '/search') { toast('The demo answers these searches: ' + ${JSON.stringify(CANNED_SEARCHES.join(' · '))} + '.'); return; }
    toast('That combination of filters isn\\u2019t pre-built in the demo.');
  }, true);
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[hx-post], button[hx-get], a[hx-get]') : null;
    if (b) { e.preventDefault(); toast('Read-only demo — nothing is saved.'); }
  }, true);
})();
`;
}

const DEMO_CSS = `/* The static demo (ARCH.md §16 #89): the banner and the toast, in the ledger's own tokens. */
.demo-banner { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; align-items: center; padding: 0.45rem 1rem; font-size: 13px; background: var(--stamp); color: var(--surface); }
.demo-banner a { color: inherit; text-decoration: underline; }
.demo-toast { position: fixed; left: 50%; bottom: 1.5rem; transform: translate(-50%, 1rem); padding: 0.6rem 1rem; border-radius: var(--radius, 6px); background: var(--ink); color: var(--paper); font-size: 13.5px; opacity: 0; pointer-events: none; transition: opacity 150ms ease, transform 150ms ease; z-index: 50; max-width: 90vw; }
.demo-toast.shown { opacity: 1; transform: translate(-50%, 0); }
.demo-note { margin-top: 1rem; font-size: 13px; }
`;

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  log(`starting a scratch server on ${BASE_URL} (state in ${stateDir})`);
  await startServer();
  log(`seeding the demo collection${covers ? '' : ' (no covers)'}`);
  await run(process.execPath, [join(ROOT, 'scripts', 'seed-demo.mjs'), `--url=${BASE_URL}`, ...(covers ? [] : ['--no-covers'])], { ...LOCAL_ENV, SESSION_SECRET: secret });
  const cookie = await signIn();

  // the login page as the app renders it, with the demo's note and a form the demo's script answers
  const loginHtml = await (await fetch(`${BASE_URL}/login`)).text();
  const loginPage = rewriteFullAddresses(inject(rewriteLinks(loginHtml, base), { base, banner: bannerHtml(base) }), BASE_URL, origin, base).replace(
    /(<form[^>]*>[\s\S]*?<\/form>)/,
    `$1<p class="muted demo-note">${LOGIN_NOTE}</p>`,
  );
  writeFileSync(join(OUT, 'index.html'), loginPage);

  const queue = ['/', ...CANNED_SEARCHES.map((q) => `/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}`)];
  const seen = new Set(queue);
  const pages = {};
  let count = 0;
  /** Queues what a page or feed refers to, by path or in full on the scratch server, that the crawl hasn't seen. */
  const follow = (text, byPath) => {
    for (const next of [...byPath, ...fullAddressesIn(text, BASE_URL)]) {
      if (!seen.has(next) && crawlable(next) && (isAsset(next.split('?')[0]) || count + queue.length < MAX_PAGES)) {
        seen.add(next);
        queue.push(next);
      }
    }
  };
  while (queue.length) {
    const address = queue.shift();
    const res = await fetch(`${BASE_URL}${address}`, { headers: { cookie }, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      // a redirect inside the app: follow it as a link, once
      const to = res.headers.get('location') ?? '';
      const path = to.startsWith('/') ? to : to.startsWith(BASE_URL) ? to.slice(BASE_URL.length) : '';
      if (path && crawlable(path) && !seen.has(path)) {
        seen.add(path);
        queue.push(path);
      }
      continue;
    }
    if (res.status !== 200) continue;
    const type = res.headers.get('content-type') ?? '';
    const file = fileFor(address);
    const target = join(OUT, file);
    mkdirSync(dirname(target), { recursive: true });
    if (type.startsWith('text/html')) {
      const html = await res.text();
      follow(html, addressesIn(html));
      // paths first, then the addresses the app wrote in full — a share's, its QR code's, a link preview's — pointed
      // at the demo's own copies on the site's origin
      writeFileSync(target, rewriteFullAddresses(inject(rewriteLinks(html, base), { base, banner: bannerHtml(base) }), BASE_URL, origin, base));
      pages[file] = 1;
      count++;
    } else if (/(atom|rss)\+xml|\/xml/.test(type)) {
      // a share's feed: its entries name item pages in full
      const xml = await res.text();
      follow(xml, []);
      writeFileSync(target, rewriteFullAddresses(xml, BASE_URL, origin, base));
    } else if (type.startsWith('text/css')) {
      // the stylesheet's own references (fonts) under the base too
      writeFileSync(target, (await res.text()).replace(/url\((['"]?)\//g, `url($1${base}/`));
    } else {
      writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    }
  }
  writeFileSync(join(OUT, 'demo.js'), demoJs());
  writeFileSync(join(OUT, 'demo.css'), DEMO_CSS);
  writeFileSync(join(OUT, 'demo-pages.js'), `window.NALANDA_DEMO=${JSON.stringify({ base, pages })};\n`);
  writeFileSync(join(OUT, '.nojekyll'), '');
  writeFileSync(join(OUT, '404.html'), `<!doctype html><meta charset="utf-8"><title>Not in the demo</title><meta http-equiv="refresh" content="0; url=${base}/"><p>That page isn't part of the demo. <a href="${base}/">Back to the demo</a>.</p>`);
  log(`wrote ${count} pages, ${seen.size} addresses in all, into demo/ (base ${base || '/'})`);
  log(`try it: npx serve demo${base ? ` — pages expect to be served under ${base}` : ''}; sign in with ${DEMO_USER} / ${DEMO_PASSWORD}`);
}

main()
  .then(cleanup, async (err) => {
    await cleanup();
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
