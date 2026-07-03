import { Hono } from 'hono';
import { listLibraries } from '../db/queries';
import type { AppEnv } from '../env';
import { lookupByBarcode, searchByName, type SearchType } from '../metadata';
import { CandidateCard, ItemForm } from '../views/components';
import { page } from '../views/layout';

const add = new Hono<AppEnv>();

add.get('/add', async (c) => {
  const libs = await listLibraries(c.env.DB);
  return page(
    c,
    'Add',
    <>
      <h1>Add to your library</h1>
      <div role="group" class="tab-bar">
        <button type="button" class="tab active" data-tab="scan">
          📷 Scan
        </button>
        <button type="button" class="tab" data-tab="search">
          🔎 Search
        </button>
        <button type="button" class="tab" data-tab="manual">
          ✍️ Manual
        </button>
      </div>

      <section id="tab-scan" class="tab-panel active">
        <p class="muted">
          Point the camera at a book or record barcode. ISBNs look up books; other barcodes look up vinyl on
          Discogs. Board games have no barcodes on BGG — use the Search tab.
        </p>
        <video id="scanner-video" playsinline muted></video>
        <div class="inline-form">
          <button type="button" id="scanner-start">
            Start camera
          </button>
          <button type="button" id="scanner-stop" class="secondary" hidden>
            Stop
          </button>
        </div>
        <p id="scanner-status" class="muted" aria-live="polite"></p>
        <form
          class="inline-form"
          hx-get="/add/results"
          hx-target="#scan-results"
          hx-swap="innerHTML"
        >
          <input name="barcode" placeholder="…or type the barcode digits" inputmode="numeric" />
          <button type="submit" class="secondary">
            Look up
          </button>
        </form>
        <div id="scan-results"></div>
      </section>

      <section id="tab-search" class="tab-panel" hidden>
        <form hx-get="/add/results" hx-target="#search-results" hx-swap="innerHTML" class="inline-form">
          <input type="search" name="q" placeholder="Title, artist, game name…" required />
          <select name="type" aria-label="What is it?">
            <option value="book">📖 Book</option>
            <option value="boardgame">🎲 Board game</option>
            <option value="vinyl">💿 Vinyl</option>
          </select>
          <button type="submit">Search</button>
        </form>
        <div id="search-results"></div>
      </section>

      <section id="tab-manual" class="tab-panel" hidden>
        <ItemForm libraries={libs} action="/items" submitLabel="Add item" />
      </section>
    </>,
  );
});

/** htmx partial shared by the scanner and the search tab. */
add.get('/add/results', async (c) => {
  const barcode = c.req.query('barcode')?.trim();
  const q = c.req.query('q')?.trim();
  const typeParam = c.req.query('type');
  const type: SearchType = typeParam === 'boardgame' || typeParam === 'vinyl' ? typeParam : 'book';

  const result = barcode
    ? await lookupByBarcode(c.env, barcode)
    : q
      ? await searchByName(c.env, q, type)
      : { candidates: [], notices: ['Enter a barcode or search term.'] };

  const libs = await listLibraries(c.env.DB);
  return c.html(
    <>
      {result.notices.map((n) => (
        <p class="notice">{n}</p>
      ))}
      {result.candidates.map((candidate) => (
        <CandidateCard candidate={candidate} libraries={libs} />
      ))}
    </>,
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
