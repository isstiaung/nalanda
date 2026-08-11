import type { FC } from 'hono/jsx';
import type { Item, ItemStatus, Library, MediaType, Share } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import { parseDetails } from '../lib/share';
import type { Candidate } from '../metadata';

export const MEDIA_LABEL: Record<MediaType, string> = {
  book: 'Book',
  boardgame: 'Board game',
  vinyl: 'Vinyl',
  movie: 'Movie',
  music: 'Music',
  videogame: 'Video game',
  other: 'Other',
};

/** Lowercase count nouns for inline breakdowns: "12 books · 3 board games · 5 vinyl". */
export const MEDIA_PLURAL: Record<MediaType, string> = {
  book: 'books',
  boardgame: 'board games',
  vinyl: 'vinyl',
  movie: 'movies',
  music: 'music',
  videogame: 'video games',
  other: 'other',
};

export const MEDIA_ICON: Record<MediaType, string> = {
  book: '📖',
  boardgame: '🎲',
  vinyl: '💿',
  movie: '🎬',
  music: '🎵',
  videogame: '🎮',
  other: '📦',
};

export const STATUS_LABEL: Record<ItemStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  abandoned: 'Abandoned',
};

/** "Board games · In progress · Owned" — how a share view's captured filters read. */
export function shareScopeLabel(v: Share): string {
  const parts: string[] = [];
  if (v.mediaType) parts.push(MEDIA_LABEL[v.mediaType]);
  if (v.status) parts.push(STATUS_LABEL[v.status]);
  if (v.owned !== null) parts.push(v.owned ? 'Owned' : 'Not owned');
  return parts.length ? parts.join(' · ') : 'Whole shelf';
}

const STATUS_PILL_CLASS: Record<ItemStatus, string> = {
  not_started: 'pill',
  in_progress: 'pill progress',
  completed: 'pill done',
  abandoned: 'pill dropped',
};

/** rating is stored as half-stars 0–10, rendered as ★★★½ */
export function stars(rating: number | null | undefined): string {
  if (!rating) return '';
  return '★'.repeat(Math.floor(rating / 2)) + (rating % 2 ? '½' : '');
}

/** The registrar's accession number: № 000142 */
export function accNo(id: number): string {
  return `№ ${String(id).padStart(6, '0')}`;
}

/** First 4-digit year in a fuzzy published string, or the string itself if short. */
export function yearOf(published: string | null): string {
  if (!published) return '';
  const m = published.match(/\d{4}/);
  return m ? m[0] : published;
}

export const StatusPill: FC<{ status: ItemStatus }> = ({ status }) => (
  <span class={STATUS_PILL_CLASS[status]}>{STATUS_LABEL[status]}</span>
);

/** copies = 0: in the ledger, not on the shelf — a reading-log entry. */
export const NotOwnedPill: FC = () => <span class="pill ghost">Not owned</span>;

/** Same as NotOwnedPill but clickable — one tap sets copies to 1 in place (htmx),
 *  swapping itself for a MarkNotOwnedButton. No edit form. Authenticated views
 *  only; share pages keep the plain NotOwnedPill. */
export const MarkOwnedButton: FC<{ id: number }> = ({ id }) => (
  <button
    type="button"
    class="pill ghost pill-btn"
    hx-post={`/items/${id}/mark-owned`}
    hx-swap="outerHTML"
    title="Mark as owned"
  >
    Not owned
  </button>
);

/** The reverse of MarkOwnedButton — one tap sets copies to 0 (a reading-log
 *  entry, same as the "Log — not owned" add action), swapping itself back for
 *  a MarkOwnedButton. Any copy count above 1 is not preserved by this quick
 *  toggle — same as MarkOwnedButton always landing on exactly 1, adjusting a
 *  specific copy count is still an edit-form job. Reuses the "done" treatment
 *  (same indigo as a Completed status pill) as the positive/success color —
 *  the palette has no green (CLAUDE.md). */
export const MarkNotOwnedButton: FC<{ id: number }> = ({ id }) => (
  <button
    type="button"
    class="pill done pill-btn"
    hx-post={`/items/${id}/mark-not-owned`}
    hx-swap="outerHTML"
    title="Mark as not owned"
  >
    Owned
  </button>
);

/** The Holding column/row: whichever toggle button matches current copies. */
export const HoldingPill: FC<{ item: Item }> = ({ item }) =>
  item.copies > 0 ? <MarkNotOwnedButton id={item.id} /> : <MarkOwnedButton id={item.id} />;

export const Cover: FC<{ coverKey: string | null; title: string; mediaType: MediaType }> = ({
  coverKey,
  title,
  mediaType,
}) =>
  coverKey ? (
    <img class="cover-img" src={`/covers/${coverKey}`} alt={`Cover of ${title}`} loading="lazy" />
  ) : (
    <div class="cover-fallback" aria-hidden="true">
      {MEDIA_ICON[mediaType]}
    </div>
  );

export const ItemCard: FC<{ item: Item; onLoan?: boolean; href?: string }> = ({ item, onLoan, href }) => (
  <a href={href ?? `/items/${item.id}`} class="item-card">
    <div class="item-cover">
      <Cover coverKey={item.coverKey} title={item.title} mediaType={item.mediaType} />
    </div>
    <div class="item-meta">
      <strong>{item.title}</strong>
      {item.creators ? <small>{item.creators}</small> : null}
      <span class="mline">
        <small class="acc-no">{accNo(item.id)}</small>
        {item.rating ? <span class="rating">{stars(item.rating)}</span> : null}
        {item.copies === 0 ? <NotOwnedPill /> : null}
        {onLoan ? <span class="pill lent">Lent</span> : null}
      </span>
    </div>
  </a>
);

export const ItemGrid: FC<{ items: Item[]; onLoanIds?: Set<number> }> = ({ items, onLoanIds }) => (
  <div class="item-grid">
    {items.map((item) => (
      <ItemCard item={item} onLoan={onLoanIds?.has(item.id)} />
    ))}
  </div>
);

/** The default library view: a proper registry table. */
export const ItemTable: FC<{
  items: Item[];
  onLoanIds?: Set<number>;
  tagsMap?: Map<number, string[]>;
  libraryNames?: Map<number, string>;
}> = ({ items, onLoanIds, tagsMap, libraryNames }) => (
  <div class="data-table">
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Type</th>
          {libraryNames ? <th class="hide-sm">Shelf</th> : null}
          <th class="hide-sm">Year</th>
          <th>Rating</th>
          <th>Status</th>
          <th>Holding</th>
          {tagsMap ? <th class="hide-sm">Tags</th> : null}
          <th class="hide-sm">№</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr>
            <td>
              <span class="cell-title">
                {item.coverKey ? (
                  <img class="thumb" src={`/covers/${item.coverKey}`} alt="" loading="lazy" />
                ) : (
                  <span class="thumb-fallback" aria-hidden="true">
                    {MEDIA_ICON[item.mediaType]}
                  </span>
                )}
                <span class="t">
                  <a href={`/items/${item.id}`} title={item.title}>
                    {item.title}
                  </a>
                  {item.creators ? <small>{item.creators}</small> : null}
                </span>
              </span>
            </td>
            <td class="num">{MEDIA_LABEL[item.mediaType]}</td>
            {libraryNames ? <td class="num hide-sm">{libraryNames.get(item.libraryId) ?? ''}</td> : null}
            <td class="num hide-sm">{yearOf(item.published)}</td>
            <td>{item.rating ? <span class="rating">{stars(item.rating)}</span> : <span class="muted">—</span>}</td>
            <td>
              <StatusPill status={item.status} />{' '}
              {onLoanIds?.has(item.id) ? <span class="pill lent">Lent</span> : null}
            </td>
            <td>
              <HoldingPill item={item} />
            </td>
            {tagsMap ? (
              <td class="hide-sm">
                {(tagsMap.get(item.id) ?? []).slice(0, 3).map((t) => (
                  <a href={`/tags/${encodeURIComponent(t)}`} class="tag">
                    {t}
                  </a>
                ))}
              </td>
            ) : null}
            <td class="hide-sm">
              <span class="acc-no">{accNo(item.id)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const Stat: FC<{ n: number | string; label: string; warn?: boolean; detail?: string }> = ({
  n,
  label,
  warn,
  detail,
}) => (
  <div class="stat">
    <div class={warn ? 'stat-n warn' : 'stat-n'}>{n}</div>
    <div class="stat-label">{label}</div>
    {detail ? <div class="stat-detail">{detail}</div> : null}
  </div>
);

const RatingSelect: FC<{ value: number | null | undefined }> = ({ value }) => (
  <select name="rating">
    <option value="" selected={!value}>
      No rating
    </option>
    {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
      <option value={String(n)} selected={value === n}>
        {stars(n)} ({n / 2})
      </option>
    ))}
  </select>
);

/** Shared by manual add and edit. */
export const ItemForm: FC<{
  libraries: Library[];
  action: string;
  submitLabel: string;
  item?: Item | null;
  tags?: string[];
  selectedLibraryId?: number;
}> = ({ libraries, action, submitLabel, item, tags, selectedLibraryId }) => {
  // reviewed_in gets its own field; the advanced JSON box shows everything else
  const details = parseDetails(item?.details);
  const reviewedIn = Array.isArray(details['reviewed_in']) ? (details['reviewed_in'] as string[]) : [];
  delete details['reviewed_in'];
  return (
  <form method="post" action={action} class="form-card">
    <div class="grid">
      <label>
        Shelf
        <select name="libraryId" required>
          {libraries.map((l) => (
            <option value={String(l.id)} selected={(item?.libraryId ?? selectedLibraryId) === l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Type
        <select name="mediaType">
          {MEDIA_TYPES.map((t) => (
            <option value={t} selected={(item?.mediaType ?? 'book') === t}>
              {MEDIA_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
    </div>
    <label>
      Title
      <input name="title" required value={item?.title ?? ''} />
    </label>
    <label>
      Creators <small>(authors / designers / artists)</small>
      <input name="creators" value={item?.creators ?? ''} />
    </label>
    <div class="grid">
      <label>
        ISBN-13 / EAN
        <input name="isbn13" value={item?.isbn13 ?? ''} inputmode="numeric" />
      </label>
      <label>
        ISBN-10 / UPC
        <input name="isbn10Upc" value={item?.isbn10Upc ?? ''} />
      </label>
    </div>
    <div class="grid">
      <label>
        Publisher / label
        <input name="publisher" value={item?.publisher ?? ''} />
      </label>
      <label>
        Published
        <input name="published" value={item?.published ?? ''} placeholder="2019 or 2019-05-01" />
      </label>
      <label>
        Length <small>(pages / minutes / tracks)</small>
        <input name="length" value={item?.length?.toString() ?? ''} inputmode="numeric" />
      </label>
    </div>
    <label>
      Description
      <textarea name="description" rows={4}>
        {item?.description ?? ''}
      </textarea>
    </label>
    <div class="grid">
      <label>
        Status
        <select name="status">
          {ITEM_STATUSES.map((st) => (
            <option value={st} selected={(item?.status ?? 'not_started') === st}>
              {STATUS_LABEL[st]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Rating
        <RatingSelect value={item?.rating} />
      </label>
      <label>
        Copies <small>(0 = not owned)</small>
        <input name="copies" value={item?.copies?.toString() ?? '1'} inputmode="numeric" />
      </label>
    </div>
    <div class="grid">
      <label>
        Began
        <input type="date" name="beganOn" value={item?.beganOn ?? ''} />
      </label>
      <label>
        Completed
        <input type="date" name="completedOn" value={item?.completedOn ?? ''} />
      </label>
    </div>
    <label>
      Tags <small>(comma-separated)</small>
      <input name="tags" value={tags?.join(', ') ?? ''} />
    </label>
    <label>
      Review
      <textarea name="review" rows={3}>
        {item?.review ?? ''}
      </textarea>
    </label>
    <label>
      Reviewed in <small>(blog post URLs, one per line — linked from share pages too)</small>
      <textarea name="reviewedIn" rows={2}>
        {reviewedIn.join('\n')}
      </textarea>
    </label>
    <label>
      Private notes <small>(never shown on share pages)</small>
      <textarea name="notes" rows={3}>
        {item?.notes ?? ''}
      </textarea>
    </label>
    <label>
      Cover image URL <small>(fetched once into storage on save)</small>
      <input name="coverUrl" placeholder="https://…" />
    </label>
    {item?.coverKey ? (
      <label>
        <input type="checkbox" name="removeCover" value="1" /> Remove current cover
      </label>
    ) : null}
    <details>
      <summary>Advanced: details JSON</summary>
      <textarea name="details" rows={3}>
        {JSON.stringify(details)}
      </textarea>
    </details>
    <button type="submit">{submitLabel}</button>
  </form>
  );
};

/** A lookup result with a one-click "add to shelf" form. */
export const CandidateCard: FC<{ candidate: Candidate; libraries: Library[] }> = ({ candidate, libraries }) => (
  <article class="candidate">
    <div class="candidate-cover">
      {candidate.coverUrl ? (
        <img src={candidate.coverUrl} alt="" loading="lazy" />
      ) : (
        <div class="cover-fallback">{MEDIA_ICON[candidate.mediaType]}</div>
      )}
    </div>
    <div class="candidate-body">
      <strong>{candidate.title}</strong>
      {candidate.creators ? <div>{candidate.creators}</div> : null}
      <small class="muted">
        {MEDIA_LABEL[candidate.mediaType]}
        {candidate.published ? ` · ${candidate.published}` : ''}
        {candidate.publisher ? ` · ${candidate.publisher}` : ''}
        {' · via '}
        {candidate.provider}
      </small>
      <form method="post" action="/items" class="candidate-save">
        <input type="hidden" name="mediaType" value={candidate.mediaType} />
        <input type="hidden" name="title" value={candidate.title} />
        <input type="hidden" name="creators" value={candidate.creators ?? ''} />
        <input type="hidden" name="publisher" value={candidate.publisher ?? ''} />
        <input type="hidden" name="published" value={candidate.published ?? ''} />
        <input type="hidden" name="description" value={candidate.description ?? ''} />
        <input type="hidden" name="length" value={candidate.length?.toString() ?? ''} />
        <input type="hidden" name="isbn13" value={candidate.isbn13 ?? ''} />
        <input type="hidden" name="isbn10Upc" value={candidate.isbn10Upc ?? ''} />
        <input type="hidden" name="coverUrl" value={candidate.coverUrl ?? ''} />
        <input type="hidden" name="details" value={JSON.stringify(candidate.details)} />
        <select name="libraryId" aria-label="Shelf">
          {libraries.map((l) => (
            <option value={String(l.id)}>{l.name}</option>
          ))}
        </select>
        <button type="submit">Add to shelf</button>
        <button type="submit" name="logOnly" value="1" class="btn" title="Catalog as read/reviewed without owning a copy — opens the edit form for your rating and review">
          Log — not owned
        </button>
      </form>
    </div>
  </article>
);

export const Pagination: FC<{ page: number; pages: number; makeHref: (page: number) => string }> = ({
  page,
  pages,
  makeHref,
}) =>
  pages > 1 ? (
    <nav class="pagination">
      {page > 1 ? <a href={makeHref(page - 1)}>← Prev</a> : <span />}
      <span class="muted">
        {page} / {pages}
      </span>
      {page < pages ? <a href={makeHref(page + 1)}>Next →</a> : <span />}
    </nav>
  ) : null;

/** Human labels for well-known details keys (per-media conventions, ARCH.md §5). */
export const DETAIL_LABELS: Record<string, string> = {
  reviewed_in: 'Reviewed in',
  bgg_id: 'BGG ID',
  players_min: 'Min players',
  players_max: 'Max players',
  playtime_min: 'Min playtime',
  playtime_max: 'Max playtime',
  discogs_id: 'Discogs ID',
  format: 'Format',
  label: 'Label',
  catno: 'Catalog #',
  year: 'Year',
  genres: 'Genres',
  subtitle: 'Subtitle',
  series: 'Series',
};

const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v);

/** Details values render as text, except URLs (e.g. reviewed_in), which link out. */
const DetailValue: FC<{ value: unknown }> = ({ value }) => (
  <>
    {(Array.isArray(value) ? value : [value]).map((p, i) => (
      <>
        {i > 0 ? ', ' : ''}
        {isUrl(p) ? (
          <a href={p} rel="noopener noreferrer">
            {p.replace(/^https?:\/\//, '')}
          </a>
        ) : (
          String(p)
        )}
      </>
    ))}
  </>
);

export const DetailsList: FC<{ details: Record<string, unknown> }> = ({ details }) => {
  const entries = Object.entries(details).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return null;
  return (
    <dl class="details-list">
      {entries.map(([k, v]) => (
        <>
          <dt>{DETAIL_LABELS[k] ?? k.replaceAll('_', ' ')}</dt>
          <dd>
            <DetailValue value={v} />
          </dd>
        </>
      ))}
    </dl>
  );
};
