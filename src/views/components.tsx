import type { FC } from 'hono/jsx';
import type { Item, ItemStatus, Library, MediaType } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
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

/** rating is stored as half-stars 0–10, rendered as ★★★½ */
export function stars(rating: number | null | undefined): string {
  if (!rating) return '';
  return '★'.repeat(Math.floor(rating / 2)) + (rating % 2 ? '½' : '');
}

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

export const ItemCard: FC<{ item: Item; onLoan?: boolean }> = ({ item, onLoan }) => (
  <a href={`/items/${item.id}`} class="item-card">
    <div class="item-cover">
      <Cover coverKey={item.coverKey} title={item.title} mediaType={item.mediaType} />
    </div>
    <div class="item-meta">
      <strong>{item.title}</strong>
      {item.creators ? <small>{item.creators}</small> : null}
      <small class="muted">
        {MEDIA_ICON[item.mediaType]} {stars(item.rating)}
        {onLoan ? <span class="badge">on loan</span> : null}
      </small>
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
}> = ({ libraries, action, submitLabel, item, tags, selectedLibraryId }) => (
  <form method="post" action={action} class="item-form">
    <div class="grid">
      <label>
        Library
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
              {MEDIA_ICON[t]} {MEDIA_LABEL[t]}
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
      Creators <small class="muted">(authors / designers / artists)</small>
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
        Length <small class="muted">(pages / minutes / tracks)</small>
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
        Copies
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
      Tags <small class="muted">(comma-separated)</small>
      <input name="tags" value={tags?.join(', ') ?? ''} />
    </label>
    <label>
      Review
      <textarea name="review" rows={3}>
        {item?.review ?? ''}
      </textarea>
    </label>
    <label>
      Private notes <small class="muted">(never shown on share pages)</small>
      <textarea name="notes" rows={3}>
        {item?.notes ?? ''}
      </textarea>
    </label>
    <label>
      Cover image URL <small class="muted">(fetched once into storage on save)</small>
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
        {item?.details ?? '{}'}
      </textarea>
    </details>
    <button type="submit">{submitLabel}</button>
  </form>
);

/** A lookup result with a one-click "add to library" form. */
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
        <select name="libraryId" aria-label="Library">
          {libraries.map((l) => (
            <option value={String(l.id)}>{l.name}</option>
          ))}
        </select>
        <button type="submit">Add</button>
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

export const DetailsList: FC<{ details: Record<string, unknown> }> = ({ details }) => {
  const entries = Object.entries(details).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return null;
  return (
    <dl class="details-list">
      {entries.map(([k, v]) => (
        <>
          <dt>{DETAIL_LABELS[k] ?? k.replaceAll('_', ' ')}</dt>
          <dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
        </>
      ))}
    </dl>
  );
};
