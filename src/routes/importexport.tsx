import { Hono } from 'hono';
import type { MediaType, NewItem } from '../db/schema';
import { MEDIA_TYPES } from '../db/schema';
import {
  countBackfillable,
  getLibrary,
  getSiteSettings,
  importItems,
  listLibraries,
  listPeople,
  loansForIdRange,
  mergeImportItems,
  nextBackfillable,
  pageItems,
  exportCellsForIdRange,
  updateItem,
} from '../db/queries';
import type { AppEnv } from '../env';
import { storeCover } from '../lib/covers';
import {
  attributePeople,
  csvLine,
  EXPORT_COLUMNS,
  itemToCsvLine,
  looksLikeGoodreads,
  looksLikeNalandaExport,
  mapGoodreadsRow,
  mapLibibRow,
  mapNalandaRow,
  type ImportOptions,
  type PeopleTally,
} from '../lib/csv';
import { findCover, findDescription } from '../metadata';
import { parseDetails } from '../lib/share';
import { MEDIA_LABEL } from '../views/components';
import { page, todayOf } from '../views/layout';

const importexport = new Hono<AppEnv>();

importexport.get('/import', async (c) => {
  const [libs, backfill] = await Promise.all([listLibraries(c.env.DB), countBackfillable(c.env.DB)]);
  const items = (n: number) => (n === 1 ? 'item' : 'items');
  return page(
    c,
    'Import / export',
    <>
      <div class="page-head">
        <div>
          <h1>Import / export</h1>
          <span class="sub">LIBIB · GOODREADS CSV IN · FULL CSV OUT</span>
        </div>
        <div class="page-actions">
          <a href="/export.csv" class="btn" data-export>
            Export everything as CSV
          </a>
        </div>
      </div>
      <div id="export-status" class="prewrap muted mono" aria-live="polite"></div>
      <p class="muted">
        Export your libib collection or Goodreads library as CSV — or a Nalanda export, to restore or
        move a catalog — and drop it here; the format is auto-detected. The file is parsed in your browser and uploaded in small batches; columns we
        don't recognize are kept losslessly in each item's details. Goodreads rows that match a book
        already on your shelves (by ISBN, then title + author) merge their rating, review, shelves,
        and read date onto it — Goodreads wins. The rest are added as “Not owned” reading-log
        entries. Reads, ratings and reviews a file brings are yours, the signed-in member's; a
        Nalanda export keeps each one with the member of the same name here, and brings back every
        loan, open and returned.
      </p>
      <form id="import-form" onsubmit="return false" class="panel form-card">
        <label>
          CSV file
          <input type="file" id="import-file" accept=".csv,text/csv" required />
        </label>
        <div class="grid">
          <label>
            Into shelf
            <select id="import-library">
              {libs.map((l) => (
                <option value={String(l.id)}>{l.name}</option>
              ))}
            </select>
          </label>
          <label>
            Default type <small class="muted">(when the CSV has no type column)</small>
            <select id="import-default-type">
              {MEDIA_TYPES.map((t) => (
                <option value={t} selected={t === 'book'}>
                  {MEDIA_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          <input type="checkbox" id="import-music-as-vinyl" checked />
          Treat libib “music” items as vinyl
        </label>
        <div class="inline-form">
          <button type="button" id="import-preview" class="btn">
            Preview (dry run)
          </button>
          <button type="button" id="import-run" class="btn-primary">
            Import
          </button>
        </div>
      </form>
      <div id="import-status" class="prewrap muted mono" aria-live="polite"></div>

      <section style="margin-top:2rem">
        <p class="eyebrow">Cover backfill</p>
        {backfill.total > 0 ? (
          <>
            <p>
              <span class="mono">{backfill.noCover}</span> {items(backfill.noCover)} missing cover art ·{' '}
              <span class="mono">{backfill.noDescription}</span> {items(backfill.noDescription)} missing a description
            </p>
            <p class="muted">
              Backfill matches by ISBN/UPC first (Open Library, Google Books, iTunes), then by title and
              author — a different edition's cover may be used, but never a different book's: covers are
              stored only when the source's title or identifiers agree with the item. A record's cover
              comes only from the Cover Art Archive, by barcode or by artist and title, and its details
              from Discogs. The matching record also
              fills an empty description, publisher, year or page count — never what you've written
              yourself. Re-run any time.
            </p>
            <button type="button" id="backfill-run">
              Run backfill
            </button>
            <div id="backfill-status" class="prewrap muted mono" aria-live="polite"></div>
          </>
        ) : (
          <p class="muted">Every item already has cover art and a description. Import more and come back.</p>
        )}
      </section>
      <script src="/import.js" defer></script>
    </>,
    libs, // the sidebar's list too (§16 #68)
  );
});

type ImportBody = {
  libraryId?: number;
  dryRun?: boolean;
  defaultType?: string;
  musicAsVinyl?: boolean;
  rows?: Array<Record<string, string>>;
};

const MAX_ROWS_PER_REQUEST = 250;

importexport.post('/api/import', async (c) => {
  let body: ImportBody;
  try {
    body = await c.req.json<ImportBody>();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }
  // anything but a plain object is skipped by the mappers' own checks rather than crashing them
  const sent = Array.isArray(body.rows) ? body.rows : [];
  const rows = sent.filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r));
  if (sent.length > MAX_ROWS_PER_REQUEST) {
    return c.json({ error: `Send at most ${MAX_ROWS_PER_REQUEST} rows per request.` }, 400);
  }
  const libraryId = Number(body.libraryId);
  if (!Number.isInteger(libraryId)) return c.json({ error: 'libraryId required.' }, 400);
  // the household's currency (§16 #61): what a price the file gives no currency for was paid in
  const [lib, settings] = await Promise.all([getLibrary(c.env.DB, libraryId), getSiteSettings(c.env.DB)]);
  if (!lib) return c.json({ error: 'No such shelf.' }, 400);

  const opts: ImportOptions = {
    defaultType: (MEDIA_TYPES as readonly string[]).includes(body.defaultType ?? '')
      ? (body.defaultType as MediaType)
      : 'book',
    musicAsVinyl: body.musicAsVinyl !== false,
    currency: settings.currency,
  };

  const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];
  // our own export first: its columns are specific enough that it can't be mistaken for either of the others
  const format = looksLikeNalandaExport(headers) ? 'nalanda' : looksLikeGoodreads(headers) ? 'goodreads' : 'libib';
  const isGoodreads = format === 'goodreads';

  const mapped = [];
  let skipped = sent.length - rows.length;
  for (const row of rows) {
    const m = format === 'nalanda' ? mapNalandaRow(row, settings.currency, settings.language) : isGoodreads ? mapGoodreadsRow(row) : mapLibibRow(row, opts);
    if (m) mapped.push(m);
    else skipped++;
  }

  // Whose each read and review becomes (§16 #43): a Nalanda export names its members, and in an admin's import a name
  // that is a member here keeps them; everything else — another name, a file that names nobody, or any import by a
  // member, who changes only their own reading — is the importer's.
  const user = c.get('user');
  const keepNames = user.role === 'admin';
  const people = await listPeople(c.env.DB);
  const members = new Map(people.map((p) => [p.username, p.id]));
  const tally: PeopleTally = new Map();
  const withOwners = mapped.map((m) => {
    const { reads, reviews, plays, wants } = attributePeople(m, members, user.id, tally, keepNames);
    return { ...m, reads, reviews, plays, wants, item: { ...m.item, libraryId, addedBy: user.id } };
  });

  if (body.dryRun) {
    const byType: Record<string, number> = {};
    for (const m of mapped) byType[m.item.mediaType ?? 'book'] = (byType[m.item.mediaType ?? 'book'] ?? 0) + 1;
    const match = isGoodreads ? await mergeImportItems(c.env.DB, withOwners, true) : null;
    const nameOf = (id: number | null) => (id === null ? null : (people.find((p) => p.id === id)?.username ?? null));
    return c.json({
      format,
      mapped: mapped.length,
      skipped,
      byType,
      merged: match?.merged ?? 0,
      fresh: match?.inserted ?? 0,
      // a libib row carries no reads of its own: the tally counted what importItems will derive from its status and dates
      reads: match?.reads ?? [...tally.values()].reduce((n, t) => n + t.reads, 0),
      // a Nalanda export's loans, and how many of them are still out (§16 #57)
      loans: mapped.reduce((n, m) => n + (m.loans?.length ?? 0), 0),
      loansOut: mapped.reduce((n, m) => n + (m.loans?.filter((l) => l.returnedOn === null).length ?? 0), 0),
      // purchase prices the rows bring (§16 #61), and the household's currency, which any without their own are in
      prices: mapped.filter((m) => m.item.purchasePrice !== null && m.item.purchasePrice !== undefined).length,
      currency: settings.currency,
      // libib prices that couldn't be read as one in the household's currency (or there is none): they stay in details
      pricesLeft: mapped.filter((m) => m.item.purchasePrice == null && 'price' in parseDetails(m.item.details)).length,
      // A household of one importing its own file has nobody to tell apart: the preview says nothing new then.
      ...(people.length > 1 || [...tally.keys()].some((name) => name !== undefined && name !== user.username)
        ? { importer: user.username, keepsNames: keepNames }
        : {}),
      // per name in the file: what it brings and whose it becomes here — `as` null is nobody's (a former member)
      people: [...tally.entries()].map(([name, t]) => ({
        name: name === undefined ? null : name,
        former: name === null,
        reads: t.reads,
        reviews: t.reviews,
        ...(t.wants ? { wants: t.wants } : {}), // only from a file that has want lists in it (§16 #53)
        as: nameOf(t.to),
        known: t.known,
      })),
      sample: mapped.slice(0, 5).map((m) => ({
        title: m.item.title,
        mediaType: m.item.mediaType,
        creators: m.item.creators,
        tags: m.tags,
      })),
    });
  }

  if (isGoodreads) {
    const { inserted, merged, reads } = await mergeImportItems(c.env.DB, withOwners);
    return c.json({ inserted, merged, reads, skipped });
  }
  const inserted = await importItems(c.env.DB, withOwners);
  return c.json({ inserted, merged: 0, skipped });
});

/**
 * Cover backfill, one small batch per request — the browser loops (like /api/import).
 * The batch stays small to respect the free plan's 50-subrequest budget: a full-chain
 * miss costs up to ~9 outbound fetches per item (see findCover).
 */
// Two, not three: each item can spend a dozen subrequests and parse several provider payloads,
// against a 10 ms CPU budget and 50 subrequests per request. Three was tripping the limit in production.
const BACKFILL_BATCH = 2;

importexport.post('/api/backfill-covers', async (c) => {
  const body = await c.req.json<{ after?: number }>().catch(() => ({}) as { after?: number });
  const after = Number.isInteger(body.after) && body.after! >= 0 ? body.after! : 0;

  const batch = await nextBackfillable(c.env.DB, after, BACKFILL_BATCH);
  let tried = 0;
  let found = 0;
  let byTitle = 0;
  let enriched = 0;
  let lastId = after;
  let stopped = false;
  for (const item of batch) {
    // sequential on purpose: polite to providers, predictable subrequest count
    try {
      const result = await findCover(
        c.env,
        {
          barcode: item.isbn13 ?? item.isbn10Upc,
          title: item.title,
          creators: item.creators,
          mediaType: item.mediaType,
          musicbrainzId: parseDetails(item.details)['musicbrainz_id'],
          wantCover: !item.coverKey,
        },
        // an item that only wants a description keeps the cover it has — nothing is fetched for it
        item.coverKey ? async () => null : (url) => storeCover(c.env.COVERS, url),
      );
      // Only ever fills blanks: what the household wrote always wins over a provider.
      const patch: Partial<NewItem> = {};
      if (!item.coverKey && result?.key) patch.coverKey = result.key;
      const match = result?.candidate;
      if (match) {
        if (!item.description?.trim() && match.description) patch.description = match.description;
        if (!item.publisher?.trim() && match.publisher) patch.publisher = match.publisher;
        if (!item.published?.trim() && match.published) patch.published = match.published;
        if (item.length === null && match.length) patch.length = match.length;
      }
      // Open Library keeps descriptions on the work record, so ask for it only when one is still missing
      if (!patch.description && !item.description?.trim()) {
        const fromWork = await findDescription(match ?? null);
        if (fromWork) patch.description = fromWork;
      }
      if (Object.keys(patch).length) await updateItem(c.env.DB, item.id, patch);
      if (patch.coverKey) {
        found++;
        if (result?.method === 'title') byTitle++;
      }
      if (patch.description || patch.publisher || patch.published || patch.length) enriched++;
      tried++;
      lastId = item.id;
    } catch {
      // A hung provider or the subrequest budget must not end the whole run: report the progress
      // made, and let the browser carry on from the item after this one.
      stopped = true;
      lastId = item.id;
      break;
    }
  }

  return c.json({ tried, found, byTitle, enriched, lastId, done: !stopped && batch.length < BACKFILL_BATCH });
});

/**
 * Items per request when the Export button pages through the catalog (ARCH.md §16 #38). Reading, mapping and
 * writing a page of 250 measured about 2 ms of CPU warm and 6 ms on a cold isolate, with rows heavier than
 * production's; the whole 2,000-item catalog in one request measured 12 ms warm and 20 ms cold, past the free
 * plan's 10 ms.
 */
export const EXPORT_PAGE = 250;

/**
 * Loans a page carries at most, beside its items (§16 #57). Writing a loan costs about as much as the rest of an
 * item's row; 250 items with twenty loans each, their text all to be encoded, measured 5–6 ms warm and 8 ms cold
 * where the page alone took under 1. A page that would pass this ends at the last item whose loans all fit, and the
 * next page starts after it.
 */
export const EXPORT_LOANS = 1000;

/**
 * Items after `afterId` as CSV lines, with their tags, reads, reviews, loans, reading logs, plays, series, wants and
 * purchase links: two D1 calls, the items and one batch for everything beside them (§16 #53). With `loanLimit`, a page
 * ends before it would carry more loans than that, and an item with more of its own goes out alone, for a third call.
 * `more` says another page may follow.
 */
async function exportRows(
  d1: D1Database,
  scope: number | undefined,
  afterId: number,
  limit: number,
  libNames: Map<number, string>,
  loanLimit?: number,
): Promise<{ csv: string; count: number; lastId: number; more: boolean }> {
  let items = await pageItems(d1, { libraryId: scope, afterId, limit });
  if (!items.length) return { csv: '', count: 0, lastId: afterId, more: false };
  let more = items.length === limit;
  const [from, to] = [items[0]!.id, items.at(-1)!.id];
  // one batch for every cell beside the items (§16 #37, #53), its loans held to the page's limit as before (§16 #57)
  const cells = await exportCellsForIdRange(d1, from, to, scope, loanLimit === undefined ? undefined : loanLimit + 1);
  let loanMap = cells.loans;
  if (cells.loanCutAt !== null) {
    // more loans than a page carries: the item they stopped at may be missing some, so the page ends before it
    const cutAt = cells.loanCutAt;
    const first = items[0]!;
    items = items.filter((item) => item.id < cutAt);
    if (!items.length) {
      // that item alone has more than a page's worth: it goes out alone, with every loan
      items = [first];
      loanMap = (await loansForIdRange(d1, first.id, first.id, scope)).loans;
    }
    more = true;
  }
  let csv = '';
  for (const item of items) {
    csv += itemToCsvLine(
      item,
      libNames.get(item.libraryId) ?? '',
      cells.tags.get(item.id) ?? [],
      cells.progress.get(item.id) ?? [],
      cells.reads.get(item.id) ?? [],
      cells.reviews.get(item.id) ?? [],
      loanMap.get(item.id) ?? [],
      cells.plays.get(item.id) ?? [],
      item.seriesId !== null ? (cells.series.get(item.seriesId) ?? null) : null,
      cells.wants.get(item.id) ?? [],
      cells.links.get(item.id) ?? [],
    );
  }
  return { csv, count: items.length, lastId: items.at(-1)!.id, more };
}

importexport.get('/export.csv', async (c) => {
  const libraryId = Number.parseInt(c.req.query('library') ?? '', 10);
  const scope = Number.isInteger(libraryId) ? libraryId : undefined;
  const after = c.req.query('after');
  if (after !== undefined && !/^\d{1,15}$/.test(after)) return c.text('after must be an item id', 400);
  const libs = await listLibraries(c.env.DB);
  const libNames = new Map(libs.map((l) => [l.id, l.name]));
  const today = todayOf(c);
  const headers = {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="nalanda-export-${today}.csv"`,
    'cache-control': 'no-store',
  };

  if (after !== undefined) {
    // One page per request, as the Export button asks for it (public/import.js), which joins the pages into
    // one file. The header row leads the first page only; `x-export-next` names where the next page starts,
    // and is missing once a page comes back short — short of items, not ended early for its loans.
    const afterId = Number(after);
    const page = await exportRows(c.env.DB, scope, afterId, EXPORT_PAGE, libNames, EXPORT_LOANS);
    return new Response((afterId === 0 ? csvLine([...EXPORT_COLUMNS]) : '') + page.csv, {
      headers: {
        ...headers,
        'x-export-rows': String(page.count),
        ...(page.more ? { 'x-export-next': String(page.lastId) } : {}),
      },
    });
  }

  // Without a cursor, the whole export in one streamed response: what the link does without JavaScript, and
  // what a script fetching /export.csv gets. Its CPU grows with the catalog, so a large one can be cut off by
  // the free plan's 10 ms limit, and the download fails rather than completing. Two D1 calls a page (the items, then
  // one batch for tags, reads, reviews, loans, reading progress, plays, series, wants and purchase links) against the
  // 50 budgeted per invocation. One page per pull, so a slow
  // download holds one page in memory rather than all of them. The response is already a 200 by the time a
  // page is read, so a failure must error the stream — ending it normally hands over a file that just stops,
  // with nothing to say it is incomplete.
  const encoder = new TextEncoder();
  const d1 = c.env.DB;
  const PAGE = 2000;
  let afterId = 0;
  let headerSent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(csvLine([...EXPORT_COLUMNS])));
          return;
        }
        // no loan limit: the whole stream is one invocation, so smaller pages would spend queries and save no CPU
        const page = await exportRows(d1, scope, afterId, PAGE, libNames);
        if (!page.count) return controller.close();
        controller.enqueue(encoder.encode(page.csv));
        afterId = page.lastId;
        if (!page.more) controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(body, { headers });
});

export default importexport;
