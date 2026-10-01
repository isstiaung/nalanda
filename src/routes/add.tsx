import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import { catalogMatches, getSiteSettings, listLibraries, listPeople, seriesNames, shelfForType } from '../db/queries';
import type { AppEnv } from '../env';
import { lookupByBarcode, searchByName, type SearchType } from '../metadata';
import { BggAttribution, DiscogsNotice } from '../views/attribution';
import { scanQueueOwner } from '../lib/auth';
import { CandidateCard, ItemForm, MEDIA_ICON, ReviewEntry, SCANNED_AT } from '../views/components';
import { Fill, mediaLabel, useI18n } from '../views/i18n';
import { page, partial } from '../views/layout';

const add = new Hono<AppEnv>();

add.get('/add', async (c) => {
  const [libs, people, names, settings] = await Promise.all([
    listLibraries(c.env.DB),
    listPeople(c.env.DB),
    seriesNames(c.env.DB),
    getSiteSettings(c.env.DB), // the household's currency, for the manual form's purchase price (§16 #61)
  ]);
  const i18n = c.get('i18n');
  const { t } = i18n;
  return page(
    c,
    t('add.title'),
    <>
      <div class="page-head">
        <div>
          <h1>{t('add.title')}</h1>
          <span class="sub">{t('add.sub')}</span>
        </div>
      </div>
      {/* Scans held on this device while it was offline (ARCH.md §16 #48). scan-review.js shows this only when there
          are some, and looks each one up through /add/review; nothing is added until someone presses a button. */}
      <section id="scan-review" class="scan-review" hidden>
        <p class="eyebrow">{t('add.held')}</p>
        <article class="notice scan-review-head">
          <div>
            <strong>
              <span id="scan-review-count" class="mono">
                0
              </span>{' '}
              <span id="scan-review-noun">{t('add.held_noun')}</span>
            </strong>
            <p class="muted">{t('add.held_intro')}</p>
          </div>
          {libs.length ? (
            <form id="scan-review-all" class="inline-form">
              <select name="libraryId" aria-label={t('add.shelf_for_all')}>
                {libs.map((l) => (
                  <option value={String(l.id)}>{l.name}</option>
                ))}
              </select>
              <button type="submit" disabled>
                {/* one inline run: a button lays its children out with a gap */}
                <span>
                  <Fill text={t('add.add_all_to')} with={{ shelf: <span data-shelf-name>{libs[0]?.name}</span> }} />
                </span>
              </button>
            </form>
          ) : null}
        </article>
        <div id="scan-review-list"></div>
      </section>
      {/* toggle buttons: aria-pressed says which panel is showing (app.js keeps it in step) */}
      <div class="tab-bar">
        <button type="button" class="tab active" data-tab="scan" aria-pressed="true">
          <span aria-hidden="true">📷</span> {t('add.tab_scan')}
        </button>
        <button type="button" class="tab" data-tab="search" aria-pressed="false">
          <span aria-hidden="true">🔎</span> {t('add.tab_search')}
        </button>
        <button type="button" class="tab" data-tab="manual" aria-pressed="false">
          <span aria-hidden="true">✍️</span> {t('add.tab_manual')}
        </button>
      </div>

      <section id="tab-scan" class="tab-panel active">
        <p class="muted">{t('add.scan_intro')}</p>
        <video id="scanner-video" playsinline muted></video>
        <div class="inline-form">
          <button type="button" id="scanner-start">
            {t('add.start_camera')}
          </button>
          <button type="button" id="scanner-stop" class="btn" hidden>
            {t('add.stop')}
          </button>
        </div>
        <p id="scanner-status" class="muted" aria-live="polite"></p>
        <form
          class="inline-form"
          hx-get="/add/results"
          hx-target="#scan-results"
          hx-swap="innerHTML"
        >
          <label>
            {t('add.barcode')} <small>{t('add.barcode_hint')}</small>
            <input name="barcode" placeholder={t('add.barcode_placeholder')} inputmode="numeric" autocomplete="off" />
          </label>
          <button type="submit">{t('add.look_up')}</button>
        </form>
        <div id="scan-results"></div>
      </section>

      <section id="tab-search" class="tab-panel" hidden>
        <form hx-get="/add/results" hx-target="#search-results" hx-swap="innerHTML" class="inline-form">
          <input type="search" name="q" placeholder={t('add.search_placeholder')} aria-label={t('add.search_label')} required />
          <select name="type" aria-label={t('add.what_is_it')}>
            <option value="book">{MEDIA_ICON.book} {mediaLabel(i18n, 'book')}</option>
            <option value="boardgame">{MEDIA_ICON.boardgame} {mediaLabel(i18n, 'boardgame')}</option>
            <option value="vinyl">{MEDIA_ICON.vinyl} {mediaLabel(i18n, 'vinyl')}</option>
          </select>
          <button type="submit">{t('add.search')}</button>
        </form>
        <div id="search-results"></div>
      </section>

      <section id="tab-manual" class="tab-panel" hidden>
        <ItemForm
          libraries={libs}
          action="/items"
          submitLabel={t('add.submit')}
          perMember={people.length > 1}
          seriesNames={names}
          money={{ household: settings.currency, admin: c.get('user').role === 'admin' }}
        />
      </section>
      <script src="/scan-queue.js" defer></script>
      <script src="/scanner.js" defer></script>
      <script src="/scan-review.js" defer></script>
    </>,
    libs, // the sidebar's list too (§16 #68)
  );
});

/** How far "More results" goes: fifty pages of eight is 400 results, past anything worth scrolling. */
const LAST_PAGE = 50;

/**
 * "More results", after a page of name-search results: the next page, swapped in where the button was. The next
 * page arrives wrapped in an element with the same id, so the page-wide focus handler (public/app.js) lands on it and
 * Tab carries on into the new results.
 */
const MoreResults: FC<{ q: string; type: SearchType; page: number }> = ({ q, type, page }) => {
  const id = `results-more-${page}`;
  return (
    <div id={id} class="results-more">
      <button type="button" class="btn" hx-get={`/add/results?${new URLSearchParams({ q, type, page: String(page) })}`} hx-target={`#${id}`} hx-swap="outerHTML">
        {useI18n().t('add.more_results')}
      </button>
    </div>
  );
};

/** htmx partial shared by the scanner and the search tab; a name search comes a page at a time. */
add.get('/add/results', async (c) => {
  const barcode = c.req.query('barcode')?.trim();
  const q = c.req.query('q')?.trim();
  const typeParam = c.req.query('type');
  const type: SearchType = typeParam === 'boardgame' || typeParam === 'vinyl' ? typeParam : 'book';
  const asked = Number.parseInt(c.req.query('page') ?? '1', 10);
  const pageNo = barcode ? 1 : Math.min(Math.max(Number.isFinite(asked) ? asked : 1, 1), LAST_PAGE);

  const result = barcode
    ? await lookupByBarcode(c.env, barcode)
    : q
      ? await searchByName(c.env, q, type, pageNo)
      : { candidates: [], notices: ['Enter a barcode or search term.'] };

  // the shelves, which shelf each type starts on, and which results the catalog already has ("In your catalog"):
  // three calls, whatever the list's length
  const [libs, shelfFor, held] = await Promise.all([
    listLibraries(c.env.DB),
    shelfForType(c.env.DB),
    catalogMatches(c.env.DB, result.candidates),
  ]);
  const cards = (
    <>
      {result.notices.map((n) => (
        <p class="notice">{n}</p>
      ))}
      {result.candidates.map((candidate, i) => (
        <CandidateCard candidate={candidate} libraries={libs} inCatalog={held[i]} shelfFor={shelfFor} />
      ))}
      {q && !barcode && result.more && pageNo < LAST_PAGE ? <MoreResults q={q} type={type} page={pageNo + 1} /> : null}
    </>
  );
  // a later page takes the place of the button that asked for it, under the same id; the credits are already there
  if (pageNo > 1) {
    return partial(
      c,
      <div id={`results-more-${pageNo}`} class="results-page">
        {cards}
      </div>,
    );
  }
  return partial(
    c,
    <>
      {cards}
      {result.candidates.some((candidate) => candidate.provider === 'bgg') ? <BggAttribution /> : null}
      {/* §16 #63: each Discogs result carries its own credit; the terms' notice goes once, below them */}
      {result.candidates.some((candidate) => candidate.provider === 'discogs') ? <DiscogsNotice /> : null}
    </>,
  );
});

/**
 * One entry of the Add page's review list: a barcode held on the device while offline, looked up now — the same
 * lookup as /api/lookup, one barcode a request so each stays inside a request's subrequest and CPU budget.
 * `scanned` is the time the device recorded, shown back and nothing more. Always a partial: there's no page here.
 */
add.get('/add/review', async (c) => {
  const barcode = c.req.query('barcode')?.trim() ?? '';
  if (!/^\d{8,14}$/.test(barcode)) return c.text('Not a barcode.', 400);
  const scanned = c.req.query('scanned')?.trim() ?? '';
  const [result, libs, shelfFor, scanOwner] = await Promise.all([
    lookupByBarcode(c.env, barcode),
    listLibraries(c.env.DB),
    shelfForType(c.env.DB),
    scanQueueOwner(c.env.SESSION_SECRET ?? '', c.get('user')),
  ]);
  const [held] = result.candidates[0] ? await catalogMatches(c.env.DB, [result.candidates[0]]) : [null];
  return c.html(
    <ReviewEntry
      barcode={barcode}
      scannedAt={SCANNED_AT.test(scanned) ? scanned : null}
      candidate={result.candidates[0] ?? null}
      notices={result.notices}
      libraries={libs}
      scanOwner={scanOwner}
      inCatalog={held}
      shelfFor={shelfFor}
    />,
  );
});

/** Same lookup as JSON, for scripting/tests. */
add.get('/api/lookup', async (c) => {
  const barcode = c.req.query('barcode')?.trim();
  const q = c.req.query('q')?.trim();
  const typeParam = c.req.query('type');
  const type: SearchType = typeParam === 'boardgame' || typeParam === 'vinyl' ? typeParam : 'book';
  if (barcode) return c.json(await lookupByBarcode(c.env, barcode));
  if (q) return c.json(await searchByName(c.env, q, type));
  return c.json({ candidates: [], notices: ['Pass ?barcode= or ?q=&type='] }, 400);
});

export default add;
