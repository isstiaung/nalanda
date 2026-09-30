// Series pages (ARCH.md §16 #52): every series the catalog holds, and one series' volumes in order, with the numbers
// missing and the signed-in member's next one. Signed-in only — share pages show an item's series name and number,
// nothing here.
import { Hono, type Context } from 'hono';
import { getSeries, listSeries, seriesWithVolumes, updateSeries } from '../db/queries';
import type { AppEnv } from '../env';
import { cleanSeriesName, countRanges, formatRanges, missingNumbers, nextUp, parseSeriesTotal } from '../lib/series';
import { page } from '../views/layout';
import { GapsLine, NextUpLine, positionLabel, VolumeLedger } from '../views/series';

const series = new Hono<AppEnv>();

series.get('/series', async (c) => {
  const all = await listSeries(c.env.DB);
  return page(
    c,
    'Series',
    <>
      <div class="page-head">
        <div>
          <h1>Series</h1>
          <span class="sub">{all.length} SERIES</span>
        </div>
      </div>
      {all.length ? (
        <ol class="series-list">
          {all.map((s) => {
            const missing = missingNumbers(s.numbers, s.total);
            const gaps = countRanges(missing);
            return (
              <li>
                <a href={`/series/${s.id}`} class="series-name">
                  {s.name}
                </a>
                <span class="mono muted">
                  {s.volumes} {s.volumes === 1 ? 'volume' : 'volumes'}
                  {s.total ? ` of ${s.total}` : ''}
                </span>
                {gaps ? (
                  <span class="pill ghost" title={`Missing ${formatRanges(missing)}`}>
                    {gaps} missing
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p class="muted">No series yet. Give a book its series on its edit form — or add one Open Library knows.</p>
      )}
    </>,
  );
});

/** A series' page. `error` says why a change to it was refused. */
async function seriesPage(c: Context<AppEnv>, id: number, error?: string, sent?: { name: string; total: string }) {
  const found = await seriesWithVolumes(c.env.DB, id, c.get('user').id);
  if (!found) return c.notFound();
  const { series: s, volumes } = found;
  const missing = missingNumbers(volumes.map((v) => v.seriesNumber), s.total);
  const numbered = volumes.filter((v) => v.seriesNumber !== null).length;
  const finished = volumes.filter((v) => v.finishedByMe).length;
  if (error) c.status(400);
  return page(
    c,
    s.name,
    <>
      <div class="page-head">
        <div>
          <h1>{s.name}</h1>
          <span class="sub">
            SERIES · {volumes.length} {volumes.length === 1 ? 'VOLUME' : 'VOLUMES'}
            {s.total ? ` OF ${s.total}` : ''}
            {finished ? ` · ${finished} FINISHED BY YOU` : ''}
          </span>
        </div>
      </div>
      <div class="panel series-panel">
        <NextUpLine next={nextUp(volumes, s.total)} />
        <GapsLine missing={missing} total={s.total} numbered={numbered} unnumbered={volumes.length - numbered} />
      </div>
      <VolumeLedger volumes={volumes} missing={missing} />
      <details class="series-edit" open={!!error}>
        <summary>Edit series</summary>
        {error ? <p class="error">{error}</p> : null}
        <form method="post" action={`/series/${s.id}`} class="form-card">
          <div class="grid">
            <label>
              Name <small>(a name another series has merges the two)</small>
              <input name="name" required value={sent?.name ?? s.name} />
            </label>
            <label>
              Volumes in the series <small>(blank if not known)</small>
              <input name="total" value={sent?.total ?? (s.total ? String(s.total) : '')} inputmode="numeric" pattern="\d{1,4}" />
            </label>
          </div>
          <button type="submit">Save series</button>
        </form>
      </details>
    </>,
  );
}

series.get('/series/:id', (c) => {
  const raw = c.req.param('id');
  return /^\d{1,15}$/.test(raw) ? seriesPage(c, Number(raw)) : c.notFound();
});

/** Renames a series and sets its total — any member, as any catalog edit is. */
series.post('/series/:id', async (c) => {
  const raw = c.req.param('id');
  if (!/^\d{1,15}$/.test(raw)) return c.notFound();
  const id = Number(raw);
  if (!(await getSeries(c.env.DB, id))) return c.notFound();
  const body = await c.req.parseBody();
  const sent = { name: String(body['name'] ?? ''), total: String(body['total'] ?? '') };
  const name = cleanSeriesName(sent.name);
  const total = parseSeriesTotal(sent.total);
  if (!name) return seriesPage(c, id, 'A series needs a name. To take a book out of it, clear the series on the book.', sent);
  if (total === undefined) return seriesPage(c, id, 'The number of volumes is a whole number from 1 to 9999, or blank.', sent);
  const now = await updateSeries(c.env.DB, id, name, total);
  return c.redirect(`/series/${now ?? id}`);
});

export default series;
