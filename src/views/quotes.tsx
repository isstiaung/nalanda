// Quotes and highlights on an item's page (ARCH.md §16 #77): the household's, each under its writer, editable by them
// or an admin, with a "share" checkbox per quote — off by default — and a form to add one.
import type { FC } from 'hono/jsx';
import type { QuoteEntry } from '../db/queries';
import { ledgerDate } from '../lib/dates';
import { personName, type Person, type Viewer } from './components';

export const QuotesSection: FC<{ itemId: number; quotes: QuoteEntry[]; viewer: Viewer; people: Person[]; error?: string }> = ({
  itemId,
  quotes,
  viewer,
  people,
  error,
}) => {
  const base = `/items/${itemId}/quotes`;
  return (
    <div class="detail-section" id="quotes">
      <p class="eyebrow">Quotes and highlights</p>
      {error ? (
        <p class="error" role="alert" id="quote-error">
          {error}
        </p>
      ) : null}
      {quotes.length ? (
        <ol class="quotes">
          {quotes.map((q) => {
            const mine = q.userId === viewer.id;
            const editable = viewer.admin || mine;
            return (
              <li class={q.shared ? 'quote shared' : 'quote'}>
                <blockquote class="quote-text prewrap">{q.text}</blockquote>
                <p class="quote-by">
                  <span class={mine ? 'reviewer reviewer-self' : 'reviewer'}>
                    {mine ? (
                      <>
                        You <span class="muted">· {personName(people, q.userId)}</span>
                      </>
                    ) : (
                      personName(people, q.userId)
                    )}
                  </span>
                  {q.page ? <span class="mono muted">{q.page}</span> : null}
                  <span class="mono muted">{ledgerDate(q.at)}</span>
                  {q.source === 'kindle' ? <span class="pill ghost">Kindle</span> : null}
                  {q.shared ? <span class="pill">Shared</span> : null}
                </p>
                {q.note ? <p class="quote-note prewrap">{q.note}</p> : null}
                {editable ? (
                  <details class="read-edit">
                    <summary>Edit</summary>
                    <form method="post" action={`${base}/${q.id}`} class="quote-form">
                      <textarea name="text" rows={3} aria-label="Quote" required>
                        {q.text}
                      </textarea>
                      <input name="where" value={q.page ?? ''} placeholder="Page or location" aria-label="Page or location" class="mono" />
                      <textarea name="note" rows={2} aria-label="Your note" placeholder="Your note (optional)">
                        {q.note ?? ''}
                      </textarea>
                      <label class="inline-check">
                        <input type="checkbox" name="shared" value="1" checked={q.shared} /> Show on share pages
                      </label>
                      <button type="submit">Save</button>
                    </form>
                    <form method="post" action={`${base}/${q.id}/delete`} class="inline-form" data-confirm={mine ? 'Delete your quote?' : `Delete ${personName(people, q.userId)}’s quote?`}>
                      <button type="submit" class="btn-danger">
                        Delete
                      </button>
                    </form>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      <details class="read-edit quote-add" open={!!error}>
        <summary>Add a quote</summary>
        <form method="post" action={base} class="quote-form">
          <textarea name="text" rows={3} aria-label="Quote" placeholder="A line worth keeping" required></textarea>
          <input name="where" placeholder="Page or location" aria-label="Page or location" class="mono" />
          <textarea name="note" rows={2} aria-label="Your note" placeholder="Your note (optional)"></textarea>
          <label class="inline-check">
            <input type="checkbox" name="shared" value="1" /> Show on share pages
          </label>
          <button type="submit">Add quote</button>
        </form>
        <p class="muted form-note">
          Yours, private until you tick “Show on share pages” — then the quote and its page appear on any share link that
          shows this book, signed with your display name while names are on there. Your note never leaves the app.
        </p>
      </details>
    </div>
  );
};
