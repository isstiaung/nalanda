// libib CSV import: parse the file HERE in the browser (RFC 4180, handles quoted
// newlines), then POST small JSON batches — the Worker never parses CSV (10 ms CPU cap).

// Cover backfill: same client-drives-the-loop pattern; each request handles a small
// batch so the Worker stays inside its subrequest budget.
(() => {
  const backfillBtn = document.getElementById('backfill-run');
  const backfillStatus = document.getElementById('backfill-status');
  if (!backfillBtn || !backfillStatus) return;

  backfillBtn.addEventListener('click', async () => {
    backfillBtn.disabled = true;
    let after = 0;
    let tried = 0;
    let found = 0;
    let byTitle = 0;
    let enriched = 0;
    backfillStatus.textContent = 'Fetching covers and details…';
    for (;;) {
      let res;
      try {
        res = await fetch('/api/backfill-covers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ after }),
        });
      } catch {
        res = null;
      }
      if (!res || !res.ok) {
        backfillStatus.textContent += `\nStopped: request failed${res ? ` (${res.status})` : ''}. Click again to continue from where it left off.`;
        backfillBtn.disabled = false;
        return;
      }
      const d = await res.json();
      tried += d.tried;
      found += d.found;
      byTitle += d.byTitle ?? 0;
      enriched += d.enriched ?? 0;
      after = d.lastId;
      backfillStatus.textContent = `Scanned ${tried} items — ${found} covers added, ${enriched} details filled…`;
      if (d.done) break;
      await new Promise((r) => setTimeout(r, 300)); // politeness gap between batches
    }
    backfillStatus.textContent =
      `Done: ${found} covers added` +
      (byTitle ? ` (${byTitle} matched by title/author — worth a quick skim)` : '') +
      `, ${enriched} descriptions or details filled, ${tried - found} still without a cover. ` +
      'Safe to re-run any time.';
    backfillBtn.disabled = false;
  });
})();

(() => {
  const fileInput = document.getElementById('import-file');
  const previewBtn = document.getElementById('import-preview');
  const runBtn = document.getElementById('import-run');
  const status = document.getElementById('import-status');
  if (!fileInput || !previewBtn || !runBtn) return;

  const BATCH = 200;
  // A Nalanda export's loans cost the server about what a row does each, so a batch also stops at this many
  // (ARCH.md §16 #57); a row with more still goes, alone.
  const LOANS_PER_BATCH = 1000;
  let rows = null;

  /** [start, end) of each batch: at most BATCH rows, and at most LOANS_PER_BATCH loans unless one row has more. */
  function batches(all) {
    const out = [];
    let start = 0;
    let loans = 0;
    for (let i = 0; i < all.length; i++) {
      const n = all[i].loans ? all[i].loans.split(';').length : 0;
      if (i > start && (i - start === BATCH || loans + n > LOANS_PER_BATCH)) {
        out.push([start, i]);
        start = i;
        loans = 0;
      }
      loans += n;
    }
    if (start < all.length) out.push([start, all.length]);
    return out;
  }

  // picking a different file invalidates previously parsed rows
  fileInput.addEventListener('change', () => { rows = null; });

  const say = (msg) => { status.textContent = msg; };
  const append = (msg) => { status.textContent += `\n${msg}`; };

  function parseCsv(text) {
    const out = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') out.push(row);
        row = [];
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') out.push(row); }
    return out;
  }

  async function loadRows() {
    const file = fileInput.files?.[0];
    if (!file) { say('Pick a CSV file first.'); return null; }
    const table = parseCsv(await file.text());
    if (table.length < 2) { say('That CSV has no data rows.'); return null; }
    const headers = table[0].map((h) => h.trim());
    return table.slice(1).map((cells) => {
      const obj = {};
      headers.forEach((h, i) => { if (h) obj[h] = cells[i] ?? ''; });
      return obj;
    });
  }

  function options(dryRun, batch) {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        libraryId: Number(document.getElementById('import-library').value),
        defaultType: document.getElementById('import-default-type').value,
        musicAsVinyl: document.getElementById('import-music-as-vinyl').checked,
        dryRun,
        rows: batch,
      }),
    };
  }

  previewBtn.addEventListener('click', async () => {
    rows = await loadRows();
    if (!rows) return;
    say(`Parsed ${rows.length} rows. Checking the mapping…`);
    const res = await fetch('/api/import', options(true, rows.slice(0, 200)));
    if (!res.ok) { append(`Preview failed (${res.status}).`); return; }
    const data = await res.json();
    const sampled = Math.min(200, rows.length);
    append(`Sample of first ${sampled} rows: ${data.mapped} map cleanly, ${data.skipped} would be skipped (no title).`);
    if (data.format === 'nalanda') {
      append(`Nalanda export detected: every column maps back as it was exported, into the shelf chosen above. Types: ${Object.entries(data.byType).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}`);
      append('Rows are added, never merged — importing the same export into this library twice adds everything twice.');
      if (data.loans) append(`Loans in the first ${sampled} rows: ${data.loans} (${data.loansOut} still out), restored onto the items they belong to. A loan to a connected household comes back as an ordinary loan under the name it was lent to.`);
      // whose each read and review becomes: a member of the same name here, or you
      const people = data.importer ? (data.people ?? []) : [];
      if (people.length) {
        if (!data.keepsNames) append(`As a member, everything in this file becomes yours (${data.importer}): only an admin's import keeps each reader's and reviewer's name.`);
        append(`Readers and reviewers in the first ${sampled} rows:`);
        const brings = (p) => [p.reads ? `${p.reads} ${p.reads === 1 ? 'read' : 'reads'}` : '', p.reviews ? `${p.reviews} ${p.reviews === 1 ? 'review' : 'reviews'}` : ''].filter(Boolean).join(', ');
        for (const p of people) {
          const who = p.former ? 'a former member' : p.name === null ? 'nobody named (an older export)' : p.name;
          const as = p.former ? 'kept unattributed' : p.known ? `→ ${p.as}` : `→ you (${data.importer})${p.name === null ? '' : ': no member here has that name'}`;
          append(`  · ${who}: ${brings(p)} ${as}`);
        }
      }
    } else if (data.format === 'goodreads') {
      append(`Goodreads export detected: ${data.merged} match books already here (rating/review/shelves will merge onto them — Goodreads wins), ${data.fresh} are new (added as “Not owned” reading-log entries).`);
      append(`Reading history: ${data.reads ?? 0} reads to add or date from shelves, Date Read and Read Count — reads already recorded here are never removed, and a second import adds nothing.`);
      if (data.importer) append(`These reads, ratings and reviews become yours (${data.importer}); everyone else's stay as they are.`);
    } else {
      append(`Types: ${Object.entries(data.byType).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}`);
      if (data.importer) append(`Reads, ratings and reviews in this file become yours (${data.importer}).`);
    }
    for (const s of data.sample) {
      append(`  · [${s.mediaType}] ${s.title}${s.creators ? ` — ${s.creators}` : ''}${s.tags.length ? ` (${s.tags.join(', ')})` : ''}`);
    }
    append(`Ready to import all ${rows.length} rows.`);
  });

  runBtn.addEventListener('click', async () => {
    if (!rows) rows = await loadRows(); // Preview is optional — load directly
    if (!rows) return; // loadRows already explained what's missing
    runBtn.disabled = true;
    previewBtn.disabled = true;
    let inserted = 0;
    let merged = 0;
    let skipped = 0;
    say(`Importing ${rows.length} rows…`);
    for (const [i, end] of batches(rows)) {
      const res = await fetch('/api/import', options(false, rows.slice(i, end)));
      if (!res.ok) {
        append(`Batch at row ${i} failed (${res.status}) — stopped. ${inserted} imported so far; re-run after fixing (already-imported rows merge instead of duplicating).`);
        previewBtn.disabled = false;
        return;
      }
      const data = await res.json();
      inserted += data.inserted;
      merged += data.merged ?? 0;
      skipped += data.skipped;
      say(`Importing… ${end}/${rows.length} (${inserted} added${merged ? `, ${merged} merged` : ''})`);
    }
    say(
      `Done: ${inserted} items added${merged ? `, ${merged} merged onto existing items` : ''}, ${skipped} rows skipped (no title).` +
      (inserted ? ' New items arrive without covers — reload this page and run the cover backfill.' : ' Head to your library →'),
    );
    previewBtn.disabled = false;
    runBtn.disabled = false;
  });
})();

// CSV export, the same way round: fetch the export a page at a time (/export.csv?after=…), each
// request well inside the 10 ms CPU cap, and join the pages here into one file. A page that
// fails fails the export — nothing partial is saved. Without JavaScript the link still
// downloads, streamed in one request (ARCH.md §16 #38).
(() => {
  const link = document.querySelector('a[data-export]');
  const status = document.getElementById('export-status');
  if (!link || !status || !window.Blob || !window.URL?.createObjectURL) return;
  let busy = false;

  link.addEventListener('click', async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    link.setAttribute('aria-disabled', 'true');
    const parts = [];
    let items = 0;
    let filename = 'nalanda-export.csv';
    status.textContent = 'Exporting…';
    try {
      const url = new URL(link.href);
      let after = '0';
      for (;;) {
        url.searchParams.set('after', after);
        // a lapsed session redirects to the login page, which must not end up inside the file
        const res = await fetch(url, { redirect: 'error', cache: 'no-store' });
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        if (!(res.headers.get('content-type') || '').startsWith('text/csv')) throw new Error('the server sent something other than CSV');
        if (after === '0') {
          filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || filename;
        }
        parts.push(await res.text());
        items += Number(res.headers.get('x-export-rows') || 0);
        const next = res.headers.get('x-export-next');
        if (!next) break;
        after = next;
        status.textContent = `Exporting… ${items} items so far`;
      }
      const href = URL.createObjectURL(new Blob(parts, { type: 'text/csv;charset=utf-8' }));
      const save = document.createElement('a');
      save.href = href;
      save.download = filename;
      document.body.append(save);
      save.click();
      save.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
      status.textContent = `Exported ${items} ${items === 1 ? 'item' : 'items'} to ${filename}.`;
    } catch (err) {
      status.textContent = `Export failed partway (${err instanceof Error ? err.message : 'no answer'}), so nothing was saved. Try again.`;
    } finally {
      busy = false;
      link.removeAttribute('aria-disabled');
    }
  });
})();
