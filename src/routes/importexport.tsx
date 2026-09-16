import { Hono } from 'hono';
import type { MediaType, NewItem } from '../db/schema';
import { MEDIA_TYPES } from '../db/schema';
import {
  countBackfillable,
  importItems,
  listLibraries,
  mergeImportItems,
  nextBackfillable,
  pageItems,
  tagsForItems,
  updateItem,
} from '../db/queries';
import type { AppEnv } from '../env';
import { storeCover } from '../lib/covers';
import {
  csvLine,
  EXPORT_COLUMNS,
  itemToCsvLine,
  looksLikeGoodreads,
  mapGoodreadsRow,
  mapLibibRow,
  type ImportOptions,
} from '../lib/csv';
import { findCover, findDescription } from '../metadata';
import { MEDIA_LABEL } from '../views/components';
import { page } from '../views/layout';

const importexport = new Hono<AppEnv>();

importexport.get('/import', async (c) => {
  const [libs, backfillable] = await Promise.all([listLibraries(c.env.DB), countBackfillable(c.env.DB)]);
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
          <a href="/export.csv" role="button">
            Export everything as CSV
          </a>
        </div>
      </div>
      <p class="muted">
        Export your libib collection or Goodreads library as CSV, drop it here — the format is
        auto-detected. The file is parsed in your browser and uploaded in small batches; columns we
        don't recognize are kept losslessly in each item's details. Goodreads rows that match a book
        already on your shelves (by ISBN, then title + author) merge their rating, review, shelves,
        and read date onto it — Goodreads wins. The rest are added as “Not owned” reading-log
        entries.
      </p>
      <form id="import-form" onsubmit="return false" class="panel form-card">
        <label>
          CSV file
          <input type="file" id="import-file" accept=".csv,text/csv" required />
        </label>
        <div class="grid">
          <label>
            Into library
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
        {backfillable > 0 ? (
          <>
            <p class="muted">
              {backfillable} {backfillable === 1 ? 'item is' : 'items are'} missing cover art or a
              description. Backfill matches by ISBN/UPC first (Open Library, Google Books, iTunes;
              Discogs and the Cover Art Archive for music barcodes), then by title and author — a
              different edition's cover may be used, but never a different book's: covers are stored
              only when the source's title or identifiers agree with the item. The matching record also
              fills an empty description, publisher, year or page count — never what you've written
              yourself. Re-run any time.
            </p>
            <button type="button" id="backfill-run">
              Backfill {backfillable} {backfillable === 1 ? 'item' : 'items'}
            </button>
            <div id="backfill-status" class="prewrap muted mono" aria-live="polite"></div>
          </>
        ) : (
          <p class="muted">Every item already has cover art. Import more and come back.</p>
        )}
      </section>
      <script src="/import.js" defer></script>
    </>,
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
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    return c.json({ error: `Send at most ${MAX_ROWS_PER_REQUEST} rows per request.` }, 400);
  }
  const libraryId = Number(body.libraryId);
  if (!Number.isInteger(libraryId)) return c.json({ error: 'libraryId required.' }, 400);

  const opts: ImportOptions = {
    defaultType: (MEDIA_TYPES as readonly string[]).includes(body.defaultType ?? '')
      ? (body.defaultType as MediaType)
      : 'book',
    musicAsVinyl: body.musicAsVinyl !== false,
  };

  const isGoodreads = rows.length > 0 && looksLikeGoodreads(Object.keys(rows[0]!));

  const mapped = [];
  let skipped = 0;
  for (const row of rows) {
    const m = isGoodreads ? mapGoodreadsRow(row) : mapLibibRow(row, opts);
    if (m) mapped.push(m);
    else skipped++;
  }

  const userId = c.get('user').id;
  const withOwners = mapped.map((m) => ({ item: { ...m.item, libraryId, addedBy: userId }, tags: m.tags }));

  if (body.dryRun) {
    const byType: Record<string, number> = {};
    for (const m of mapped) byType[m.item.mediaType ?? 'book'] = (byType[m.item.mediaType ?? 'book'] ?? 0) + 1;
    const match = isGoodreads ? await mergeImportItems(c.env.DB, withOwners, true) : null;
    return c.json({
      format: isGoodreads ? 'goodreads' : 'libib',
      mapped: mapped.length,
      skipped,
      byType,
      merged: match?.merged ?? 0,
      fresh: match?.inserted ?? 0,
      sample: mapped.slice(0, 5).map((m) => ({
        title: m.item.title,
        mediaType: m.item.mediaType,
        creators: m.item.creators,
        tags: m.tags,
      })),
    });
  }

  if (isGoodreads) {
    const { inserted, merged } = await mergeImportItems(c.env.DB, withOwners);
    return c.json({ inserted, merged, skipped });
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

importexport.get('/export.csv', async (c) => {
  const libraryId = Number.parseInt(c.req.query('library') ?? '', 10);
  const scope = Number.isInteger(libraryId) ? libraryId : undefined;
  const libs = await listLibraries(c.env.DB);
  const libNames = new Map(libs.map((l) => [l.id, l.name]));

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const d1 = c.env.DB;

  c.executionCtx.waitUntil(
    (async () => {
      const writer = writable.getWriter();
      try {
        await writer.write(encoder.encode(csvLine([...EXPORT_COLUMNS])));
        const PAGE = 500;
        for (let offset = 0; ; offset += PAGE) {
          const items = await pageItems(d1, { libraryId: scope, offset, limit: PAGE });
          if (!items.length) break;
          const tagMap = await tagsForItems(d1, items.map((i) => i.id));
          let chunk = '';
          for (const item of items) {
            chunk += itemToCsvLine(item, libNames.get(item.libraryId) ?? '', tagMap.get(item.id) ?? []);
          }
          await writer.write(encoder.encode(chunk));
          if (items.length < PAGE) break;
        }
      } finally {
        await writer.close().catch(() => {});
      }
    })(),
  );

  const today = new Date().toISOString().slice(0, 10);
  return new Response(readable, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="nalanda-export-${today}.csv"`,
    },
  });
});

export default importexport;
