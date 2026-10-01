import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { addScannedItems, catalogMatches, getLibraryAndSettings, getSiteSettings, isbnlessBookIndex, itemTitles, listLibraries, listPeople, seriesNames, shelfForType, type IsbnlessBook } from '../db/queries';
import type { Item, MediaType, NewItem } from '../db/schema';
import type { AppEnv } from '../env';
import { classifyBarcode, isbn13Of, lookupByBarcode, searchByName, type Candidate, type SearchType } from '../metadata';
import { BggAttribution, DiscogsNotice } from '../views/attribution';
import { scanQueueOwner } from '../lib/auth';
import { isRecord } from '../lib/condition';
import { formatsFromPressing, normalizeFormats } from '../lib/formats';
import { CandidateCard, ItemForm, ReviewEntry, SCANNED_AT } from '../views/components';
import { page } from '../views/layout';
import { writerOf } from './items';

const add = new Hono<AppEnv>();

/** A barcode a lookup found nothing for, as the manual form's fields (§16 #94): the ISBN or UPC filled in, its kind picked. */
const BARCODE = /^\d{8,14}$/;
function prefillFor(raw: string | undefined): Item | null {
  const classified = raw && BARCODE.test(raw) ? classifyBarcode(raw) : null;
  if (!classified) return null;
  const book = classified.kind !== 'upc';
  return {
    id: 0,
    mediaType: book ? 'book' : 'vinyl',
    title: '',
    isbn13: classified.kind === 'isbn13' ? classified.code : null,
    isbn10Upc: classified.kind === 'isbn13' ? null : classified.code,
    coverKey: null,
    readCount: 0,
    rereading: false,
    copies: 1,
    status: 'not_started',
    details: '{}',
    formats: '',
  } as Item;
}

add.get('/add', async (c) => {
  const [libs, people, names, settings] = await Promise.all([
    listLibraries(c.env.DB),
    listPeople(c.env.DB),
    seriesNames(c.env.DB),
    getSiteSettings(c.env.DB), // the household's currency, for the manual form's purchase price (§16 #61)
  ]);
  // "Add by hand" on a scan nothing was found for (§16 #94): the page opens on the manual form with the barcode in it
  const prefill = prefillFor(c.req.query('barcode')?.trim());
  const tab = (name: 'scan' | 'search' | 'manual') => {
    const active = prefill ? name === 'manual' : name === 'scan';
    return { class: active ? 'tab active' : 'tab', pressed: active ? 'true' : 'false', panel: active ? 'tab-panel active' : 'tab-panel', hidden: !active };
  };
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
      {/* Barcodes held on this device (ARCH.md §16 #48, #94): scanned with no signal, or with "Keep scanning" on. One list,
          whichever way they came: scan-review.js shows it only when there are some, and nothing is added until someone
          presses a button. "Add all" sends them twenty at a time to POST /api/scans/add, which looks each one up; "Look
          up" on one entry fetches it alone through /add/review, to pick its shelf, want it or drop it. */}
      <section id="scan-review" class="scan-review" hidden>
        <p class="eyebrow">Held on this device</p>
        <article class="notice scan-review-head">
          <div>
            <strong>
              <span id="scan-review-count" class="mono">
                0
              </span>{' '}
              <span id="scan-review-noun">held on this device</span>
            </strong>
            <p class="muted">
              Each is a barcode and when it was scanned. Add them all to one shelf — each is looked up as it goes in, and
              one the catalog already has is left alone — or look one up to pick its shelf, want it or drop it. A barcode
              nothing is found for stays here to add by hand. New items arrive without covers.
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
        {/* what "Add all" is doing and what it did: N added, M already here, K not found */}
        <p id="scan-review-status" class="muted scan-review-status" aria-live="polite"></p>
        <div id="scan-review-list"></div>
      </section>
      {/* toggle buttons: aria-pressed says which panel is showing (app.js keeps it in step) */}
      <div class="tab-bar">
        <button type="button" class={tab('scan').class} data-tab="scan" aria-pressed={tab('scan').pressed}>
          <span aria-hidden="true">📷</span> Scan
        </button>
        <button type="button" class={tab('search').class} data-tab="search" aria-pressed={tab('search').pressed}>
          <span aria-hidden="true">🔎</span> Search
        </button>
        <button type="button" class={tab('manual').class} data-tab="manual" aria-pressed={tab('manual').pressed}>
          <span aria-hidden="true">✍️</span> Manual
        </button>
      </div>

      <section id="tab-scan" class={tab('scan').panel} hidden={tab('scan').hidden}>
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
          {/* a shelf in one go (§16 #94): each barcode is held for the list above, the camera stays on; remembered per device */}
          <label class="scanner-keep">
            <input type="checkbox" id="scanner-keep" /> Keep scanning
            <small class="muted">(hold each barcode for the list, add them all at once)</small>
          </label>
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

      <section id="tab-search" class={tab('search').panel} hidden={tab('search').hidden}>
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

      <section id="tab-manual" class={tab('manual').panel} hidden={tab('manual').hidden}>
        <ItemForm
          libraries={libs}
          action="/items"
          submitLabel="Add item"
          item={prefill}
          perMember={people.length > 1}
          seriesNames={names}
          money={{ household: settings.currency, admin: c.get('user').role === 'admin' }}
          language={settings.language}
        />
      </section>
      <script src="/scan-queue.js" defer></script>
      <script src="/scanner.js" defer></script>
      <script src="/scan-review.js" defer></script>
    </>,
    libs, // the sidebar's list too (§16 #68)
  );
});

/** How far "More results" goes: fifty pages of eight is 400 results, past anything worth scrolling. */
const LAST_PAGE = 50;

/**
 * "More results", after a page of name-search results: the next page, swapped in where the button was. The next
 * page arrives wrapped in an element with the same id, so the page-wide focus handler (public/app.js) lands on it and
 * Tab carries on into the new results.
 */
const MoreResults: FC<{ q: string; type: SearchType; page: number }> = ({ q, type, page }) => {
  const id = `results-more-${page}`;
  return (
    <div id={id} class="results-more">
      <button type="button" class="btn" hx-get={`/add/results?${new URLSearchParams({ q, type, page: String(page) })}`} hx-target={`#${id}`} hx-swap="outerHTML">
        More results
      </button>
    </div>
  );
};

/** htmx partial shared by the scanner and the search tab; a name search comes a page at a time. */
add.get('/add/results', async (c) => {
  const barcode = c.req.query('barcode')?.trim();
  const q = c.req.query('q')?.trim();
  const typeParam = c.req.query('type');
  const type: SearchType = typeParam === 'boardgame' || typeParam === 'vinyl' ? typeParam : 'book';
  const asked = Number.parseInt(c.req.query('page') ?? '1', 10);
  const pageNo = barcode ? 1 : Math.min(Math.max(Number.isFinite(asked) ? asked : 1, 1), LAST_PAGE);

  const result = barcode
    ? await lookupByBarcode(c.env, barcode)
    : q
      ? await searchByName(c.env, q, type, pageNo)
      : { candidates: [], notices: ['Enter a barcode or search term.'] };

  // the shelves, which shelf each type starts on, and which results the catalog already has ("In your catalog"):
  // three calls, whatever the list's length
  const [libs, shelfFor, held] = await Promise.all([
    listLibraries(c.env.DB),
    shelfForType(c.env.DB),
    catalogMatches(c.env.DB, result.candidates),
  ]);
  const cards = (
    <>
      {result.notices.map((n) => (
        <p class="notice">{n}</p>
      ))}
      {result.candidates.map((candidate, i) => (
        <CandidateCard candidate={candidate} libraries={libs} inCatalog={held[i]} shelfFor={shelfFor} />
      ))}
      {q && !barcode && result.more && pageNo < LAST_PAGE ? <MoreResults q={q} type={type} page={pageNo + 1} /> : null}
    </>
  );
  // a later page takes the place of the button that asked for it, under the same id; the credits are already there
  if (pageNo > 1) {
    return c.html(
      <div id={`results-more-${pageNo}`} class="results-page">
        {cards}
      </div>,
    );
  }
  return c.html(
    <>
      {cards}
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
  const [result, libs, shelfFor, scanOwner] = await Promise.all([
    lookupByBarcode(c.env, barcode),
    listLibraries(c.env.DB),
    shelfForType(c.env.DB),
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
      shelfFor={shelfFor}
    />,
  );
});

/**
 * How many barcodes one "Add all" request resolves (ARCH.md §16 #94). A Worker invocation may make 50 outbound
 * requests: twenty codes × the two book providers (Open Library and Google Books, asked together) is 40, a record's
 * one Discogs request fewer, and nothing else here goes outside — no cover, no description, no release — so the
 * batch stays under the cap with room to spare. The browser loops over the list in batches of this size, as the CSV
 * import does.
 */
export const MAX_SCANS_PER_REQUEST = 20;
/** Lookups in flight at once: Open Library refuses bursts, and the request waits for the slowest either way. */
const LOOKUPS_AT_ONCE = 4;

type ScanBody = { libraryId?: unknown; codes?: unknown; scanOwner?: unknown };
type CatalogProbe = { mediaType: MediaType; isbn13?: string; isbn10Upc?: string; details: Record<string, unknown> };

/** What the catalog would know a barcode nothing was found for by: a book by its ISBN-13, a record by its barcode. */
function probeFor(code: string): CatalogProbe {
  const classified = classifyBarcode(code);
  if (classified?.kind === 'isbn13') return { mediaType: 'book', isbn13: classified.code, details: {} };
  if (classified?.kind === 'isbn10') return { mediaType: 'book', isbn13: isbn13Of(classified.code), details: {} };
  return { mediaType: 'vinyl', isbn10Upc: code, details: {} };
}

/** What names a found record within one batch, so two scans of one book — its ISBN-10 and its EAN-13 — add it once. */
function keyOf(c: Candidate): string | null {
  const digits = (v: string | undefined) => (v ?? '').replace(/\D/g, '') || null;
  if (isRecord(c.mediaType)) {
    const id = c.details['discogs_id'];
    return digits(c.isbn10Upc) ?? digits(c.isbn13) ?? (typeof id === 'number' || typeof id === 'string' ? `discogs:${id}` : null);
  }
  return digits(c.isbn13);
}

/**
 * A scan's candidate as the bare record it becomes (§16 #94): what the lookup's JSON carries and nothing fetched for
 * it — no cover (the cover backfill paces itself), no release for a record's tracklist ("Refresh from Discogs" does
 * that later, with the release id kept in details). The household's language unless the provider said (§16 #76);
 * a record's carrier from the pressing's format, as an Add from the page would (§16 #75).
 */
function bareItem(c: Candidate, libraryId: number, addedBy: number, language: string): NewItem {
  const pressing = c.details['format'];
  const formats = c.formats?.length ? c.formats : isRecord(c.mediaType) ? formatsFromPressing(typeof pressing === 'string' ? pressing : null) : [];
  return {
    libraryId,
    mediaType: c.mediaType,
    title: c.title,
    creators: c.creators || null,
    isbn13: c.isbn13?.replace(/\D/g, '') || null,
    isbn10Upc: c.isbn10Upc || null,
    publisher: c.publisher || null,
    published: c.published || null,
    description: c.description || null,
    length: c.length && c.length > 0 ? c.length : null,
    language: c.language ?? language,
    formats: normalizeFormats(c.mediaType, formats),
    details: JSON.stringify(c.details),
    copies: 1,
    addedBy,
    coverKey: null,
  };
}

/**
 * "Add all" from the review list (ARCH.md §16 #94): at most MAX_SCANS_PER_REQUEST held barcodes, each resolved by the
 * usual lookup, the ones the catalog already has left alone (one query for the batch), the rest added as bare records
 * in one D1 batch. Answers what became of each: `added` and `already` with the item and its title; `maybe` — a book
 * the catalog may hold under no ISBN at all (a reading-log entry), met by title and author, which is held rather than
 * added so nobody decides it unseen; `notFound` the barcodes nothing was found for, which the browser keeps on the
 * list to add by hand. Refused for scans held for another account (`scanOwner`), as POST /items refuses one.
 */
add.post('/api/scans/add', async (c) => {
  let body: ScanBody;
  try {
    body = await c.req.json<ScanBody>();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }
  if (body.scanOwner !== (await scanQueueOwner(c.env.SESSION_SECRET ?? '', c.get('user')))) {
    return c.json({ error: 'Those scans were held for whoever was signed in before. Nothing was added — reload Add items.' }, 409);
  }
  const sent = Array.isArray(body.codes) ? body.codes : null;
  if (!sent) return c.json({ error: 'codes required.' }, 400);
  if (sent.length > MAX_SCANS_PER_REQUEST) return c.json({ error: `Send at most ${MAX_SCANS_PER_REQUEST} barcodes per request.` }, 400);
  const codes: string[] = [];
  for (const entry of sent) {
    const raw = entry !== null && typeof entry === 'object' ? (entry as { code?: unknown }).code : undefined;
    const code = typeof raw === 'string' ? raw.trim() : '';
    if (!BARCODE.test(code)) return c.json({ error: 'Not a barcode.' }, 400);
    if (!codes.includes(code)) codes.push(code);
  }
  const libraryId = Number(body.libraryId);
  if (!Number.isInteger(libraryId)) return c.json({ error: 'libraryId required.' }, 400);
  // the shelf and the household's language in one call (§16 #76)
  const { library: lib, settings: site } = await getLibraryAndSettings(c.env.DB, libraryId);
  if (!lib) return c.json({ error: 'No such shelf.' }, 400);

  // each code's lookup, a few at a time: ISBNs to the book providers, anything else to Discogs (src/metadata/index.ts)
  const found: Array<Candidate | null> = codes.map(() => null);
  const why: string[][] = codes.map(() => []); // the lookup's notices, reported only for a code nothing is found for
  let next = 0;
  const worker = async () => {
    while (next < codes.length) {
      const i = next++;
      const result = await lookupByBarcode(c.env, codes[i]!);
      found[i] = result.candidates[0] ?? null;
      why[i] = result.notices;
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, codes.length) }, worker));

  // what the catalog already has, one query for the batch: a found code by what its candidate names (an ISBN-13, a
  // record's barcode or Discogs id), an unknown one by the barcode itself, so a shelf catalogued by hand reads as here
  const held = await catalogMatches(c.env.DB, codes.map((code, i) => found[i] ?? probeFor(code)));
  // a found book no number matched may still be here under no number — a fifth of a catalogue is reading-log entries
  // with none — so those are met by title and author too (the imports' matcher): one more query, only when there are any
  const maybeOf = new Map<number, IsbnlessBook>();
  const unnumbered = (i: number) => held[i] == null && found[i]?.mediaType === 'book';
  if (codes.some((_, i) => unnumbered(i))) {
    const index = await isbnlessBookIndex(c.env.DB);
    for (let i = 0; i < codes.length; i++) {
      const hit = unnumbered(i) ? index.find(found[i]!.title, found[i]!.creators ?? null) : undefined;
      if (hit) maybeOf.set(i, hit);
    }
  }
  const toAdd: number[] = []; // indexes of the codes that become items
  const twinOf = new Map<number, number>(); // a second scan of a book in this batch → the index that adds it
  const firstBy = new Map<string, number>();
  for (let i = 0; i < codes.length; i++) {
    const candidate = found[i];
    if (held[i] !== null || maybeOf.has(i) || !candidate) continue;
    const key = keyOf(candidate);
    const first = key ? firstBy.get(key) : undefined;
    if (first !== undefined) {
      twinOf.set(i, first);
      continue;
    }
    if (key) firstBy.set(key, i);
    toAdd.push(i);
  }
  const user = c.get('user');
  const ids = await addScannedItems(
    c.env.DB,
    toAdd.map((i) => ({ item: bareItem(found[i]!, lib.id, user.id, site.language), series: found[i]!.series ?? null })),
    writerOf(c),
  );
  const idOf = new Map(toAdd.map((i, n) => [i, ids[n]!]));
  const titles = await itemTitles(c.env.DB, held.filter((id): id is number => id !== null));
  const added = toAdd.map((i) => ({ code: codes[i]!, id: idOf.get(i)!, title: found[i]!.title }));
  const already: Array<{ code: string; id: number; title: string }> = [];
  // held, not added: the catalog's entry by id and title, and whether it is Not owned — the Holding toggle on its page is
  // then the likely next step once someone has looked and decided
  const maybe: Array<{ code: string; id: number; title: string; notOwned: boolean }> = [];
  const notFound: string[] = [];
  const notices = new Set<string>();
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    const here = held[i] ?? null;
    const twin = twinOf.get(i);
    const hit = maybeOf.get(i);
    if (here !== null) already.push({ code, id: here, title: titles.get(here) ?? found[i]?.title ?? '' });
    else if (hit) maybe.push({ code, id: hit.id, title: hit.title, notOwned: hit.copies === 0 });
    else if (twin !== undefined) already.push({ code, id: idOf.get(twin)!, title: found[twin]!.title });
    else if (!found[i]) {
      notFound.push(code);
      for (const n of why[i]!) notices.add(n);
    }
  }
  return c.json({ added, already, maybe, notFound, notices: [...notices] });
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
