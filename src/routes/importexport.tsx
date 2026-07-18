import { Hono } from 'hono';
import type { MediaType } from '../db/schema';
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
import { findCover } from '../metadata';
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
          <button type="button" id="import-preview">
            Preview
          </button>
          <button type="button" id="import-run" disabled>
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
              {backfillable} {backfillable === 1 ? 'item is' : 'items are'} missing cover art. Backfill
              matches by ISBN/UPC first (Open Library, Google Books, iTunes; Discogs and the Cover Art
              Archive for music barcodes), then by title and author — a different edition's cover may be
              used, but never a different book's: covers are stored only when the source's title or
              identifiers agree with the item. Only coverless items are touched; re-run any time.
            </p>
            <button type="button" id="backfill-run">
              Backfill {backfillable} {backfillable === 1 ? 'cover' : 'covers'}
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
const BACKFILL_BATCH = 4;

importexport.post('/api/backfill-covers', async (c) => {
  const body = await c.req.json<{ after?: number }>().catch(() => ({}) as { after?: number });
  const after = Number.isInteger(body.after) && body.after! >= 0 ? body.after! : 0;

  const batch = await nextBackfillable(c.env.DB, after, BACKFILL_BATCH);
  let found = 0;
  let byTitle = 0;
  for (const item of batch) {
    // sequential on purpose: polite to providers, predictable subrequest count
    const result = await findCover(
      c.env,
      {
        barcode: item.isbn13 ?? item.isbn10Upc,
        title: item.title,
        creators: item.creators,
        mediaType: item.mediaType,
      },
      (url) => storeCover(c.env.COVERS, url),
    );
    if (result) {
      await updateItem(c.env.DB, item.id, { coverKey: result.key });
      found++;
      if (result.method === 'title') byTitle++;
    }
  }

  const lastId = batch.length ? batch[batch.length - 1]!.id : after;
  return c.json({ tried: batch.length, found, byTitle, lastId, done: batch.length < BACKFILL_BATCH });
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
