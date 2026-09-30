// A series' volumes, what's missing and what's next (ARCH.md §16 #52). In-app only: share pages show an item's series
// name and number, never these — the gaps are about the household's shelves, "next up" about one member's reading.
import type { FC } from 'hono/jsx';
import type { Series } from '../db/schema';
import {
  countRanges,
  formatRanges,
  formatSeriesNumber,
  inSeriesOrder,
  missingNumbers,
  nextUp,
  type NextUp,
  type NumberRange,
  type SeriesVolume,
} from '../lib/series';
import { NotOwnedPill } from './components';

export type VolumeView = SeriesVolume & { creators: string | null };

/** "#3 of 9", "#3", "of 9", or nothing. */
export const positionLabel = (number: number | null, total: number | null): string =>
  [number !== null ? `#${formatSeriesNumber(number)}` : '', total ? `of ${total}` : ''].filter(Boolean).join(' ');

/** Missing runs longer than this fold into one "#6–40" mark on the strip, so a long gap can't flood it. */
const FOLD_RUN = 3;

type StripMark =
  | { kind: 'held'; number: number; id: number; current: boolean; finished: boolean }
  | { kind: 'missing'; range: NumberRange };

/**
 * The series as a row of numbers: each held number (one mark however many editions of it), and the missing ones
 * between and after, in order. Unnumbered volumes aren't on it.
 */
function stripMarks(volumes: SeriesVolume[], missing: NumberRange[], currentId: number | null): StripMark[] {
  const marks: Array<StripMark & { at: number }> = [];
  const seen = new Set<number>();
  for (const v of inSeriesOrder(volumes)) {
    if (v.seriesNumber === null || seen.has(v.seriesNumber)) continue;
    seen.add(v.seriesNumber);
    const same = volumes.filter((x) => x.seriesNumber === v.seriesNumber);
    const current = same.find((x) => x.id === currentId);
    marks.push({
      kind: 'held',
      at: v.seriesNumber,
      number: v.seriesNumber,
      id: current?.id ?? v.id,
      current: !!current,
      finished: same.some((x) => x.finishedByMe),
    });
  }
  for (const [a, b] of missing) {
    if (b - a + 1 > FOLD_RUN) marks.push({ kind: 'missing', at: a, range: [a, b] });
    else for (let n = a; n <= b; n++) marks.push({ kind: 'missing', at: n, range: [n, n] });
  }
  return marks.sort((x, y) => x.at - y.at);
}

export const SeriesStrip: FC<{ volumes: SeriesVolume[]; missing: NumberRange[]; currentId?: number | null }> = ({
  volumes,
  missing,
  currentId = null,
}) => {
  const marks = stripMarks(volumes, missing, currentId);
  if (!marks.length) return null;
  return (
    <ol class="series-strip" aria-label="Volumes by number">
      {marks.map((m) =>
        m.kind === 'held' ? (
          <li>
            <a
              href={`/items/${m.id}`}
              class={`vol${m.current ? ' current' : ''}${m.finished ? ' finished' : ''}`}
              aria-current={m.current ? 'page' : undefined}
              title={m.finished ? 'You finished this one' : undefined}
            >
              {formatSeriesNumber(m.number)}
            </a>
          </li>
        ) : (
          <li>
            <span class="vol missing" title="Not in the catalog">
              {m.range[0] === m.range[1] ? m.range[0] : `${m.range[0]}–${m.range[1]}`}
            </span>
          </li>
        ),
      )}
    </ol>
  );
};

/** "Next up for you", from the member's own reads. */
export const NextUpLine: FC<{ next: NextUp }> = ({ next }) => {
  if (next.kind === 'none') return null;
  return (
    <p class="next-up">
      <span class="eyebrow">Next up for you</span>{' '}
      {next.kind === 'volume' ? (
        <>
          <a href={`/items/${next.volume.id}`}>
            <span class="mono">#{formatSeriesNumber(next.volume.seriesNumber!)}</span> {next.volume.title}
          </a>
          {next.volume.readingByMe ? <span class="pill progress">Reading</span> : null}
          {next.volume.copies === 0 ? <NotOwnedPill /> : null}
          {next.skipped.length ? (
            <small class="muted next-skipped">
              {formatRanges(next.skipped)} {countRanges(next.skipped) === 1 ? 'comes' : 'come'} first — not in the catalog
            </small>
          ) : null}
        </>
      ) : next.kind === 'missing' ? (
        <span>
          <span class="mono">#{next.number}</span> <span class="muted">— not in the catalog</span>
        </span>
      ) : (
        <span class="muted">You've finished every numbered volume here.</span>
      )}
    </p>
  );
};

/** The gaps, said plainly: "Missing #4, #6–8", or that the numbers run unbroken. */
export const GapsLine: FC<{ missing: NumberRange[]; total: number | null; numbered: number; unnumbered: number }> = ({
  missing,
  total,
  numbered,
  unnumbered,
}) => (
  <p class="series-gaps">
    {missing.length ? (
      <>
        <span class="eyebrow">Missing</span> <span class="mono">{formatRanges(missing)}</span>
        {total === null ? <small class="muted"> · set the series' total to see any after the last</small> : null}
      </>
    ) : numbered ? (
      <span class="muted">{total ? `Every number from 1 to ${total} is here.` : 'No gaps in the numbers held.'}</span>
    ) : null}
    {unnumbered ? (
      <small class="muted">
        {' '}
        · {unnumbered} {unnumbered === 1 ? 'volume has' : 'volumes have'} no number
      </small>
    ) : null}
  </p>
);

/** The item page's series section: where this volume sits, what's missing, and the viewer's next one. */
export const SeriesSection: FC<{ series: Series; volumes: SeriesVolume[]; currentId: number }> = ({ series, volumes, currentId }) => {
  const missing = missingNumbers(volumes.map((v) => v.seriesNumber), series.total);
  const current = volumes.find((v) => v.id === currentId);
  const next = nextUp(volumes, series.total);
  return (
    <section class="detail-section series-section" aria-labelledby="series-heading">
      <p class="eyebrow" id="series-heading">
        Series
      </p>
      <p class="series-title">
        <a href={`/series/${series.id}`}>{series.name}</a>{' '}
        <span class="mono muted">{positionLabel(current?.seriesNumber ?? null, series.total)}</span>
      </p>
      <SeriesStrip volumes={volumes} missing={missing} currentId={currentId} />
      {missing.length ? (
        <p class="series-gaps">
          <span class="eyebrow">Missing</span> <span class="mono">{formatRanges(missing)}</span>
        </p>
      ) : null}
      <NextUpLine next={next} />
    </section>
  );
};

/** The series page's ledger: every volume in order, with the missing numbers in their places. */
export const VolumeLedger: FC<{ volumes: VolumeView[]; missing: NumberRange[] }> = ({ volumes, missing }) => {
  type Row = { at: number; volume?: VolumeView; range?: NumberRange };
  const rows: Row[] = [
    ...inSeriesOrder(volumes).map((v, i) => ({ at: v.seriesNumber ?? 1e9 + i, volume: v })), // unnumbered last, by title
    ...missing.map((range) => ({ at: range[0], range })),
  ].sort((a, b) => a.at - b.at);
  return (
    <ol class="volume-ledger">
      {rows.map((r) =>
        r.volume ? (
          <li class={r.volume.finishedByMe ? 'finished' : undefined}>
            <span class="vol-no mono">{r.volume.seriesNumber !== null ? `#${formatSeriesNumber(r.volume.seriesNumber)}` : '—'}</span>
            <span class="vol-body">
              <a href={`/items/${r.volume.id}`} class="vol-title">
                {r.volume.title}
              </a>
              {r.volume.creators ? <small class="muted">{r.volume.creators}</small> : null}
            </span>
            <span class="vol-state">
              {r.volume.finishedByMe ? <span class="pill done">Finished</span> : null}
              {r.volume.readingByMe ? <span class="pill progress">Reading</span> : null}
              {r.volume.copies === 0 ? <NotOwnedPill /> : null}
            </span>
          </li>
        ) : (
          <li class="gap">
            <span class="vol-no mono">
              #{r.range![0] === r.range![1] ? r.range![0] : `${r.range![0]}–${r.range![1]}`}
            </span>
            <span class="vol-body muted">Not in the catalog</span>
          </li>
        ),
      )}
    </ol>
  );
};
