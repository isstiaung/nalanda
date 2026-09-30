// Year in review (ARCH.md §16 #59): a year of books finished, pages, authors, tags, ratings and highlights — the
// signed-in member's own beside the household's — and the household's plays of records and games. Inside the app only:
// it sits behind the session like every page after it in src/index.ts, share pages and connections have no route to it,
// and nothing here goes through toPublicItem() or toConnectionItem(). Everything on the page is one D1 batch.
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { yearInReview } from '../db/queries';
import type { AppEnv } from '../env';
import { todayUtc } from '../lib/reads';
import {
  barPercent,
  MONTH_NAMES,
  MONTHS,
  outOfFive,
  parseYear,
  pickerYears,
  plural,
  soloYear,
  yearHasData,
  type PlayStats,
  type YearReview,
  type YearStats,
} from '../lib/yearreview';
import { stars } from '../views/components';
import { page } from '../views/layout';

const yearReview = new Hono<AppEnv>();

type Column = { key: 'mine' | 'household'; label: string; stats: YearStats };

/** Books finished each month as bars — drawn for the eye, hidden from assistive tech, which reads the table instead. */
const MonthChart: FC<{ col: Column; year: number }> = ({ col, year }) => {
  const max = Math.max(...col.stats.months.map((m) => m.books));
  const cap = `yr-chart-${col.key}`;
  return (
    <figure class="yr-chart" aria-labelledby={cap}>
      <figcaption id={cap} class="yr-chart-cap">
        Books finished by month
      </figcaption>
      <div class="yr-bars" aria-hidden="true">
        {col.stats.months.map((m, i) => (
          <div class="yr-month">
            <span class="yr-n">{m.books ? m.books : ''}</span>
            <span class="yr-bar">
              <span class="yr-fill" style={`height:${barPercent(m.books, max)}%`} />
            </span>
            <span class="yr-m">{MONTHS[i]}</span>
          </div>
        ))}
      </div>
      {/* hidden by its wrapper: a table sizes to its content whatever its own width says, and would widen a phone */}
      <div class="visually-hidden">
        <table>
          <caption>
            {col.label}: books finished and pages read in each month of {year}
          </caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Books finished</th>
              <th scope="col">Pages read</th>
            </tr>
          </thead>
          <tbody>
            {col.stats.months.map((m, i) => (
              <tr>
                <th scope="row">{MONTH_NAMES[i]}</th>
                <td>{m.books}</td>
                <td>{m.pages}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
};

const nobody = (col: Column, year: number) =>
  col.key === 'mine' ? `You finished no books with a date in ${year}.` : `Nobody finished a book with a date in ${year}.`;

const BooksAndPages: FC<{ col: Column; year: number }> = ({ col, year }) => {
  const s = col.stats;
  if (!s.books) return <p class="muted">{nobody(col, year)}</p>;
  const unmeasured = s.books - s.withLength;
  return (
    <>
      <div class="stat-row">
        <div class="stat">
          <div class="stat-n">{s.books.toLocaleString('en-US')}</div>
          <div class="stat-label">{s.books === 1 ? 'Book finished' : 'Books finished'}</div>
        </div>
        <div class="stat">
          <div class="stat-n">{s.pages.toLocaleString('en-US')}</div>
          <div class="stat-label">Pages read</div>
          {unmeasured ? <div class="stat-detail">{plural(unmeasured, 'book', 'books')} with no length</div> : null}
        </div>
      </div>
      <MonthChart col={col} year={year} />
    </>
  );
};

const AuthorsAndTags: FC<{ col: Column; year: number }> = ({ col, year }) => {
  const s = col.stats;
  if (!s.books) return <p class="muted">{nobody(col, year)}</p>;
  return (
    <>
      <h4>Most-read authors</h4>
      {s.authors.length ? (
        <ol class="yr-list">
          {s.authors.map((a) => (
            <li>
              <span class="yr-name">{a.name}</span>
              <span class="yr-count">
                {plural(a.books, 'book', 'books')}
                {a.finishes > a.books ? ` · ${plural(a.finishes, 'finish', 'finishes')}` : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p class="muted">No authors on these books.</p>
      )}
      <h4>Most-used tags</h4>
      {s.tags.length ? (
        <ol class="yr-list">
          {s.tags.map((t) => (
            <li>
              <a href={`/tags/${encodeURIComponent(t.name)}`} class="tag yr-name">
                {t.name}
              </a>
              <span class="yr-count">{plural(t.books, 'book', 'books')}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p class="muted">No tags on these books.</p>
      )}
    </>
  );
};

const Rating: FC<{ halfStars: number }> = ({ halfStars }) => (
  <span class="yr-rating">
    <span class="rating" aria-hidden="true">
      {stars(Math.max(1, Math.round(halfStars)))}
    </span>{' '}
    <span class="mono">{outOfFive(halfStars)}</span>
    <span class="visually-hidden"> out of 5</span>
  </span>
);

const Highlights: FC<{ col: Column; year: number }> = ({ col, year }) => {
  const s = col.stats;
  if (!s.books) return <p class="muted">{nobody(col, year)}</p>;
  const sameBook = s.longest && s.shortest && s.longest.id === s.shortest.id;
  return (
    <>
      <h4>Average rating given</h4>
      {s.rating ? (
        <p class="yr-average">
          <Rating halfStars={s.rating.average} /> <span class="muted mono">from {plural(s.rating.count, 'rating', 'ratings')}</span>
        </p>
      ) : (
        <p class="muted">{col.key === 'mine' ? 'You rated none of these books.' : 'Nobody rated these books.'}</p>
      )}
      {s.topRated.length ? (
        <>
          <h4>Highest rated</h4>
          <ol class="yr-list">
            {s.topRated.map((b) => (
              <li>
                <a href={`/items/${b.id}`} class="yr-name">
                  {b.title}
                </a>
                <Rating halfStars={b.rating} />
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <dl class="props yr-props">
        <dt>Longest</dt>
        <dd>
          {s.longest ? (
            <>
              <a href={`/items/${s.longest.id}`}>{s.longest.title}</a>
              <span class="mono muted">{plural(s.longest.length, 'page', 'pages')}</span>
            </>
          ) : (
            <span class="muted">No book with a length</span>
          )}
        </dd>
        <dt>Shortest</dt>
        <dd>
          {s.shortest && !sameBook ? (
            <>
              <a href={`/items/${s.shortest.id}`}>{s.shortest.title}</a>
              <span class="mono muted">{plural(s.shortest.length, 'page', 'pages')}</span>
            </>
          ) : (
            <span class="muted">{sameBook ? 'The same book: the only one with a length' : 'No book with a length'}</span>
          )}
        </dd>
        <dt>Fastest read</dt>
        <dd>
          {s.fastest ? (
            <>
              <a href={`/items/${s.fastest.id}`}>{s.fastest.title}</a>
              <span class="mono muted">{s.fastest.days === 1 ? 'in a day' : `in ${s.fastest.days} days`}</span>
            </>
          ) : (
            <span class="muted">No finish with a start date</span>
          )}
        </dd>
      </dl>
    </>
  );
};

const PlayLog: FC<{ label: string; noun: [string, string]; verb: string; log: PlayStats; year: number }> = ({ label, noun, verb, log, year }) => (
  <div class="yr-col">
    <h3>{label}</h3>
    {log.plays ? (
      <>
        <div class="stat-row">
          <div class="stat">
            <div class="stat-n">{log.plays.toLocaleString('en-US')}</div>
            <div class="stat-label">{verb}</div>
            <div class="stat-detail">{plural(log.items, noun[0], noun[1])}</div>
          </div>
        </div>
        <h4>Most played</h4>
        <ol class="yr-list">
          {log.top.map((t) => (
            <li>
              <a href={`/items/${t.id}`} class="yr-name">
                {t.title}
              </a>
              <span class="yr-count">{t.plays === 1 ? 'once' : `${t.plays.toLocaleString('en-US')} times`}</span>
            </li>
          ))}
        </ol>
      </>
    ) : (
      <p class="muted">
        No {noun[1]} {noun[1] === 'records' ? 'spun' : 'played'} in {year}.
      </p>
    )}
  </div>
);

/** One of the reading sections: the member's column beside the household's (or alone, when they would be the same). */
const Pair: FC<{ id: string; title: string; cols: Column[]; year: number; body: FC<{ col: Column; year: number }> }> = ({
  id,
  title,
  cols,
  year,
  body: Body,
}) => (
  <section class="yr-section" aria-labelledby={id}>
    <h2 class="eyebrow" id={id}>
      {title}
    </h2>
    <div class={cols.length > 1 ? 'yr-pair' : 'yr-pair yr-solo'}>
      {cols.map((col) => (
        <div class="yr-col">
          <h3>{col.label}</h3>
          <Body col={col} year={year} />
        </div>
      ))}
    </div>
  </section>
);

const YearPage: FC<{ review: YearReview; today: string }> = ({ review, today }) => {
  const { year } = review;
  const current = Number(today.slice(0, 4));
  const solo = soloYear(review);
  const cols: Column[] = [{ key: 'mine', label: 'You', stats: review.mine }];
  if (!solo) cols.push({ key: 'household', label: 'Household', stats: review.household });
  const hasData = yearHasData(review);
  const hasReading = review.household.books > 0;
  const { undated } = review;
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Year in review</h1>
          <span class="sub">{year} · BOOKS, RECORDS AND GAMES</span>
        </div>
        <form method="get" action="/year-in-review" class="inline-form yr-picker">
          <label for="yr-year">Year</label>
          <select id="yr-year" name="year">
            {pickerYears(review.years, current, year).map((y) => (
              <option value={String(y)} selected={y === year}>
                {y}
              </option>
            ))}
          </select>
          <button type="submit" class="btn">
            Show
          </button>
        </form>
      </div>
      <p class="muted yr-intro">
        {solo
          ? 'Your reading: every book you finished with an end date in the year, re-reads too.'
          : 'You: the books you finished and the ratings you gave. Household: everyone’s. A book counts in the year it was finished, a re-read too.'}
      </p>

      {!hasData ? (
        <article class="panel yr-empty">
          <p>
            {year > current
              ? `${year} hasn’t started yet.`
              : year === current
                ? `Nothing yet for ${year}: finish a book, or press Played on a record or a game, and it shows here.`
                : `Nothing for ${year}: no book finished with a date in it, and no plays.`}
          </p>
        </article>
      ) : null}

      {hasReading ? (
        <>
          <Pair id="yr-books" title="Books and pages" cols={cols} year={year} body={BooksAndPages} />
          <Pair id="yr-authors" title="Authors and tags" cols={cols} year={year} body={AuthorsAndTags} />
          <Pair id="yr-ratings" title="Ratings and highlights" cols={cols} year={year} body={Highlights} />
        </>
      ) : hasData ? (
        <section class="yr-section" aria-labelledby="yr-books">
          <h2 class="eyebrow" id="yr-books">
            Books
          </h2>
          <p class="muted">No book finished with a date in {year}.</p>
        </section>
      ) : null}

      {hasData ? (
        <section class="yr-section" aria-labelledby="yr-plays">
          <h2 class="eyebrow" id="yr-plays">
            Records and games
          </h2>
          <p class="muted form-note">The household’s play log: a play is nobody’s own, so this is everyone’s, shown once.</p>
          <div class="yr-pair">
            <PlayLog label="Records" noun={['record', 'records']} verb="Spins" log={review.plays.vinyl} year={year} />
            <PlayLog label="Games" noun={['game', 'games']} verb="Plays" log={review.plays.boardgame} year={year} />
          </div>
        </section>
      ) : null}

      {undated.household ? (
        <p class="muted yr-undated">
          Finished, date unknown:{' '}
          {solo && undated.mine === undated.household
            ? plural(undated.household, 'book', 'books')
            : `${plural(undated.mine, 'book', 'books')} of yours, ${undated.household.toLocaleString('en-US')} in the household`}{' '}
          — with no end date, they count in no year.
        </p>
      ) : null}
    </>
  );
};

yearReview.get('/year-in-review', async (c) => {
  const today = todayUtc();
  const year = parseYear(c.req.query('year')) ?? Number(today.slice(0, 4));
  const review = await yearInReview(c.env.DB, c.get('user').id, year);
  return page(c, `Year in review · ${year}`, <YearPage review={review} today={today} />);
});

export default yearReview;
