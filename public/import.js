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
    backfillStatus.textContent = 'Fetching covers…';
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
      after = d.lastId;
      backfillStatus.textContent = `Scanned ${tried} items — ${found} covers added…`;
      if (d.done) break;
      await new Promise((r) => setTimeout(r, 300)); // politeness gap between batches
    }
    backfillStatus.textContent = `Done: ${found} covers added, ${tried - found} without a match at the providers. Safe to re-run any time.`;
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
  let rows = null;

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
    append(`Sample of first ${Math.min(200, rows.length)} rows: ${data.mapped} map cleanly, ${data.skipped} would be skipped (no title).`);
    append(`Types: ${Object.entries(data.byType).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}`);
    for (const s of data.sample) {
      append(`  · [${s.mediaType}] ${s.title}${s.creators ? ` — ${s.creators}` : ''}${s.tags.length ? ` (${s.tags.join(', ')})` : ''}`);
    }
    append(`Ready to import all ${rows.length} rows.`);
    runBtn.disabled = false;
  });

  runBtn.addEventListener('click', async () => {
    if (!rows) return;
    runBtn.disabled = true;
    previewBtn.disabled = true;
    let inserted = 0;
    let skipped = 0;
    say(`Importing ${rows.length} rows…`);
    for (let i = 0; i < rows.length; i += BATCH) {
      const res = await fetch('/api/import', options(false, rows.slice(i, i + BATCH)));
      if (!res.ok) {
        append(`Batch at row ${i} failed (${res.status}) — stopped. ${inserted} imported so far; re-run after fixing.`);
        previewBtn.disabled = false;
        return;
      }
      const data = await res.json();
      inserted += data.inserted;
      skipped += data.skipped;
      say(`Importing… ${Math.min(i + BATCH, rows.length)}/${rows.length} (${inserted} added)`);
    }
    say(`Done: ${inserted} items imported, ${skipped} rows skipped (no title). Head to your library →`);
    previewBtn.disabled = false;
  });
})();
