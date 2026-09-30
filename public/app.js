// Small vanilla helpers: add-page tabs, mobile sidebar, and table column choices — and, first, the installed app's
// service worker and whose offline scans this device holds.

// ── the offline scan queue belongs to whoever is signed in here (ARCH.md §16 #48) ──
// Top level, not DOMContentLoaded: this runs before the Add page's review list reads the queue (deferred scripts run
// in order, and IndexedDB serves a delete before any open queued after it).
(() => {
  const OWNER_KEY = 'nalanda:scan-owner';
  const dropQueue = () =>
    new Promise((resolve) => {
      try {
        const req = indexedDB.deleteDatabase('nalanda-scans');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });

  // A signed-in page names its account's stamp. A different stamp from the one this device remembers means someone
  // else signed in: their predecessor's held scans go, unseen, before anything can show them.
  const stamp = document.body?.dataset.scanOwner;
  if (stamp) {
    let known;
    try {
      known = localStorage.getItem(OWNER_KEY);
    } catch {
      known = undefined; // storage disabled: nothing can be held for anyone (scan-queue.js refuses without a stamp)
    }
    if (known !== stamp) {
      dropQueue();
      try {
        localStorage.setItem(OWNER_KEY, stamp);
      } catch {
        // stays unowned, so nothing is held
      }
    }
  }

  // Logging out empties the queue and forgets the stamp before the form goes: the next person to sign in on this
  // device starts with nothing held. Bounded, so a stuck IndexedDB can't keep anyone signed in.
  document.querySelectorAll('form[action="/auth/logout"]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        localStorage.removeItem(OWNER_KEY);
      } catch {
        // nothing stored, nothing to forget
      }
      Promise.race([dropQueue(), new Promise((resolve) => setTimeout(resolve, 1500))]).then(() => form.submit());
    });
  });

  // The service worker keeps the offline page and the scanner, never a page or an API answer (public/sw.js).
  // updateViaCache 'none': the browser checks sw.js itself on every visit, so a deploy's worker is never missed.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      // no worker (private mode, an old browser): everything works, just not offline
    });
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  const tabs = document.querySelectorAll('.tab[data-tab]');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-pressed', String(t === tab));
      });
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        const active = panel.id === `tab-${tab.dataset.tab}`;
        panel.hidden = !active;
        panel.classList.toggle('active', active);
      });
    });
  });

  // Filter dropdowns close when clicking anywhere else (incl. opening another one).
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.filter[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  // Table columns: a per-device display preference, so localStorage rather than the
  // server. The inline script in <head> has already applied the stored value before
  // paint; this only syncs the checkboxes to it and writes changes back.
  const columnsMenu = document.getElementById('columns-menu');
  if (columnsMenu) {
    const KEY = 'nalanda:hidden-columns';
    const boxes = [...columnsMenu.querySelectorAll('input[data-col]')];
    const read = () => {
      try {
        return new Set((localStorage.getItem(KEY) ?? '').split(/\s+/).filter(Boolean));
      } catch {
        return new Set(); // private mode, or storage disabled — degrade to "show all"
      }
    };

    const hidden = read();
    boxes.forEach((b) => {
      b.checked = !hidden.has(b.dataset.col);
    });

    columnsMenu.addEventListener('change', (e) => {
      if (!e.target.matches('input[data-col]')) return;
      const next = boxes.filter((b) => !b.checked).map((b) => b.dataset.col);
      const value = next.join(' ');
      document.documentElement.setAttribute('data-hide-cols', value);
      try {
        localStorage.setItem(KEY, value);
      } catch {
        // nothing to do — the column choice just won't outlive this page
      }
    });
  }

  // Bulk edit (ARCH.md §16 #47). The checkboxes and the bar are a plain form without this; it adds the count,
  // "select all on this page", Clear, and a tag field that's required when a tag action is chosen. The server
  // checks everything again — the cap, the action, and that only an admin deletes.
  const bulk = document.getElementById('bulk');
  if (bulk) {
    const picks = () => [...document.querySelectorAll('input.bulk-pick')];
    const alls = [...document.querySelectorAll('input[data-bulk-all]')];
    const count = bulk.querySelector('[data-bulk-count]');
    const clear = bulk.querySelector('[data-bulk-clear]');
    const apply = bulk.querySelector('button[type="submit"]');
    const action = bulk.querySelector('select[name="action"]');
    const tag = bulk.querySelector('input[name="tag"]');
    const max = Number(bulk.dataset.max) || Infinity;
    const sync = () => {
      const boxes = picks();
      const n = boxes.filter((b) => b.checked).length;
      count.textContent = n > max ? `${n} selected — too many` : `${n} selected`;
      alls.forEach((a) => {
        a.checked = n > 0 && n === boxes.length;
        a.indeterminate = n > 0 && n < boxes.length;
      });
      bulk.hidden = n === 0;
      if (apply) apply.disabled = n > max;
    };
    alls.forEach((a) => {
      a.hidden = false;
      a.closest('label')?.removeAttribute('hidden');
    });
    if (clear) clear.hidden = false;
    document.addEventListener('change', (e) => {
      if (e.target.matches('input[data-bulk-all]')) picks().forEach((b) => (b.checked = e.target.checked));
      if (e.target.matches('input.bulk-pick, input[data-bulk-all]')) sync();
    });
    clear?.addEventListener('click', () => {
      picks().forEach((b) => (b.checked = false));
      sync();
    });
    action?.addEventListener('change', () => {
      if (tag) tag.required = action.value.startsWith('tag-');
    });
    sync();
    // Back to this page, the browser may restore checked boxes after load, without a change event: count again then.
    window.addEventListener('pageshow', sync);
    window.addEventListener('load', sync);
  }

  // The phone drawer. aria-expanded follows it, so a screen reader hears whether the menu is open; while closed,
  // CSS keeps it out of the tab order and the accessibility tree (visibility: hidden, after the slide).
  const navToggle = document.getElementById('nav-toggle');
  if (navToggle) {
    const isOpen = () => document.body.classList.contains('nav-open');
    const setOpen = (open) => {
      document.body.classList.toggle('nav-open', open);
      navToggle.setAttribute('aria-expanded', String(open));
    };
    navToggle.addEventListener('click', () => setOpen(!isOpen()));
    document.getElementById('sidebar')?.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) setOpen(false);
    });
    // A tap on the dimmed page beside the open drawer closes it.
    document.addEventListener('click', (e) => {
      if (!isOpen() || e.target.closest('#sidebar, #nav-toggle')) return;
      setOpen(false);
    });
    // Escape closes it too, handing focus back to the button that opened it.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !isOpen()) return;
      setOpen(false);
      navToggle.focus();
    });
  }
});

// An htmx swap replaces what had focus. htmx puts focus back on an element with the same id; anything else (a
// Finish button that became Read again, say) would leave keyboard focus on <body>, back at the top of the page.
// Then the swapped region itself takes focus, so Tab carries on from where the person was.
document.addEventListener('htmx:afterSettle', (e) => {
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const id = e.detail.target && e.detail.target.id;
  const region = id ? document.getElementById(id) : null;
  if (!region) return;
  if (!region.hasAttribute('tabindex')) {
    region.setAttribute('tabindex', '-1');
    region.setAttribute('data-focus-landing', '');
  }
  region.focus({ preventScroll: true });
});
