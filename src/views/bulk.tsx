// Bulk edit's pieces (ARCH.md §16 #47): a checkbox per item, "select all on this page", the action bar, the notice a
// finished action leaves, and a delete's confirmation. The checkboxes sit in the table and the grid, outside the bar's
// form, and join it through their form attribute — so the table is never inside a form (its Holding toggles post on
// their own), and without JavaScript the boxes and the bar still submit as a plain form.
import type { FC } from 'hono/jsx';
import { BULK_MAX, type BulkAction } from '../db/queries';
import { accNo, BULK_FORM } from './components';

/** How many titles a delete's confirmation lists before "and M more". */
export const CONFIRM_TITLES = 10;

const ACTION_LABEL: Record<BulkAction, string> = {
  'tag-add': 'Add a tag',
  'tag-remove': 'Remove a tag',
  move: 'Move to shelf',
  owned: 'Mark owned',
  'not-owned': 'Mark not owned',
  delete: 'Delete…',
};

/**
 * The action bar. CSS shows it once a box is checked (`:has`), with or without JavaScript, and shows the tag field or
 * the shelf menu only for the actions that use them; a browser without `:has` shows all of it. Delete is offered to
 * admins only — the route refuses it to anyone else as well.
 */
export const BulkBar: FC<{
  back: string;
  admin: boolean;
  libraries: Array<{ id: number; name: string }>;
  currentLibrary?: number;
}> = ({ back, admin, libraries, currentLibrary }) => {
  const targets = libraries.filter((l) => l.id !== currentLibrary);
  // no other shelf, nowhere to move to
  const actions = (['tag-add', 'tag-remove', 'move', 'owned', 'not-owned', 'delete'] as const).filter(
    (a) => (a !== 'move' || targets.length > 0) && (a !== 'delete' || admin),
  );
  return (
    <form id={BULK_FORM} method="post" action="/bulk" class="bulk-bar" data-max={String(BULK_MAX)} aria-label="Change selected items">
      <input type="hidden" name="back" value={back} />
      <div class="bulk-status">
        <span class="bulk-count mono" data-bulk-count aria-live="polite">
          With selected:
        </span>
        <small class="muted">up to {BULK_MAX} at a time</small>
        <button type="button" class="btn-quiet bulk-clear" data-bulk-clear hidden>
          Clear
        </button>
      </div>
      <div class="bulk-controls">
        <select name="action" aria-label="Action" required>
          <option value="">Choose an action…</option>
          {actions.map((a) => (
            <option value={a}>{ACTION_LABEL[a]}</option>
          ))}
        </select>
        <input class="bulk-tag" name="tag" placeholder="Tag" aria-label="Tag" autocomplete="off" maxlength={100} />
        {targets.length ? (
          <select class="bulk-shelf" name="libraryId" aria-label="Shelf to move to">
            {targets.map((l) => (
              <option value={String(l.id)}>{l.name}</option>
            ))}
          </select>
        ) : null}
        <button type="submit">Apply</button>
      </div>
    </form>
  );
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const count = (q: Record<string, string | undefined>, k: string) => {
  const n = Number.parseInt(q[k] ?? '', 10);
  return Number.isFinite(n) && n > 0 && n <= BULK_MAX ? n : 0;
};

/**
 * What the last bulk action did, from the query its redirect carries: which action and how many, never free text, so
 * a link can't put words on the page. A move names its shelf from the page's own list.
 */
export const BulkNotice: FC<{ query: Record<string, string | undefined>; libraries: Array<{ id: number; name: string }> }> = ({
  query,
  libraries,
}) => {
  const done = query['bulk'];
  const n = count(query, 'n');
  const same = count(query, 'same');
  const skipped = count(query, 'skipped');
  const items = plural(n, 'item', 'items');
  let text: string;
  let extra = '';
  switch (done) {
    case 'tag-add':
      text = `Tagged ${items}.`;
      if (same) extra = ` ${same} already had it.`;
      break;
    case 'tag-remove':
      text = `Untagged ${items}.`;
      if (same) extra = ` ${same} didn’t have it.`;
      break;
    case 'move': {
      const to = libraries.find((l) => String(l.id) === query['to']);
      return (
        <output class="notice">
          Moved {items}
          {to ? (
            <>
              {' '}
              to <a href={`/libraries/${to.id}`}>{to.name}</a>
            </>
          ) : null}
          .{same ? ` ${same} ${same === 1 ? 'was' : 'were'} there already.` : ''}
        </output>
      );
    }
    case 'owned':
    case 'not-owned':
      text = `Marked ${items} ${done === 'owned' ? 'owned' : 'not owned'}.`;
      if (same) extra = ` ${same} already ${same === 1 ? 'was' : 'were'}.`;
      break;
    case 'delete':
      text = `Deleted ${items}.`;
      break;
    default:
      return null;
  }
  return (
    <output class="notice">
      {text}
      {extra}
      {skipped ? (
        <>
          {' '}
          <strong>
            Skipped {plural(skipped, 'item', 'items')} held in 2 or more copies:
          </strong>{' '}
          owned and not owned set 0 or 1 copies, and would lose the count. Change it on each item’s edit form.
        </>
      ) : null}
    </output>
  );
};

/** A delete's confirmation: how many, and which — the first few titles and "and M more". Nothing is deleted until its button. */
export const DeleteConfirmation: FC<{ items: Array<{ id: number; title: string }>; back: string }> = ({ items, back }) => {
  const shown = items.slice(0, CONFIRM_TITLES);
  const more = items.length - shown.length;
  const what = plural(items.length, 'item', 'items');
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Delete {what}?</h1>
          <span class="sub">THIS CANNOT BE UNDONE</span>
        </div>
      </div>
      <div class="panel bulk-confirm">
        <p>
          {items.length === 1
            ? 'This item goes for good, with its tags, reads, reviews, loans and cover:'
            : `These ${items.length} items go for good, with their tags, reads, reviews, loans and covers:`}
        </p>
        <ol class="bulk-titles">
          {shown.map((i) => (
            <li>
              <span class="acc-no">{accNo(i.id)}</span> <span class="t">{i.title}</span>
            </li>
          ))}
        </ol>
        {more ? <p class="muted">and {plural(more, 'more', 'more')}.</p> : null}
        <form method="post" action="/bulk" class="inline-form">
          <input type="hidden" name="action" value="delete" />
          <input type="hidden" name="confirm" value="1" />
          <input type="hidden" name="back" value={back} />
          {items.map((i) => (
            <input type="hidden" name="id" value={String(i.id)} />
          ))}
          <button type="submit" class="btn-danger">
            Delete {what}
          </button>
          <a href={back} class="btn">
            Cancel
          </a>
        </form>
      </div>
    </>
  );
};
