import { Hono } from 'hono';
import { catalogMatches, getSiteSettings, listLibraries, listPeople, seriesNames } from '../db/queries';
import type { AppEnv } from '../env';
import { lookupByBarcode, searchByName, type SearchType } from '../metadata';
import { BggAttribution, DiscogsNotice } from '../views/attribution';
import { scanQueueOwner } from '../lib/auth';
import { CandidateCard, ItemForm, ReviewEntry, SCANNED_AT } from '../views/components';
import { page } from '../views/layout';

const add = new Hono<AppEnv>();

add.get('/add', async (c) => {
  const [libs, people, names, settings] = await Promise.all([
    listLibraries(c.env.DB),
    listPeople(c.env.DB),
    seriesNames(c.env.DB),
    getSiteSettings(c.env.DB), // the household's currency, for the manual form's purchase price (§16 #61)
  ]);
  return page(
    c,
    'Add items',
    <>
      <div class="page-head">
        <div>
          <h1>Add items</h1>
          <span class="sub">SCAN · SEARCH · MANUAL ENTRY</span>
        </div>
      </div>
      {/* Scans held on this device while it was offline (ARCH.md §16 #48). scan-review.js shows this only when there
          are some, and looks each one up through /add/review; nothing is added until someone presses a button. */}
      <section id="scan-review" class="scan-review" hidden>
        <p class="eyebrow">Held on this device</p>
        <article class="notice scan-review-head">
          <div>
            <strong>
              <span id="scan-review-count" class="mono">
                0
              </span>{' '}
              <span id="scan-review-noun">scanned while offline</span>
            </strong>
            <p class="muted">
              Each is looked up here now. Pick a shelf, then add it or drop it — nothing is added until you do.
            </p>
          </div>
          {libs.length ? (
            <form id="scan-review-all" class="inline-form">
              <select name="libraryId" aria-label="Shelf for all of them">
                {libs.map((l) => (
                  <option value={String(l.id)}>{l.name}</option>
                ))}
              </select>
              <button type="submit" disabled>
                {/* one inline run: a button lays its children out with a gap */}
                <span>
                  Add all to <span data-shelf-name>{libs[0]?.name}</span>
                </span>
              </button>
            </form>
          ) : null}
        </article>
        <div id="scan-review-list"></div>
      </section>
      {/* toggle buttons: aria-pressed says which panel is showing (app.js keeps it in step) */}
      <div class="tab-bar">
        <button type="button" class="tab active" data-tab="scan" aria-pressed="true">
          <span aria-hidden="true">📷</span> Scan
        </button>
        <button type="button" class="tab" data-tab="search" aria-pressed="false">
          <span aria-hidden="true">🔎</span> Search
        </button>
        <button type="button" class="tab" data-tab="manual" aria-pressed="false">
          <span aria-hidden="true">✍️</span> Manual
        </button>
      </div>

      <section id="tab-scan" class="tab-panel active">
        <p class="muted">
          Point the camera at a book or record barcode — or type its digits below, no camera needed. ISBNs look up
          books; other barcodes look up vinyl on Discogs. Board games have no barcodes on BGG — use the Search tab.
        </p>
        <video id="scanner-video" playsinline muted></video>
        <div class="inline-form">
          <button type="button" id="scanner-start">
            Start camera
          </button>
          <button type="button" id="scanner-stop" class="btn" hidden>
            Stop
          </button>
        </div>
        <p id="scanner-status" class="muted" aria-live="polite"></p>
        <form
          class="inline-form"
          hx-get="/add/results"
          hx-target="#scan-results"
          hx-swap="innerHTML"
        >
          <label>
            Barcode <small>(ISBN, EAN or UPC digits)</small>
            <input name="barcode" placeholder="e.g. 9780441478125" inputmode="numeric" autocomplete="off" />
          </label>
          <button type="submit">Look up</button>
        </form>
        <div id="scan-results"></div>
      </section>

      <section id="tab-search" class="tab-panel" hidden>
        <form hx-get="/add/results" hx-target="#search-results" hx-swap="innerHTML" class="inline-form">
          <input type="search" name="q" placeholder="Title, artist, game name…" aria-label="Title, artist or game name" required />
          <select name="type" aria-label="What is it?">
            <option value="book">📖 Book</option>
            <option value="boardgame">🎲 Board game</option>
            <option value="vinyl">💿 Vinyl</option>
          </select>
          <button type="submit">Search</button>
        </form>
        <div id="search-results"></div>
      </section>

      <section id="tab-manual" class="tab-panel" hidden>
        <ItemForm
          libraries={libs}
          action="/items"
          submitLabel="Add item"
          perMember={people.length > 1}
          seriesNames={names}
          money={{ household: settings.currency, admin: c.get('user').role === 'admin' }}
        />
      </section>
      <script src="/scan-queue.js" defer></script>
      <script src="/scanner.js" defer></script>
      <script src="/scan-review.js" defer></script>
    </>,
  );
});

/** htmx partial shared by the scanner and the search tab. */
add.get('/add/results', async (c) => {
  const barcode = c.req.query('barcode')?.trim();
  const q = c.req.query('q')?.trim();
  const typeParam = c.req.query('type');
  const type: SearchType = typeParam === 'boardgame' || typeParam === 'vinyl' ? typeParam : 'book';

  const result = barcode
    ? await lookupByBarcode(c.env, barcode)
    : q
      ? await searchByName(c.env, q, type)
      : { candidates: [], notices: ['Enter a barcode or search term.'] };

  // the shelves, and which results the catalog already has ("In your catalog"): two calls, whatever the list's length
  const [libs, held] = await Promise.all([listLibraries(c.env.DB), catalogMatches(c.env.DB, result.candidates)]);
  return c.html(
    <>
      {result.notices.map((n) => (
        <p class="notice">{n}</p>
      ))}
      {result.candidates.map((candidate, i) => (
        <CandidateCard candidate={candidate} libraries={libs} inCatalog={held[i]} />
      ))}
      {result.candidates.some((candidate) => candidate.provider === 'bgg') ? <BggAttribution /> : null}
      {/* §16 #63: each Discogs result carries its own credit; the terms' notice goes once, below them */}
      {result.candidates.some((candidate) => candidate.provider === 'discogs') ? <DiscogsNotice /> : null}
    </>,
  );
});

/**
 * One entry of the Add page's review list: a barcode held on the device while offline, looked up now — the same
 * lookup as /api/lookup, one barcode a request so each stays inside a request's subrequest and CPU budget.
 * `scanned` is the time the device recorded, shown back and nothing more. Always a partial: there's no page here.
 */
add.get('/add/review', async (c) => {
  const barcode = c.req.query('barcode')?.trim() ?? '';
  if (!/^\d{8,14}$/.test(barcode)) return c.text('Not a barcode.', 400);
  const scanned = c.req.query('scanned')?.trim() ?? '';
  const [result, libs, scanOwner] = await Promise.all([
    lookupByBarcode(c.env, barcode),
    listLibraries(c.env.DB),
    scanQueueOwner(c.env.SESSION_SECRET ?? '', c.get('user')),
  ]);
  const [held] = result.candidates[0] ? await catalogMatches(c.env.DB, [result.candidates[0]]) : [null];
  return c.html(
    <ReviewEntry
      barcode={barcode}
      scannedAt={SCANNED_AT.test(scanned) ? scanned : null}
      candidate={result.candidates[0] ?? null}
      notices={result.notices}
      libraries={libs}
      scanOwner={scanOwner}
      inCatalog={held}
    />,
  );
});

/** Same lookup as JSON, for scripting/tests. */
add.get('/api/lookup', async (c) => {
  const barcode = c.req.query('barcode')?.trim();
  const q = c.req.query('q')?.trim();
  const typeParam = c.req.query('type');
  const type: SearchType = typeParam === 'boardgame' || typeParam === 'vinyl' ? typeParam : 'book';
  if (barcode) return c.json(await lookupByBarcode(c.env, barcode));
  if (q) return c.json(await searchByName(c.env, q, type));
  return c.json({ candidates: [], notices: ['Pass ?barcode= or ?q=&type='] }, 400);
});

export default add;
