// The static demo's pure parts (ARCH.md §16 #89): where a crawled address lands as a file, how a page's links are
// pointed at those files, what is injected and what is cut. No I/O here — scripts/demo-build.mjs does the crawl and
// the writing; test/demo-static.spec.ts holds these functions to their answers. Plain ES module, no Node imports, so
// the test runner (workerd) can load it as it loads the app.

/** What the skeletal login page accepts. Not security: the demo is public and read-only, and says so. */
export const DEMO_USER = 'demo';
export const DEMO_PASSWORD = 'demo';

/** Addresses the crawl never follows: nothing that writes, signs out, pages the export, or belongs to the installed app. */
const SKIP = [
  /^\/auth\//,
  /^\/login(\?|$)/,
  /^\/setup(\?|$)/,
  /^\/export\.csv/,
  /^\/api\//,
  /^\/federation\//,
  /^\/sw\.js$/,
  /^\/manifest\.webmanifest$/,
  /^\/offline\.html$/,
  /^\/account\/tokens/,
  /[?&]after=/,
  /[?&]page=\d/, // one page of a long shelf is enough for a demo
  /^\/covers\/[^/]+\/delete/,
];

export function crawlable(pathWithQuery) {
  if (!pathWithQuery.startsWith('/') || pathWithQuery.startsWith('//')) return false;
  if (pathWithQuery.includes('#')) return false;
  return !SKIP.some((re) => re.test(pathWithQuery));
}

/**
 * A query string as part of a file name: percent-encoding undone first (so a search typed into the box and the same
 * search in a crawled link land on one file), then only letters, digits, `=`, `&`, `+`, `.`, `_` and `-` survive.
 */
export function safeQuery(query) {
  let plain = query;
  try {
    plain = decodeURIComponent(query);
  } catch {
    /* not our encoding: as written */
  }
  return plain.replace(/[^A-Za-z0-9=&+._-]+/g, '_');
}

/** Whether an address is a file the app serves as it is (a stylesheet, a script, a cover, a font, a feed) rather than a page. */
export function isAsset(path) {
  return /^\/(app\.css|app\.js|covers\.js|qr\.js|scan-queue\.js|scan-review\.js|scanner\.js|import\.js|kindle\.js|logo\.svg|vendor\/|icons\/|bgg\/|fonts\/|covers\/)/.test(path) || /\.(atom|rss|png|jpg|jpeg|webp|gif|svg|woff2?|css|js|wasm|json|xml)$/.test(path);
}

/**
 * The file a crawled address is written to, under the output directory. The app's home (`/`) is `home/index.html`
 * — the site's own root is the login page. A page is `<path>/index.html`; with a query, `<path>/q/<query>.html`,
 * so one shelf's filtered views sit beside it. A file the app serves as it is keeps its path.
 */
export function fileFor(pathWithQuery) {
  const [path, query = ''] = pathWithQuery.split('?');
  if (isAsset(path)) return path.slice(1);
  const dir = path === '/' ? 'home' : path.replace(/^\/|\/$/g, '');
  return query ? `${dir}/q/${safeQuery(query)}.html` : `${dir}/index.html`;
}

/** The address a page's link to a crawled address becomes: under `base` (the site's path on its host), a directory for a page. */
export function hrefFor(pathWithQuery, base = '') {
  const file = fileFor(pathWithQuery);
  const link = file.endsWith('/index.html') ? file.slice(0, -'index.html'.length) : file;
  return `${base}/${link}`;
}

/** Every same-origin address a page refers to — links, forms, images, scripts, stylesheets — as `/path?query`, in order of appearance, once each. */
export function addressesIn(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/\b(?:href|action|src)="([^"]*)"/g)) {
    const raw = m[1].replace(/&amp;/g, '&');
    if (!raw.startsWith('/') || raw.startsWith('//')) continue;
    const address = raw.split('#')[0];
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

/**
 * A crawled page's HTML with every same-origin link, form action, image and script pointed at its file under `base`.
 * An address that wasn't crawled (a form's own action, a page past the cap) is pointed where it would be, so a
 * canned search lands on its file and the demo's script can tell a missing one from a present one.
 */
export function rewriteLinks(html, base = '') {
  return html.replace(/\b(href|action|src)="(\/[^"]*)"/g, (whole, attr, raw) => {
    if (raw.startsWith('//')) return whole;
    const [address, hash] = raw.replace(/&amp;/g, '&').split('#');
    if (!address) return whole;
    const target = hrefFor(address, base).replace(/&/g, '&amp;');
    return `${attr}="${target}${hash ? `#${hash}` : ''}"`;
  });
}

/**
 * What every page gets: the manifest and the service worker's script gone (the demo is not an app to install, and
 * keeps nothing), htmx gone (nothing to swap in — every form is intercepted), the demo's stylesheet and script in
 * the head, and the banner first in the body.
 */
export function inject(html, { base = '', banner }) {
  return html
    .replace(/\s*<link rel="manifest"[^>]*>/, '')
    .replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '')
    .replace(/\s*<meta name="(?:mobile-web-app-capable|apple-mobile-web-app-capable|apple-mobile-web-app-title)"[^>]*>/g, '')
    .replace(/\s*<script src="[^"]*\/vendor\/htmx\.min\.js"[^>]*><\/script>/, '')
    .replace('</head>', `<link rel="stylesheet" href="${base}/demo.css"><script src="${base}/demo-pages.js"></script><script src="${base}/demo.js" defer></script></head>`)
    .replace(/<body([^>]*)>/, (m, attrs) => `<body${attrs}>${banner}`);
}

/** The banner every page of the demo carries. */
export function bannerHtml(base = '', repo = 'https://github.com/isstiaung/nalanda') {
  return `<div class="demo-banner" role="note"><span><strong>Read-only demo</strong> of Nalanda, on seeded data — nothing you do here is kept.</span> <a href="${repo}">Run your own</a> · <a href="${base}/">Sign out</a></div>`;
}

/** The searches the demo answers, as typed into the search box; everything else gets a note instead of a page. */
export const CANNED_SEARCHES = ['le guin', 'pratchett', 'dune', 'tag:favourites', 'status:unread'];

/** The lines of the login page's note: what to type, and what the page is not. */
export const LOGIN_NOTE = `Use <strong>${DEMO_USER}</strong> / <strong>${DEMO_PASSWORD}</strong>. This is a demo, not security: every page here is public and read-only, and the sign-in is kept in your browser alone.`;
