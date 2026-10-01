// Series pages (ARCH.md §16 #52): every series the catalog holds, and one series' volumes in order, with the numbers
// missing and the signed-in member's next one. Signed-in only — share pages show an item's series name and number,
// nothing here.
import { Hono, type Context } from 'hono';
import type { Candidate } from '../metadata/provider';
import { olSeriesWorks } from '../metadata/openlibrary';
import { CandidateCard } from '../views/components';
import { catalogMatches, getSeries, listLibraries, listSeries, seriesWithVolumes, shelfFlags, shelfForType, updateSeries } from '../db/queries';
import type { AppEnv } from '../env';
import { cleanSeriesName, countRanges, formatRanges, inRanges, missingNumbers, nextUp, parseSeriesTotal, seriesKey } from '../lib/series';
import { page } from '../views/layout';
import { GapsLine, NextUpLine, positionLabel, VolumeLedger } from '../views/series';
import { writerOf } from './items';

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

// ---------- the gaps, from Open Library (ARCH.md §16 #79) ----------

const FIND_TTL_MS = 24 * 60 * 60_000;
/** How many works one look-up asks Open Library for (olSeriesWorks' default): enough for most series, not every omnibus. */
const FIND_LIMIT = 40;
const FIND_MAX = 200;
/** Per isolate, by series key: a day's worth of answers, so a household looking twice asks Open Library once. */
const findCache = new Map<string, { at: number; works: Array<{ candidate: Candidate; position: number | null }> }>();

/** A series' works from the cache or Open Library; null when Open Library didn't answer, which is never cached. */
async function seriesWorksOf(name: string) {
  const key = seriesKey(name);
  const hit = findCache.get(key);
  if (hit && hit.at > Date.now() - FIND_TTL_MS) return hit.works;
  const works = await olSeriesWorks(name);
  if (works === null) return null;
  if (findCache.size >= FIND_MAX) {
    const oldest = findCache.keys().next().value;
    if (oldest !== undefined) findCache.delete(oldest);
  }
  findCache.set(key, { at: Date.now(), works });
  return works;
}

/** For tests: forget every series looked up in this isolate. */
export function clearSeriesFindCache(): void {
  findCache.clear();
}

/** What a look-up found, sorted against the household's own numbering, which always wins. */
type Found =
  | {
      gaps: Array<{ candidate: Candidate; held: number | null }>; // a number the series is missing
      elsewhere: Array<{ candidate: Candidate; held: number | null }>; // no number Open Library knows, or one past the total
      here: number; // works whose number the household already holds — or which are in the catalog by ISBN or title
    }
  | { failed: true };

/** A series' page. `error` says why a change to it was refused; `found` is a look-up's answer (§16 #79). */
async function seriesPage(c: Context<AppEnv>, id: number, error?: string, sent?: { name: string; total: string }, found?: Found) {
  const foundSeries = await seriesWithVolumes(c.env.DB, id, c.get('user').id);
  if (!foundSeries) return c.notFound();
  const found_ = foundSeries;
  const { series: s } = found_;
  const [libs, shelfFor] = found ? await Promise.all([listLibraries(c.env.DB), shelfForType(c.env.DB)]) : [[], {}];
  const foundBlock = found && 'failed' in found ? (
    <section id="series-found" class="detail-section">
      <p class="error" role="alert">
        Open Library didn’t answer — try again in a moment.
      </p>
    </section>
  ) : found ? (
    <section id="series-found" class="detail-section" aria-labelledby="series-found-head">
      <p class="eyebrow" id="series-found-head">
        From Open Library: {found.gaps.length} {found.gaps.length === 1 ? 'volume fills' : 'volumes fill'} a gap
        {found.elsewhere.length ? ` · ${found.elsewhere.length} with no number it knows` : ''}
        {found.here ? ` · ${found.here} already here` : ''}
      </p>
      {found.gaps.length + found.elsewhere.length === 0 ? (
        <p class="muted">
          Open Library lists nothing for this series that isn’t here already — or doesn’t know the series by this name. Your
          numbering stands either way.
        </p>
      ) : null}
      {found.gaps.map(({ candidate, held }) => (
        <CandidateCard candidate={candidate} libraries={libs} inCatalog={held} shelfFor={shelfFor} />
      ))}
      {found.elsewhere.length ? <p class="eyebrow">Without a number Open Library knows</p> : null}
      {found.elsewhere.map(({ candidate, held }) => (
        <CandidateCard candidate={candidate} libraries={libs} inCatalog={held} shelfFor={shelfFor} />
      ))}
      <p class="muted form-note">
        Each is offered with this series’ name and the number Open Library gives it; what you have numbered yourself is
        never changed, and a number you already hold isn’t offered again. Open Library listed {found.gaps.length + found.elsewhere.length + found.here}{' '}
        {found.gaps.length + found.elsewhere.length + found.here === 1 ? 'work' : 'works'} for this series, of at most {FIND_LIMIT} asked for: a long series may be missing some.
      </p>
    </section>
  ) : null;
  // the "Wanted" badge beside "Not owned", as on a shelf (§16 #53) — one call
  const { wanted } = await shelfFlags(c.env.DB, found_.volumes.map((v) => v.id));
  const volumes = found_.volumes.map((v) => ({ ...v, wanted: wanted.has(v.id) }));
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
        {/* one Open Library request, on a click, never in the background (§16 #79); a GET — no side effect, so the
            result can be reloaded and come back to */}
        <form method="get" action={`/series/${s.id}/find`} class="inline-form series-find">
          <button type="submit" class="btn">
            {found ? 'Looked up on Open Library' : 'Find the missing volumes on Open Library'}
          </button>
        </form>
      </div>
      <VolumeLedger volumes={volumes} missing={missing} />
      {foundBlock}
      <details class="series-edit" open={!!error}>
        <summary>Edit series</summary>
        {error ? <p class="error" role="alert">{error}</p> : null}
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

/**
 * Looks the series up on Open Library (§16 #79): its works, sorted against the household's own numbers — a number
 * the series is missing is offered to add or want with this series' name and that number filled in; a number held
 * already, or a work in the catalog by ISBN or title, counts as here; a work without a number it knows is listed
 * apart. The household's name, numbers and total are never changed.
 */
series.get('/series/:id/find', async (c) => {
  const raw = c.req.param('id');
  if (!/^\d{1,15}$/.test(raw)) return c.notFound();
  const id = Number(raw);
  const own = await seriesWithVolumes(c.env.DB, id, c.get('user').id);
  if (!own) return c.notFound();
  const works = await seriesWorksOf(own.series.name);
  if (works === null) return seriesPage(c, id, undefined, undefined, { failed: true });
  const missing = missingNumbers(own.volumes.map((v) => v.seriesNumber), own.series.total);
  const heldNumbers = new Set(own.volumes.map((v) => v.seriesNumber).filter((n): n is number => n !== null));
  const byIsbn = await catalogMatches(c.env.DB, works.map((w) => w.candidate));
  const titles = new Map(own.volumes.map((v) => [v.title.toLowerCase().trim(), v.id]));
  const found: Found = { gaps: [], elsewhere: [], here: 0 };
  works.forEach(({ candidate, position }, i) => {
    const held = byIsbn[i] ?? titles.get(candidate.title.toLowerCase().trim()) ?? null;
    // the household's series name on every offer, with the number Open Library gives — never the other way round
    const offered: Candidate = { ...candidate, series: { name: own.series.name, number: position } };
    if (held !== null || (position !== null && heldNumbers.has(position))) found.here++;
    else if (position !== null && inRanges(position, missing)) found.gaps.push({ candidate: offered, held });
    else found.elsewhere.push({ candidate: offered, held });
  });
  return seriesPage(c, id, undefined, undefined, found);
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
  const now = await updateSeries(c.env.DB, id, name, total, writerOf(c)); // a merge moves volumes: their history names who (§16 #84)
  return c.redirect(`/series/${now ?? id}`);
});

export default series;
