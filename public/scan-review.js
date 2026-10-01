// The Add page's review list (ARCH.md §16 #48, #94): barcodes held on this device — scanned with no signal, or with
// "Keep scanning" on — one list whichever way they came. An entry is the barcode and when it was scanned; nothing is
// looked up at scan time. "Add all to <shelf>" sends them to POST /api/scans/add twenty at a time (nalandaScanBatch,
// below): the server looks each one up, leaves alone what the catalog already has and adds the rest as bare records,
// and the list says what became of each — added and already-here entries leave the device's queue; a book the catalog
// may hold under no ISBN (met by title and author) stays, named, for someone to look up and decide; a barcode nothing
// was found for stays, with a way to add it by hand. "Look up" on one entry fetches it alone through GET /add/review,
// to pick its shelf, add it, want it or drop it; it leaves the queue only once the server has said it was added.

// The batch loop, with no DOM in it, so a test runs it as import.js's is run (test/scan-batch-browser.spec.ts).
window.nalandaScanBatch = (() => {
  const SIZE = 20; // MAX_SCANS_PER_REQUEST in src/routes/add.tsx: twenty keep one request inside its subrequest budget

  /** The codes in batches of SIZE, in order; a barcode listed twice goes once. */
  function split(codes) {
    const out = [];
    const seen = new Set();
    for (const entry of codes) {
      if (seen.has(entry.code)) continue;
      seen.add(entry.code);
      if (!out.length || out[out.length - 1].length === SIZE) out.push([]);
      out[out.length - 1].push(entry);
    }
    return out;
  }

  /**
   * Posts every batch in turn and tallies the answers; `onBatch` sees each answer as it lands. Stops at the first batch
   * that fails — a refusal, a lapsed session, no connection — and says so in `failed`: what was sent before it stands,
   * and the rest stays held.
   */
  async function run({ codes, libraryId, scanOwner, onBatch, fetch: doFetch }) {
    const send = doFetch || ((...args) => fetch(...args));
    const tally = { added: [], already: [], maybe: [], notFound: [], notices: [], sent: 0, failed: null };
    for (const batch of split(codes)) {
      let res = null;
      try {
        res = await send('/api/scans/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ libraryId: Number(libraryId), codes: batch, scanOwner }),
          redirect: 'manual',
        });
      } catch {
        res = null;
      }
      // our own server's answer, and only a real one: a lapsed session redirects to the login page
      const signedOut = !!res && (res.type === 'opaqueredirect' || res.status === 0);
      if (!res || signedOut || !res.ok) {
        let why = !res ? 'No connection.' : signedOut ? 'Signed out — reload and sign in.' : `Failed (${res.status}).`;
        if (res && !signedOut) {
          try {
            const data = await res.json();
            if (data && typeof data.error === 'string') why = data.error;
          } catch { /* not JSON: the status says it */ }
        }
        tally.failed = { at: tally.sent, why };
        break;
      }
      const data = await res.json();
      tally.added.push(...(data.added || []));
      tally.already.push(...(data.already || []));
      tally.maybe.push(...(data.maybe || []));
      tally.notFound.push(...(data.notFound || []));
      for (const n of data.notices || []) if (!tally.notices.includes(n)) tally.notices.push(n);
      tally.sent += batch.length;
      if (onBatch) await onBatch(data, batch);
    }
    return tally;
  }

  return { SIZE, split, run };
})();

(() => {
  const section = document.getElementById('scan-review');
  const list = document.getElementById('scan-review-list');
  const queue = window.nalandaScanQueue;
  if (!section || !list || !queue) return;
  const countEl = document.getElementById('scan-review-count');
  const nounEl = document.getElementById('scan-review-noun');
  const statusEl = document.getElementById('scan-review-status');
  const allForm = document.getElementById('scan-review-all');
  const allSelect = allForm?.querySelector('select');
  const allButton = allForm?.querySelector('button');
  const allName = allForm?.querySelector('[data-shelf-name]');

  let loading = false;
  let addingAll = false;
  const tell = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };
  const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

  const waiting = () => [...list.querySelectorAll('.review-entry[data-barcode]:not([data-added])')];

  function refresh() {
    const left = waiting();
    const done = list.querySelectorAll('[data-added]').length;
    countEl.textContent = String(left.length);
    nounEl.textContent = left.length ? 'held on this device' : 'left — all done';
    section.hidden = !left.length && !done;
    if (allForm) {
      allForm.hidden = !left.length;
      allButton.disabled = loading || addingAll || !left.length;
    }
  }

  // the ledger's form, as every date in the app (src/lib/dates.ts): "2026-09-30 18:28", in this device's own time
  const two = (n) => String(n).padStart(2, '0');
  const ledgerDateTime = (d) =>
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  const localTime = (root) =>
    root.querySelectorAll('time[datetime]').forEach((t) => {
      const d = new Date(t.getAttribute('datetime'));
      if (!Number.isNaN(d.getTime())) t.textContent = ledgerDateTime(d);
    });

  const button = (label, attr) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.setAttribute(attr, '');
    b.textContent = label;
    return b;
  };

  /** A held barcode as the list shows it before anything is looked up: the code, when it was scanned, Look up, Drop. */
  function held(scan) {
    const el = document.createElement('article');
    el.className = 'candidate review-entry';
    el.dataset.barcode = scan.barcode;
    el.dataset.scannedAt = scan.scannedAt || '';
    const cover = document.createElement('div');
    cover.className = 'candidate-cover';
    const box = document.createElement('div');
    box.className = 'cover-fallback';
    box.setAttribute('aria-hidden', 'true');
    box.textContent = '▥';
    cover.append(box);
    const body = document.createElement('div');
    body.className = 'candidate-body';
    const code = document.createElement('small');
    code.className = 'review-scan';
    code.textContent = scan.barcode;
    const at = scan.scannedAt ? new Date(scan.scannedAt) : null;
    if (at && !Number.isNaN(at.getTime())) {
      const time = document.createElement('time');
      time.setAttribute('datetime', scan.scannedAt);
      time.textContent = ledgerDateTime(at);
      code.append(' · scanned ', time);
    }
    const note = document.createElement('div');
    note.className = 'muted review-held';
    note.textContent = 'Held. "Add all" looks it up and adds it — or look it up here to choose.';
    const actions = document.createElement('div');
    actions.className = 'candidate-save';
    actions.append(button('Look up', 'data-review-lookup'), button('Drop', 'data-review-drop'));
    body.append(code, note, actions);
    el.append(cover, body);
    return el;
  }

  /**
   * A line under an entry saying what went wrong, or what to do next — with a link when there is somewhere to go, and
   * text after it when there is more to say. `tone` 'note' for news that isn't an error.
   */
  function trouble(entry, message, link, after = '', tone = 'error') {
    let line = entry.querySelector('.review-trouble');
    if (!line) {
      line = document.createElement('p');
      entry.querySelector('.candidate-body')?.append(line);
    }
    line.className = `${tone === 'note' ? 'muted' : 'error'} review-trouble`;
    line.textContent = message;
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.text;
      line.append(a, after);
    }
  }

  // Our own server's answer, and only a real one: a lapsed session redirects to the login page, which must never
  // be taken for an entry.
  async function partial(response) {
    if (response.type === 'opaqueredirect' || response.status === 0) throw new Error('Signed out — reload and sign in.');
    const text = await response.text();
    if (!response.ok) throw new Error(text.slice(0, 200) || `Failed (${response.status}).`);
    const template = document.createElement('template');
    template.innerHTML = text;
    const entry = template.content.querySelector('.review-entry');
    if (!entry) throw new Error('Unexpected answer.');
    return entry;
  }

  /** One entry looked up alone: the server renders it with its shelf, Add, Want and Drop (ReviewEntry). */
  async function lookUp(entry) {
    const buttons = [...entry.querySelectorAll('button')];
    buttons.forEach((b) => (b.disabled = true));
    const params = new URLSearchParams({ barcode: entry.dataset.barcode, scanned: entry.dataset.scannedAt ?? '' });
    try {
      const fresh = await partial(
        await fetch(`/add/review?${params}`, { headers: { 'HX-Request': 'true' }, redirect: 'manual' }),
      );
      fresh.dataset.scannedAt = entry.dataset.scannedAt ?? '';
      const select = fresh.querySelector('select[name="libraryId"]');
      if (select && allSelect) select.value = allSelect.value;
      localTime(fresh);
      entry.replaceWith(fresh);
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      trouble(entry, `${err.message || 'Couldn’t look it up.'} It stays held.`);
    }
    refresh();
  }

  /** Lists what the device holds — an entry for each barcode not shown yet. Nothing is looked up. */
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const scans = await queue.list();
      const shown = new Set([...list.querySelectorAll('.review-entry[data-barcode]')].map((e) => e.dataset.barcode));
      list.append(...scans.filter((scan) => !shown.has(scan.barcode)).map(held));
    } catch {
      // the queue couldn't be read (storage blocked): nothing to show
    } finally {
      loading = false;
      refresh();
    }
  }

  // Add, or Want (`submitter`, its name and value sent as a form's own submit would): either way the entry leaves
  // the queue only once the server has answered with it done.
  async function add(form, submitter) {
    const entry = form.closest('.review-entry');
    const buttons = [...entry.querySelectorAll('button')];
    const body = new FormData(form);
    if (submitter?.name) body.set(submitter.name, submitter.value);
    buttons.forEach((b) => (b.disabled = true));
    try {
      const added = await partial(
        await fetch('/items', { method: 'POST', body, headers: { 'HX-Request': 'true' }, redirect: 'manual' }),
      );
      entry.replaceWith(added);
      await queue.remove(entry.dataset.barcode);
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      trouble(entry, `${err.message || 'Couldn’t add it.'} It stays held.`);
    }
    refresh();
  }

  async function drop(entry) {
    await queue.remove(entry.dataset.barcode);
    entry.remove();
    refresh();
  }

  /** What "Add all" made of an entry — added, or already in the catalog: out of the queue, and the line says which. */
  async function settle(entry, outcome, kind, shelf) {
    if (!entry) return;
    await queue.remove(outcome.code);
    const done = document.createElement('article');
    done.className = 'notice review-entry';
    done.dataset.added = '';
    const a = document.createElement('a');
    a.href = `/items/${outcome.id}`;
    a.textContent = outcome.title || outcome.code;
    if (kind === 'added') done.append('Added ', a, ` to ${shelf}.`);
    else done.append('Already in the catalog: ', a, '.');
    entry.replaceWith(done);
  }

  /** A barcode nothing was found for: it stays held, with a way to add it by hand (the manual form, prefilled). */
  function unknown(entry, code) {
    if (!entry) return;
    entry.dataset.unknown = '';
    trouble(entry, `Nothing found for ${code} — it stays held. `, { href: `/add?barcode=${encodeURIComponent(code)}`, text: 'Add by hand' });
  }

  /**
   * A book the catalog may already hold under no ISBN, met by title and author: held, not added — the entry names the
   * catalog's copy (Not owned when it is: its page's Holding toggle is then the next step) and keeps Look up to decide.
   */
  function perhaps(entry, hit) {
    if (!entry) return;
    entry.dataset.maybe = '';
    const after = `${hit.notOwned ? ' (Not owned)' : ''} — look up to decide.`;
    trouble(entry, 'Maybe already here: ', { href: `/items/${hit.id}`, text: hit.title || hit.code }, after, 'note');
  }

  /** The run's report: the four counts, then what to do about what's left and what the new items still lack. */
  function report(tally, total) {
    let msg = `${tally.added.length} added, ${tally.already.length} already here, ${tally.maybe.length} maybe already here, ${tally.notFound.length} not found.`;
    if (tally.maybe.length) msg += ' A book that may be here already is held, with the copy named — look it up to decide.';
    if (tally.notFound.length) msg += ' Unknown barcodes stay on the list — look one up again, or add it by hand.';
    if (tally.notices.length) msg += ` ${tally.notices.join(' ')}`;
    if (tally.added.length) msg += ' New items arrive without covers — run the cover backfill on the Import page.';
    if (tally.failed) msg += ` Stopped after ${tally.failed.at} of ${total}: ${tally.failed.why} The rest stays held — press Add all again.`;
    return msg;
  }

  list.addEventListener('submit', (e) => {
    const form = e.target.closest?.('form[data-review-add]');
    if (!form) return;
    e.preventDefault();
    add(form, e.submitter);
  });

  list.addEventListener('click', (e) => {
    const entry = e.target.closest?.('.review-entry');
    if (!entry) return;
    if (e.target.closest('[data-review-drop]')) drop(entry);
    if (e.target.closest('[data-review-lookup], [data-review-retry]')) lookUp(entry);
  });

  allSelect?.addEventListener('change', () => {
    allName.textContent = allSelect.selectedOptions[0]?.textContent ?? '';
  });

  // "Add all to <shelf>": every waiting entry, twenty a request, each looked up by the server and added there — the
  // entries settle as each answer lands, and the status line says where it got to and, at the end, what it did.
  allForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (addingAll) return;
    const entries = waiting();
    if (!entries.length) return;
    addingAll = true;
    refresh();
    const shelf = allSelect.selectedOptions[0]?.textContent ?? '';
    const byCode = new Map(entries.map((el) => [el.dataset.barcode, el]));
    const total = byCode.size;
    let sent = 0;
    tell(`Adding ${plural(total, 'barcode')} to ${shelf}…`);
    const tally = await window.nalandaScanBatch.run({
      codes: entries.map((el) => ({ code: el.dataset.barcode, at: el.dataset.scannedAt || '' })),
      libraryId: allSelect.value,
      scanOwner: document.body.dataset.scanOwner || '',
      onBatch: async (data, batch) => {
        for (const a of data.added || []) await settle(byCode.get(a.code), a, 'added', shelf);
        for (const a of data.already || []) await settle(byCode.get(a.code), a, 'already', shelf);
        for (const m of data.maybe || []) perhaps(byCode.get(m.code), m);
        for (const code of data.notFound || []) unknown(byCode.get(code), code);
        sent += batch.length;
        refresh();
        if (sent < total) tell(`Adding… ${sent}/${total}`);
      },
    });
    addingAll = false;
    refresh();
    tell(report(tally, total));
  });

  // Someone else signed in from another tab (app.js rewrote the stamp and emptied the queue): this list isn't theirs.
  window.addEventListener('storage', (e) => {
    if (e.key === queue.OWNER_KEY) location.reload();
  });

  // A barcode held by the scanner on this page — offline, or with "Keep scanning" on — joins the list at once.
  document.addEventListener('nalanda:held', load);

  load();
})();
