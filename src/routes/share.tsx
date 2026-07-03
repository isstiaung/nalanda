// PUBLIC routes — no session. Every field rendered here must come through
// toPublicItem() (src/lib/share.ts). See ARCH.md §9 and CLAUDE.md privacy invariants.
import { Hono, type Context } from 'hono';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { Library } from '../db/schema';
import { getItem, getLibraryByShareToken, listItems, tagsForItems } from '../db/queries';
import type { AppEnv } from '../env';
import { toPublicItem, type PublicItem } from '../lib/share';
import { DetailsList, MEDIA_ICON, MEDIA_LABEL, Pagination, stars } from '../views/components';

const share = new Hono<AppEnv>();

const ShareLayout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title}</title>
      <link rel="stylesheet" href="/vendor/pico.min.css" />
      <link rel="stylesheet" href="/app.css" />
    </head>
    <body>
      <main class="container">{children}</main>
      <footer class="container muted share-footer">
        <small>Shared read-only from a Nalanda home library.</small>
      </footer>
    </body>
  </html>
);

const PublicCard: FC<{ item: PublicItem; token: string }> = ({ item, token }) => (
  <a href={`/share/${token}/items/${item.id}`} class="item-card">
    <div class="item-cover">
      {item.coverKey ? (
        <img class="cover-img" src={`/covers/${item.coverKey}`} alt={`Cover of ${item.title}`} loading="lazy" />
      ) : (
        <div class="cover-fallback">{MEDIA_ICON[item.mediaType]}</div>
      )}
    </div>
    <div class="item-meta">
      <strong>{item.title}</strong>
      {item.creators ? <small>{item.creators}</small> : null}
      <small class="muted">
        {MEDIA_ICON[item.mediaType]} {stars(item.rating)}
      </small>
    </div>
  </a>
);

function renderShare(c: Context<AppEnv>, title: string, body: Child) {
  return c.html(`<!doctype html>${ShareLayout({ title, children: body })}`);
}

share.get('/:token', async (c) => {
  const token = c.req.param('token');
  const lib = await getLibraryByShareToken(c.env.DB, token);
  if (!lib) return c.notFound();
  const pageNum = Number.parseInt(c.req.query('page') ?? '1', 10) || 1;
  const { items, total, page: current, pages } = await listItems(c.env.DB, lib.id, {
    sort: 'title',
    page: pageNum,
  });
  const publicItems = items.map(toPublicItem);

  return renderShare(
    c,
    lib.name,
    <>
      <hgroup>
        <h1>{lib.name}</h1>
        <p class="muted">
          {total} {total === 1 ? 'item' : 'items'}
        </p>
      </hgroup>
      <div class="item-grid">
        {publicItems.map((item) => (
          <PublicCard item={item} token={token} />
        ))}
      </div>
      <Pagination page={current} pages={pages} makeHref={(p) => `/share/${token}?page=${p}`} />
    </>,
  );
});

share.get('/:token/items/:id', async (c) => {
  const token = c.req.param('token');
  const lib = await getLibraryByShareToken(c.env.DB, token);
  if (!lib) return c.notFound();
  const item = await getItem(c.env.DB, Number(c.req.param('id')));
  if (!item || item.libraryId !== lib.id) return c.notFound(); // token only unlocks its own shelf
  const pub = toPublicItem(item);
  const tags = (await tagsForItems(c.env.DB, [item.id])).get(item.id) ?? [];

  return renderShare(
    c,
    `${pub.title} · ${lib.name}`,
    <article class="item-detail">
      <div class="item-detail-cover">
        {pub.coverKey ? (
          <img class="cover-img" src={`/covers/${pub.coverKey}`} alt={`Cover of ${pub.title}`} />
        ) : (
          <div class="cover-fallback">{MEDIA_ICON[pub.mediaType]}</div>
        )}
      </div>
      <div class="item-detail-body">
        <hgroup>
          <h1>{pub.title}</h1>
          <p>{pub.creators}</p>
        </hgroup>
        <p class="muted">
          {MEDIA_ICON[pub.mediaType]} {MEDIA_LABEL[pub.mediaType]}
          {pub.published ? ` · ${pub.published}` : ''}
          {pub.publisher ? ` · ${pub.publisher}` : ''}
          {pub.length ? ` · ${pub.length}` : ''}
        </p>
        {pub.rating ? <p class="rating">{stars(pub.rating)}</p> : null}
        {tags.length ? (
          <p>
            {tags.map((t) => (
              <span class="tag">#{t}</span>
            ))}
          </p>
        ) : null}
        {pub.description ? <p class="prewrap">{pub.description}</p> : null}
        <DetailsList details={pub.details} />
        {pub.review ? (
          <section>
            <h4>Review</h4>
            <p class="prewrap">{pub.review}</p>
          </section>
        ) : null}
        <p>
          <a href={`/share/${token}`}>← back to {lib.name}</a>
        </p>
      </div>
    </article>,
  );
});

export default share;
