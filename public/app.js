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
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
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
