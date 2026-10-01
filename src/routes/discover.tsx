// New from authors you've finished (ARCH.md §16 #78): the one piece of discovery Nalanda does. Your most-finished
// authors, and on a click, their works newest first from Open Library — one keyless request per author, never in the
// background, cached in this isolate for a day — with what the catalog already has marked, and Add and Want for the
// rest. In the app only.
import { Hono, type Context } from 'hono';
import { booksNamed, catalogMatches, finishedAuthors, listLibraries, shelfForType, TitleIndex } from '../db/queries';
import type { AppEnv } from '../env';
import { nameKey } from '../lib/creators';
import { olRecentByAuthor } from '../metadata/openlibrary';
import type { Candidate } from '../metadata/provider';
import { CandidateCard } from '../views/components';
import { page } from '../views/layout';

const discover = new Hono<AppEnv>();

const CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX = 200;
/** Per isolate, by author key: a day's worth of answers, so a household looking twice asks Open Library once. */
const cache = new Map<string, { at: number; works: Candidate[] }>();

/** An author's works from the cache or Open Library; null when Open Library didn't answer, which is never cached. */
async function worksOf(author: string): Promise<Candidate[] | null> {
  const key = nameKey(author);
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_TTL_MS) return hit.works;
  const works = await olRecentByAuthor(author);
  if (works === null) return null;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), works });
  return works;
}

/** For tests: forget every author looked up in this isolate. */
export function clearDiscoverCache(): void {
  cache.clear();
}

const AUTHOR_MAX = 200;
const cleanAuthor = (raw: unknown): string | null => {
  const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, AUTHOR_MAX) : '';
  return t || null;
};

type Looked = { author: string; works: Candidate[] | null; held: Array<number | null> };

async function discoverPage(c: Context<AppEnv>, authors: Array<{ name: string; books: number }>, looked?: Looked) {
  const [libs, shelfFor] = await Promise.all([listLibraries(c.env.DB), shelfForType(c.env.DB)]);
  const works = looked?.works ?? [];
  const fresh = looked ? works.filter((_, i) => looked.held[i] === null) : [];
  const here = looked ? works.length - fresh.length : 0;
  return page(
    c,
    'New from your authors',
    <>
      <div class="page-head">
        <div>
          <h1>New from your authors</h1>
          <span class="sub">
            {authors.length} {authors.length === 1 ? 'AUTHOR' : 'AUTHORS'} YOU HAVE FINISHED
          </span>
        </div>
      </div>
      <p class="muted">
        The authors of the books you have finished, most first. Look one up and Open Library lists their works, newest
        first — what is already on your shelves is marked, and the rest can go on a shelf or your want list. One lookup
        per click, never in the background; this is the extent of what Nalanda suggests.
      </p>
      {authors.length ? (
        <ol class="series-list authors-finished">
          {authors.map((a) => (
            <li>
              {/* a GET: the look-up has no side effect, so the result can be reloaded, bookmarked and come back to */}
              <form method="get" action="/discover" class="inline-form">
                <input type="hidden" name="author" value={a.name} />
                <a href={`/creators/${encodeURIComponent(a.name)}`} class="series-name">
                  {a.name}
                </a>
                <span class="mono muted">
                  {a.books} finished
                </span>
                <button type="submit" class="btn" aria-current={looked && nameKey(looked.author) === nameKey(a.name) ? 'true' : undefined}>
                  {looked && nameKey(looked.author) === nameKey(a.name) ? 'Looked up' : 'Look up'}
                </button>
              </form>
            </li>
          ))}
        </ol>
      ) : (
        <p class="muted">Finish a book, and its author appears here.</p>
      )}
      {looked ? (
        <section id="discover-results" class="detail-section" aria-labelledby="discover-head">
          <p class="eyebrow" id="discover-head">
            {looked.author}
            {looked.works ? `: ${fresh.length} not on your shelves${here ? ` · ${here} already here` : ''}` : ''}
          </p>
          {looked.works === null ? (
            <p class="error" role="alert">
              Open Library didn’t answer — try again in a moment.
            </p>
          ) : looked.works.length ? (
            looked.works.map((candidate, i) => <CandidateCard candidate={candidate} libraries={libs} inCatalog={looked.held[i]} shelfFor={shelfFor} />)
          ) : (
            <p class="muted">Open Library lists nothing for that name right now.</p>
          )}
        </section>
      ) : null}
    </>,
  );
}

/**
 * The page, and — with `?author=` — one author looked up: on a click, one request, and only for an author the member
 * has finished (the list the page shows), so this is never a general proxy to Open Library. Their works are shown
 * under the list, those here already marked.
 */
discover.get('/discover', async (c) => {
  const authors = await finishedAuthors(c.env.DB, c.get('user').id);
  const asked = cleanAuthor(c.req.query('author'));
  if (!asked) return discoverPage(c, authors);
  const author = authors.find((a) => nameKey(a.name) === nameKey(asked))?.name;
  if (!author) return c.redirect('/discover');
  const works = await worksOf(author);
  if (works === null) return discoverPage(c, authors, { author, works: null, held: [] });
  // what is here already: by ISBN as the Add page tells, and by title and author for a work without one
  const [byIsbn, named] = await Promise.all([catalogMatches(c.env.DB, works), booksNamed(c.env.DB, author)]);
  const byTitle = new TitleIndex();
  for (const b of named) byTitle.add(b.title, b.creators, b.id);
  const held = works.map((w, i) => byIsbn[i] ?? byTitle.find(w.title, w.creators ?? author) ?? null);
  return discoverPage(c, authors, { author, works, held });
});

export default discover;
