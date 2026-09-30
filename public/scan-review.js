// The Add page's review list (ARCH.md §16 #48): barcodes held on this device while it was offline, each looked up
// now through GET /add/review, two at a time. For each one the person picks a shelf and adds it or drops it, or
// adds them all to one shelf. Nothing is added unless someone presses a button, and an entry leaves the device's
// queue only once the server has said it was added — or when it's dropped.
(() => {
  const section = document.getElementById('scan-review');
  const list = document.getElementById('scan-review-list');
  const queue = window.nalandaScanQueue;
  if (!section || !list || !queue) return;
  const countEl = document.getElementById('scan-review-count');
  const nounEl = document.getElementById('scan-review-noun');
  const allForm = document.getElementById('scan-review-all');
  const allSelect = allForm?.querySelector('select');
  const allButton = allForm?.querySelector('button');
  const allName = allForm?.querySelector('[data-shelf-name]');

  let loading = false;
  let addingAll = false;

  const waiting = () => [...list.querySelectorAll('.review-entry[data-barcode]:not([data-added])')];

  function refresh() {
    const left = waiting();
    const added = list.querySelectorAll('[data-added]').length;
    countEl.textContent = String(left.length);
    nounEl.textContent = left.length ? 'scanned while offline' : 'left to review — all done';
    section.hidden = !left.length && !added;
    if (allForm) {
      allForm.hidden = !left.length;
      allButton.disabled = loading || addingAll || !list.querySelector('form[data-review-add]');
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

  function placeholder(scan) {
    const el = document.createElement('article');
    el.className = 'candidate review-entry';
    el.dataset.barcode = scan.barcode;
    el.dataset.scannedAt = scan.scannedAt;
    const cover = document.createElement('div');
    cover.className = 'candidate-cover';
    const box = document.createElement('div');
    box.className = 'cover-fallback';
    box.setAttribute('aria-hidden', 'true');
    box.textContent = '…';
    cover.append(box);
    const body = document.createElement('div');
    body.className = 'candidate-body';
    const code = document.createElement('small');
    code.className = 'review-scan';
    code.textContent = scan.barcode;
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = 'Looking it up…';
    body.append(code, note);
    el.append(cover, body);
    return el;
  }

  function trouble(entry, message) {
    let line = entry.querySelector('.review-trouble');
    if (!line) {
      line = document.createElement('p');
      line.className = 'error review-trouble';
      entry.querySelector('.candidate-body')?.append(line);
    }
    line.textContent = message;
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

  async function lookUp(entry) {
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
      trouble(entry, `${err.message || 'Couldn’t look it up.'} It stays held.`);
    }
  }

  async function load() {
    if (loading || !navigator.onLine) return;
    loading = true;
    try {
      const held = await queue.list();
      const shown = new Set([...list.querySelectorAll('.review-entry[data-barcode]')].map((e) => e.dataset.barcode));
      const fresh = held.filter((scan) => !shown.has(scan.barcode)).map((scan) => placeholder(scan));
      list.append(...fresh);
      refresh();
      // two at a time: the providers behind a lookup don't like bursts
      const pending = [...fresh];
      const worker = async () => {
        while (pending.length) await lookUp(pending.shift());
      };
      await Promise.all([worker(), worker()]);
    } catch {
      // the queue couldn't be read (storage blocked): nothing to show
    } finally {
      loading = false;
      refresh();
    }
  }

  async function add(form) {
    const entry = form.closest('.review-entry');
    const buttons = [...entry.querySelectorAll('button')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      const added = await partial(
        await fetch('/items', { method: 'POST', body: new FormData(form), headers: { 'HX-Request': 'true' }, redirect: 'manual' }),
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

  list.addEventListener('submit', (e) => {
    const form = e.target.closest?.('form[data-review-add]');
    if (!form) return;
    e.preventDefault();
    add(form);
  });

  list.addEventListener('click', (e) => {
    const entry = e.target.closest?.('.review-entry');
    if (!entry) return;
    if (e.target.closest('[data-review-drop]')) drop(entry);
    if (e.target.closest('[data-review-retry]')) {
      const again = placeholder({ barcode: entry.dataset.barcode, scannedAt: entry.dataset.scannedAt });
      entry.replaceWith(again);
      lookUp(again).then(refresh);
    }
  });

  allSelect?.addEventListener('change', () => {
    allName.textContent = allSelect.selectedOptions[0]?.textContent ?? '';
  });

  // "Add all to <shelf>": every entry that found a match, one after another, each to that shelf — they're all on
  // screen, and each one's own shelf changes to it as it goes. Entries with no match stay for a decision.
  allForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (addingAll) return;
    addingAll = true;
    refresh();
    for (const form of list.querySelectorAll('form[data-review-add]')) {
      const select = form.querySelector('select[name="libraryId"]');
      if (select) select.value = allSelect.value;
      await add(form);
    }
    addingAll = false;
    refresh();
  });

  // Someone else signed in from another tab (app.js rewrote the stamp and emptied the queue): this list isn't theirs.
  window.addEventListener('storage', (e) => {
    if (e.key === queue.OWNER_KEY) location.reload();
  });

  // Back online with this page open (scans held from it while offline): the list picks them up.
  window.addEventListener('online', load);

  load();
})();
