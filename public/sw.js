// Nalanda's service worker (ARCH.md §16 #48). It exists for one thing: scanning barcodes with no signal.
//
// It never stores a page or an API answer. Phones get shared, and a signed-in page is someone's catalog, so
// the only things it keeps are the static files listed in STATIC below — the offline page, its stylesheet,
// font and icon, and the scanner with its decoder — none of which holds anything about anyone. Everything
// else goes to the network as if no worker were here, and a page that can't load offline gets the offline
// page instead, which scans into the device's queue (scan-queue.js).
//
// Online, even the listed files come from the network first, so a deploy reaches phones at once and nobody
// is stranded on old assets; the kept copies are only for when the network fails. Bump VERSION whenever
// STATIC or this file's behaviour changes: installing the new worker fills a fresh cache, and activating it
// deletes every older one.

const VERSION = 1;
const CACHE = `nalanda-static-v${VERSION}`;

// Every one of these is a file in public/. A test fetches each (test/pwa.spec.ts), since one missing file fails
// the whole install.
const STATIC = [
  '/offline.html',
  '/app.css',
  '/logo.svg',
  '/scan-queue.js',
  '/scanner.js',
  '/vendor/fonts/eczar-latin-600-normal.woff2',
  '/vendor/fonts/eczar-latin-700-normal.woff2',
  '/vendor/zxing/reader/index.js',
  '/vendor/zxing/share.js',
  '/vendor/zxing/zxing_reader.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        Promise.all(
          STATIC.map(async (path) => {
            // past the HTTP cache: a new worker must not fill its cache with the files it is replacing
            const response = await fetch(path, { cache: 'reload', credentials: 'omit' });
            // the file itself or nothing — never a redirect (to the login page, say) kept in its place
            if (response.status !== 200 || response.redirected) throw new Error(`${path}: ${response.status}`);
            await cache.put(path, response);
          }),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('nalanda-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Only this origin's GETs. A POST — a login, an add, a logout — always goes straight through.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Public share pages are untouched: no fallback, nothing kept (ARCH.md §9).
  if (url.pathname === '/share' || url.pathname.startsWith('/share/')) return;

  if (request.mode === 'navigate') {
    // A page: the network's answer, never stored. Only when there is no network does the offline page stand in.
    event.respondWith(
      fetch(request).then(
        (response) => {
          // nothing else ever asks for the offline page, so a page load is when its kept copy is brought up to date
          event.waitUntil(refreshOfflinePage());
          return response;
        },
        () => offlinePage(),
      ),
    );
    return;
  }

  if (STATIC.includes(url.pathname) && !url.search) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // besides install and the offline page's refresh, the one place anything is stored — and only a whole,
          // successful copy of a listed file
          if (response.ok && response.status === 200 && !response.redirected) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put(url.pathname, copy)));
          }
          return response;
        })
        .catch(() => caches.match(url.pathname, { cacheName: CACHE }).then((kept) => kept || Response.error())),
    );
  }
  // anything else: no respondWith, so the browser fetches it exactly as it would without a worker
});

// At most once an hour for each time the browser wakes this worker: a conditional request for a 4 KB file.
let offlineCheckedAt = 0;
async function refreshOfflinePage() {
  if (Date.now() - offlineCheckedAt < 60 * 60 * 1000) return;
  offlineCheckedAt = Date.now();
  try {
    const response = await fetch('/offline.html', { credentials: 'omit' });
    if (response.status === 200 && !response.redirected) await (await caches.open(CACHE)).put('/offline.html', response);
  } catch {
    // no network after all: the kept copy stands
  }
}

async function offlinePage() {
  const kept = await caches.match('/offline.html', { cacheName: CACHE });
  return kept || new Response('Offline.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
