// Creators and publishers (ARCH.md §16 #72): everyone the catalog names as an author, designer or artist, and every
// publisher or label, each with a page of their items and what the signed-in member has finished of them. Signed-in
// only: share pages show an item's creators and publisher as text, nothing here.
import { Hono, type Context } from 'hono';
import type { FC } from 'hono/jsx';
import { itemsByCreator, itemsByPublisher, listCreators, listPublishers, shelfFlags, type ByNameRow } from '../db/queries';
import type { AppEnv } from '../env';
import { CREATOR_ROLE, mainType, nameKey, PUBLISHER_ROLE, ROLE_ORDER, type NameCount } from '../lib/creators';
import { ItemGrid, Pagination } from '../views/components';
import { page } from '../views/layout';

const creators = new Hono<AppEnv>();

const PER_PAGE = 60;

type Kind = {
  /** the path these pages live under */
  base: '/creators' | '/publishers';
  title: string;
  roles: typeof CREATOR_ROLE;
  empty: string;
  list: (d1: D1Database) => Promise<NameCount[]>;
  items: (d1: D1Database, name: string, viewer: number) => Promise<ByNameRow[]>;
};

const CREATORS: Kind = {
  base: '/creators',
  title: 'Creators',
  roles: CREATOR_ROLE,
  empty: 'No creators yet: an item\u2019s author, designer or artist is read from its Creators field.',
  list: listCreators,
  items: itemsByCreator,
};

const PUBLISHERS: Kind = {
  base: '/publishers',
  title: 'Publishers',
  roles: PUBLISHER_ROLE,
  empty: 'No publishers yet: a book\u2019s publisher or a record\u2019s label is read from its Publisher field.',
  list: listPublishers,
  items: itemsByPublisher,
};

const href = (kind: Kind, name: string) => `${kind.base}/${encodeURIComponent(name)}`;

/** "12 books · 3 records" — what a name has, by kind, in ROLE_ORDER. */
const kindsLine = (n: NameCount) =>
  ROLE_ORDER.filter((t) => n.byType[t])
    .map((t) => `${n.byType[t]} ${KIND_NOUN[t][n.byType[t] === 1 ? 0 : 1]}`)
    .join(' · ');

const KIND_NOUN: Record<keyof typeof CREATOR_ROLE, [string, string]> = {
  book: ['book', 'books'],
  boardgame: ['game', 'games'],
  vinyl: ['record', 'records'],
  music: ['record', 'records'],
  movie: ['movie', 'movies'],
  videogame: ['video game', 'video games'],
  other: ['item', 'items'],
};

/** The index: every name, grouped by what it mostly is, with a box to narrow the list. */
const Index: FC<{ kind: Kind; names: NameCount[]; q: string; total: number }> = ({ kind, names, q, total }) => {
  const groups = ROLE_ORDER.map((t) => ({ type: t, names: names.filter((n) => mainType(n) === t) })).filter((g) => g.names.length);
  return (
    <>
      <div class="page-head">
        <div>
          <h1>{kind.title}</h1>
          <span class="sub">
            {total} {total === 1 ? 'NAME' : 'NAMES'}
            {q ? ` · ${names.length} MATCHING` : ''}
          </span>
        </div>
      </div>
      <form method="get" action={kind.base} class="inline-form names-filter" role="search">
        <input type="search" name="q" value={q} placeholder="Narrow by name" aria-label="Narrow by name" />
        <button type="submit" class="btn">
          Narrow
        </button>
        {q ? (
          <a href={kind.base} class="btn">
            Clear
          </a>
        ) : null}
      </form>
      {names.length ? (
        groups.map((g) => (
          <section class="names-group">
            <p class="eyebrow">{kind.roles[g.type].many}</p>
            <ol class="series-list">
              {g.names.map((n) => (
                <li>
                  <a href={href(kind, n.name)} class="series-name">
                    {n.name}
                  </a>
                  <span class="mono muted">{kindsLine(n)}</span>
                </li>
              ))}
            </ol>
          </section>
        ))
      ) : (
        <p class="muted">{total ? 'Nothing matches that.' : kind.empty}</p>
      )}
    </>
  );
};

async function indexPage(c: Context<AppEnv>, kind: Kind) {
  const q = (c.req.query('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const all = await kind.list(c.env.DB);
  const needle = nameKey(q);
  const names = needle ? all.filter((n) => n.key.includes(needle)) : all;
  return page(c, kind.title, <Index kind={kind} names={names} q={q} total={all.length} />);
}

/** One name's page: its items as a shelf shows them, headed by what the name mostly is, and what you've finished. */
async function namePage(c: Context<AppEnv>, kind: Kind, raw: string) {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > 200) return c.notFound();
  const all = await kind.items(c.env.DB, name, c.get('user').id);
  if (!all.length) return c.notFound(); // a name the catalog doesn't carry: as a tag nothing carries
  const counts: NameCount = { name: all[0]!.creators ?? name, key: nameKey(name), total: all.length, byType: {} };
  for (const i of all) counts.byType[i.mediaType] = (counts.byType[i.mediaType] ?? 0) + 1;
  const role = kind.roles[mainType(counts)].one;
  const finished = all.filter((i) => i.finishedByMe).length;
  const pageNum = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
  const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  const current = Math.min(pageNum, pages);
  const items = all.slice((current - 1) * PER_PAGE, current * PER_PAGE);
  const { onLoan: onLoanIds, wanted: wantedIds } = await shelfFlags(c.env.DB, items.map((i) => i.id));
  return page(
    c,
    name,
    <>
      <div class="page-head">
        <div>
          <h1>{name}</h1>
          <span class="sub">
            {role.toUpperCase()} · {kindsLine(counts).toUpperCase()}
            {finished ? ` · ${finished} FINISHED BY YOU` : ''}
          </span>
        </div>
      </div>
      <ItemGrid items={items} onLoanIds={onLoanIds} wantedIds={wantedIds} />
      <Pagination page={current} pages={pages} makeHref={(p) => `${href(kind, name)}?page=${p}`} />
    </>,
  );
}

creators.get('/creators', (c) => indexPage(c, CREATORS));
creators.get('/creators/:name', (c) => namePage(c, CREATORS, c.req.param('name')));
creators.get('/publishers', (c) => indexPage(c, PUBLISHERS));
creators.get('/publishers/:name', (c) => namePage(c, PUBLISHERS, c.req.param('name')));

export default creators;
