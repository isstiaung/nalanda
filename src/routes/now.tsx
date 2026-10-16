// Now reading & playing (ARCH.md §16 #104): what the household has open — every book being read, by whom and how far,
// and the board games and records played lately — one pinned link away in the sidebar. Inside the app only: who
// reads what is the household's to see (the Read by filter shows the same), and nothing here reaches a share page or
// a connection. Your own read takes a page from here, and a game or a record a play, each posting to the item's own
// route with back=now, which brings you back here (routes/items.tsx).
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { nowReadingAndPlaying, type NowPlayed, type NowReading } from '../db/queries';
import type { AppEnv } from '../env';
import { daysBefore } from '../lib/dates';
import { progressPercent } from '../lib/progress';
import { Cover, personName, ProgressLine } from '../views/components';
import { Fill, mediaLabel, useI18n } from '../views/i18n';
import { page, todayOf } from '../views/layout';

/** How far back "Played lately" reaches, in days. */
export const PLAYED_LATELY_DAYS = 60;

const now = new Hono<AppEnv>();

/** The cover, linked a second time for the pointer — the title is the link a keyboard and a screen reader take. */
const CardCover: FC<{ item: Pick<NowReading, 'id' | 'title' | 'coverKey' | 'mediaType'> }> = ({ item }) => (
  <a href={`/items/${item.id}`} class="now-cover" tabindex={-1} aria-hidden="true">
    <Cover coverKey={item.coverKey} title={item.title} mediaType={item.mediaType} />
  </a>
);

const ReadingCard: FC<{ read: NowReading; me: number; people: Array<{ id: number; username: string }> }> = ({ read, me, people }) => {
  const { t } = useI18n();
  const mine = read.readerId === me;
  return (
    <li class="now-card">
      <CardCover item={read} />
      <div class="now-body">
        <a href={`/items/${read.id}`} class="now-title">
          {read.title}
        </a>
        {read.creators ? <small class="now-creators">{read.creators}</small> : null}
        <span class="mline">
          {/* whose read: only once there is more than one person to tell apart */}
          {people.length > 1 ? <small class="now-reader">{mine ? t('now.you') : personName(people, read.readerId)}</small> : null}
          {read.beganOn ? <small class="mono muted">{t('now.since', { date: read.beganOn })}</small> : null}
        </span>
        {read.page ? <ProgressLine page={read.page} length={read.length} percent={progressPercent(read.page, read.length)} /> : null}
        {/* a page goes into your own read only (the route checks it again): a plain post, back here when it's done */}
        {mine ? (
          <form method="post" action={`/items/${read.id}/progress`} class="inline-form now-action">
            <input type="hidden" name="back" value="now" />
            <input
              name="page"
              inputmode="numeric"
              pattern="[0-9]+"
              class="mono"
              size={6}
              placeholder={t('now.page')}
              aria-label={t('now.page_label', { title: read.title })}
              required
            />
            {read.length ? <span class="muted mono">/ {read.length}</span> : null}
            <button type="submit">
              {t('now.record')}
              <span class="sr-only"> {read.title}</span>
            </button>
          </form>
        ) : null}
      </div>
    </li>
  );
};

const PlayedCard: FC<{ item: NowPlayed }> = ({ item }) => {
  const i18n = useI18n();
  const { t, n } = i18n;
  return (
    <li class="now-card">
      <CardCover item={item} />
      <div class="now-body">
        <a href={`/items/${item.id}`} class="now-title">
          {item.title}
        </a>
        {item.creators ? <small class="now-creators">{item.creators}</small> : null}
        <span class="mline">
          <small class="muted">{mediaLabel(i18n, item.mediaType)}</small>
          <small class="mono muted">{t('now.last_played', { date: item.lastPlayed })}</small>
          <small class="mono muted">{n('now.plays_lately', item.plays, { count: String(item.plays), days: String(PLAYED_LATELY_DAYS) })}</small>
        </span>
        <form method="post" action={`/items/${item.id}/plays`} class="inline now-action">
          <input type="hidden" name="back" value="now" />
          <button type="submit" class="btn">
            {t('now.played_today')}
            <span class="sr-only"> {item.title}</span>
          </button>
        </form>
      </div>
    </li>
  );
};

now.get('/now', async (c) => {
  const user = c.get('user');
  const { reading, played, people } = await nowReadingAndPlaying(c.env.DB, user.id, daysBefore(todayOf(c), PLAYED_LATELY_DAYS));
  const { t } = c.get('i18n');
  return page(
    c,
    t('now.title'),
    <>
      <div class="page-head">
        <div>
          <h1>{t('now.title')}</h1>
          <span class="sub">{t('now.sub', { reading: String(reading.length), played: String(played.length) }).toUpperCase()}</span>
        </div>
      </div>
      {/* a page or a play posted from here and refused: the item's own page says why */}
      {c.req.query('refused') === '1' ? (
        <p class="error" role="alert">
          {t('now.refused')}
        </p>
      ) : null}
      <section class="now-section" aria-labelledby="now-reading">
        <h2 id="now-reading" class="eyebrow">
          {t('now.reading')}
        </h2>
        {reading.length ? (
          <ol class="now-list">
            {reading.map((read) => (
              <ReadingCard read={read} me={user.id} people={people} />
            ))}
          </ol>
        ) : (
          <p class="muted">
            <Fill text={t('now.reading_none')} with={{ readNext: <a href="/#read-next">{t('now.read_next')}</a> }} />
          </p>
        )}
      </section>
      <section class="now-section" aria-labelledby="now-played">
        <h2 id="now-played" class="eyebrow">
          {t('now.played')}
        </h2>
        {played.length ? (
          <ol class="now-list">
            {played.map((item) => (
              <PlayedCard item={item} />
            ))}
          </ol>
        ) : (
          <p class="muted">{t('now.played_none', { days: String(PLAYED_LATELY_DAYS) })}</p>
        )}
      </section>
    </>,
  );
});

export default now;
