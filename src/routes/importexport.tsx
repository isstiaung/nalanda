import { Hono } from 'hono';
import type { MediaType } from '../db/schema';
import { MEDIA_TYPES } from '../db/schema';
import { importItems, listLibraries, pageItems, tagsForItems } from '../db/queries';
import type { AppEnv } from '../env';
import { csvLine, EXPORT_COLUMNS, itemToCsvLine, mapLibibRow, type ImportOptions } from '../lib/csv';
import { MEDIA_LABEL } from '../views/components';
import { page } from '../views/layout';

const importexport = new Hono<AppEnv>();

importexport.get('/import', async (c) => {
  const libs = await listLibraries(c.env.DB);
  return page(
    c,
    'Import',
    <>
      <h1>Import from libib</h1>
      <p class="muted">
        Export your libib collection as CSV, drop it here. The file is parsed in your browser and uploaded in
        small batches; columns we don't recognize are kept losslessly in each item's details.
      </p>
      <form id="import-form" onsubmit="return false">
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
      <div id="import-status" class="prewrap muted" aria-live="polite"></div>
      <p>
        <a href="/export.csv" role="button" class="secondary">
          Export everything as CSV
        </a>
      </p>
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

  const mapped = [];
  let skipped = 0;
  for (const row of rows) {
    const m = mapLibibRow(row, opts);
    if (m) mapped.push(m);
    else skipped++;
  }

  if (body.dryRun) {
    const byType: Record<string, number> = {};
    for (const m of mapped) byType[m.item.mediaType ?? 'book'] = (byType[m.item.mediaType ?? 'book'] ?? 0) + 1;
    return c.json({
      mapped: mapped.length,
      skipped,
      byType,
      sample: mapped.slice(0, 5).map((m) => ({
        title: m.item.title,
        mediaType: m.item.mediaType,
        creators: m.item.creators,
        tags: m.tags,
      })),
    });
  }

  const userId = c.get('user').id;
  const inserted = await importItems(
    c.env.DB,
    mapped.map((m) => ({ item: { ...m.item, libraryId, addedBy: userId }, tags: m.tags })),
  );
  return c.json({ inserted, skipped });
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
