// "What should we play tonight?" (ARCH.md §16 #60): the household says how many players, how much time and what
// weight, and gets the board games that fit in random order — or one, picked for it. In the app only: no share page
// or connection sees this page, and it never calls BGG. One handler, two renders: the whole page, or for htmx the
// results alone, with the status line that announces them swapped in out of band.
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { gamesForTonight, pickGameForTonight, type TonightGame } from '../db/queries';
import type { AppEnv } from '../env';
import {
  anyFilter,
  gameFilterParams,
  minutesLabel,
  parseGameFilters,
  TIME_CHOICES,
  WEIGHT_BANDS,
  WEIGHT_LABEL,
  weightBand,
  WEIGHTS,
  type GameFilters,
} from '../lib/games';
import { playDate } from '../lib/plays';
import { todayUtc } from '../lib/reads';
import { BggAttribution } from '../views/attribution';
import { accNo, Cover } from '../views/components';
import { page } from '../views/layout';

const play = new Hono<AppEnv>();

/** At most this many games in each group; past it the page says how many more there are, in random order anyway. */
export const TONIGHT_LIMIT = 60;

/** The pick "Pick another" was pressed on, from `?not=` — anything but a positive id is none. */
function shownPick(raw: string | undefined): number | null {
  const id = Number(raw);
  return raw && /^\d{1,12}$/.test(raw) && Number.isSafeInteger(id) && id > 0 ? id : null;
}

const games = (n: number) => (n === 1 ? '1 game' : `${n} games`);

/** "for 4 players, within 1 hour, light" — what was asked, as the status line and empty states say it. */
export function describeFilters(f: GameFilters): string {
  const parts: string[] = [];
  if (f.players !== null) parts.push(`for ${f.players} ${f.players === 1 ? 'player' : 'players'}`);
  if (f.minutes !== null) parts.push(`within ${minutesLabel(f.minutes)}`);
  if (f.weight !== null) parts.push(WEIGHT_LABEL[f.weight].toLowerCase());
  return parts.join(', ');
}

const range = (lo: number | null, hi: number | null) => (lo === null ? null : hi === null || hi === lo ? `${lo}` : `${lo}–${hi}`);
const trim = (n: number) => String(Math.round(n * 100) / 100);

/** What the page knows of a game, as a line of mono facts; a missing one says so, since the filters depend on it. */
const GameFacts: FC<{ game: TonightGame; today: string }> = ({ game, today }) => {
  const players = range(game.playersMin, game.playersMax);
  const band = weightBand(game.weight);
  return (
    <p class="game-facts">
      {players ? (
        <span>
          {players} {game.playersMax === 1 ? 'player' : 'players'}
        </span>
      ) : (
        <span class="missing">players not known</span>
      )}
      {game.minutes !== null ? <span>{trim(game.minutes)} min</span> : <span class="missing">time not known</span>}
      {game.weight !== null && band ? (
        <span>
          {WEIGHT_LABEL[band]} · {game.weight.toFixed(2)}
        </span>
      ) : (
        <span class="missing">weight not known</span>
      )}
      <span class="game-last">{game.lastPlayed ? `last played ${playDate(game.lastPlayed, today)}` : 'not played yet'}</span>
    </p>
  );
};

const GameList: FC<{ list: TonightGame[]; today: string }> = ({ list, today }) => (
  <ul class="game-list">
    {list.map((g) => (
      <li class="game-row">
        {/* the title is the link a reader or keyboard uses; the cover is a larger target for a pointer */}
        <a href={`/items/${g.id}`} class="game-thumb" tabindex={-1} aria-hidden="true">
          <Cover coverKey={g.coverKey} title={g.title} mediaType={g.mediaType} />
        </a>
        <div class="game-body">
          <a href={`/items/${g.id}`} class="game-title">
            {g.title}
          </a>
          {g.creators ? <small class="game-by">{g.creators}</small> : null}
          <GameFacts game={g} today={today} />
        </div>
      </li>
    ))}
  </ul>
);

type ListView = { mode: 'list'; fit: TonightGame[]; fitTotal: number; unknown: TonightGame[]; unknownTotal: number };
type PickView = { mode: 'pick'; pick: TonightGame | null; fitTotal: number; unknownTotal: number };
type View = ListView | PickView;

/** The one sentence the live region reads out after every swap: how many fit, or what was picked. */
export function statusLine(view: View, f: GameFilters): string {
  const asked = describeFilters(f);
  const n = view.unknownTotal;
  const more = n ? ` ${n} more ${n === 1 ? 'game might fit, but is' : 'games might fit, but are'} missing details.` : '';
  if (!view.fitTotal && !view.unknownTotal) {
    return anyFilter(f) ? `No game fits ${asked}.` : 'No board games to play: none in the collection, or every copy is out on loan.';
  }
  if (view.mode === 'pick') {
    if (!view.pick) return `No game fits${asked ? ` ${asked}` : ''}, so there is nothing to pick.${more}`;
    return `Picked ${view.pick.title}, from ${games(view.fitTotal)} that fit.`;
  }
  if (!view.fitTotal) return `No game fits ${asked}.${more}`;
  return `${view.fitTotal === 1 ? '1 game fits' : `${view.fitTotal} games fit`}${asked ? ` ${asked}` : ''}.${more}`;
}

/** Hidden fields carrying the filters, for the "Pick another" form. */
const FilterFields: FC<{ f: GameFilters }> = ({ f }) => (
  <>
    {[...gameFilterParams(f)].map(([k, v]) => (
      <input type="hidden" name={k} value={v} />
    ))}
  </>
);

const listHref = (f: GameFilters) => {
  const qs = gameFilterParams(f).toString();
  return `/play${qs ? `?${qs}` : ''}`;
};

const Results: FC<{ view: View; f: GameFilters; today: string }> = ({ view, f, today }) => {
  if (view.mode === 'pick') {
    const pick = view.pick;
    return pick ? (
      <div class="panel read-next play-pick">
        <a href={`/items/${pick.id}`} class="read-next-cover" tabindex={-1} aria-hidden="true">
          <Cover coverKey={pick.coverKey} title={pick.title} mediaType={pick.mediaType} />
        </a>
        <div class="read-next-body">
          <p class="eyebrow">Tonight’s pick</p>
          <a href={`/items/${pick.id}`} class="read-next-title">
            {pick.title}
          </a>
          {pick.creators ? <p class="read-next-by">{pick.creators}</p> : null}
          <GameFacts game={pick} today={today} />
          <p class="read-next-line">
            <small class="acc-no">{accNo(pick.id)}</small>
          </p>
          <div class="read-actions">
            <form method="get" action="/play" hx-get="/play" hx-target="#play-results" hx-swap="innerHTML">
              <FilterFields f={f} />
              <input type="hidden" name="pick" value="1" />
              <input type="hidden" name="not" value={String(pick.id)} />
              {/* keeps its id across the swap, so htmx gives focus back to it */}
              <button type="submit" class="btn" id="play-again">
                Pick another
              </button>
            </form>
            <a href={listHref(f)}>{view.fitTotal === 1 ? 'See the game that fits' : `See all ${view.fitTotal} that fit`}</a>
          </div>
        </div>
      </div>
    ) : (
      <p class="muted play-empty">
        {view.unknownTotal ? (
          <>
            Nothing to pick from. <a href={listHref(f)}>See the {games(view.unknownTotal)} missing details</a> — one of
            them might fit.
          </>
        ) : (
          'Nothing to pick from — try more time, more players or another weight.'
        )}
      </p>
    );
  }
  return (
    <>
      {view.fit.length ? (
        <>
          <GameList list={view.fit} today={today} />
          {view.fitTotal > view.fit.length ? (
            <p class="muted play-more">
              Showing {view.fit.length} of {view.fitTotal}, in random order — narrow it down, or let it pick one.
            </p>
          ) : null}
        </>
      ) : (
        <p class="muted play-empty">
          {view.fitTotal || view.unknownTotal || anyFilter(f)
            ? 'No game fits — try more time, more players or another weight.'
            : 'No board games to play: none in the collection, or every copy is out on loan.'}
        </p>
      )}
      {view.unknown.length ? (
        <section class="play-unknown" aria-labelledby="play-unknown-head">
          <h2 class="eyebrow" id="play-unknown-head">
            Not enough details · {view.unknownTotal}
          </h2>
          <p class="muted">
            These might fit, but their details don’t say what you asked about. Fill them in on each game’s page — its
            Refresh from BGG button fills what’s blank.
          </p>
          <GameList list={view.unknown} today={today} />
          {view.unknownTotal > view.unknown.length ? (
            <p class="muted play-more">
              Showing {view.unknown.length} of {view.unknownTotal}.
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
};

const Filters: FC<{ f: GameFilters }> = ({ f }) => (
  <form method="get" action="/play" class="play-filters" hx-get="/play" hx-target="#play-results" hx-swap="innerHTML">
    <label>
      Players
      <input type="number" name="players" min="1" max="99" step="1" inputmode="numeric" value={f.players ?? ''} placeholder="Any" />
    </label>
    <label>
      Time we have
      <select name="time">
        <option value="" selected={f.minutes === null}>
          Any length
        </option>
        {/* a time from the URL that isn't one of the choices stays selected, rather than reading as "any" */}
        {[...new Set([...TIME_CHOICES, ...(f.minutes !== null ? [f.minutes] : [])])]
          .sort((a, b) => a - b)
          .map((m) => (
            <option value={String(m)} selected={f.minutes === m}>
              Up to {minutesLabel(m)}
            </option>
          ))}
      </select>
    </label>
    <label>
      Weight
      <select name="weight">
        <option value="" selected={f.weight === null}>
          Any weight
        </option>
        {WEIGHTS.map((w) => (
          <option value={w} selected={f.weight === w}>
            {WEIGHT_LABEL[w]} ({w === 'light' ? 'under 2' : w === 'heavy' ? '3 and up' : `${WEIGHT_BANDS[w].from} to under ${WEIGHT_BANDS[w].below}`})
          </option>
        ))}
      </select>
    </label>
    <div class="play-buttons">
      <button type="submit" class="btn">
        Show games
      </button>
      <button type="submit" name="pick" value="1">
        Pick one for us
      </button>
    </div>
  </form>
);

play.get('/play', async (c) => {
  const q = c.req.query();
  const f = parseGameFilters(q);
  const picking = q['pick'] === '1';
  const today = todayUtc();
  const view: View = picking
    ? { mode: 'pick', ...(await pickGameForTonight(c.env.DB, f, shownPick(q['not']))) }
    : { mode: 'list', ...(await gamesForTonight(c.env.DB, f, TONIGHT_LIMIT)) };
  const status = statusLine(view, f);
  // one URL answers both ways (the whole page, or the results for htmx), so a cache must key on the header
  c.header('Vary', 'HX-Request');

  if (c.req.header('HX-Request')) {
    return c.html(
      <>
        <Results view={view} f={f} today={today} />
        {/* out of band, into the live region that was already on the page, so a screen reader hears the change */}
        <p id="play-status" hx-swap-oob="innerHTML">
          {status}
        </p>
      </>,
    );
  }

  return page(
    c,
    'Play tonight',
    <>
      <div class="page-head">
        <div>
          <h1>What should we play tonight?</h1>
          <span class="sub">BOARD GAMES ON THE SHELVES, NOT OUT ON LOAN</span>
        </div>
      </div>
      <Filters f={f} />
      <p id="play-status" class="play-status" role="status" aria-live="polite">
        {status}
      </p>
      <div id="play-results">
        <Results view={view} f={f} today={today} />
      </div>
      {/* players, time and weight are BGG's (§16 #44): its credit sits under them */}
      <BggAttribution />
    </>,
  );
});

export default play;
