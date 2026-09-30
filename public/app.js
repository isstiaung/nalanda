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

  // A filter menu drops down from its button's left edge; one near the right of a phone's screen would hang off
  // it and scroll the whole page sideways, so it lines up with its button's right edge instead.
  document.addEventListener(
    'toggle',
    (e) => {
      const menu = e.target.matches?.('details.filter[open]') ? e.target.querySelector('.filter-menu') : null;
      if (!menu) return;
      menu.style.left = '';
      menu.style.right = '';
      if (menu.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
        menu.style.left = 'auto';
        menu.style.right = '0';
      }
    },
    true, // toggle doesn't bubble
  );

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

  // The sidebar's sections (ARCH.md §16 #62) open and close natively — they're <details>. This only remembers
  // which ones the member opened, in a small `nav` cookie the server reads to render them open: the first paint is
  // already right, with nothing to restore after load. A section open only because it holds the current page is
  // never written down: only a click on its header counts (Enter and Space on a focused <summary> click it too).
  document.getElementById('sidebar')?.addEventListener('click', (e) => {
    const summary = e.target.closest('summary');
    const section = summary?.parentElement;
    if (!section || !section.matches('details.nav-section[data-nav]') || summary !== section.firstElementChild) return;
    const opening = !section.open; // the click runs before the <details> toggles
    const kept = new Set(
      ((document.cookie.match(/(?:^|;\s*)nav=([^;]*)/) || [])[1] || '').split('.').filter((id) => /^[a-z]+$/.test(id)),
    );
    if (opening) kept.add(section.dataset.nav);
    else kept.delete(section.dataset.nav);
    const value = [...kept].slice(0, 8).join('.');
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = value
      ? `nav=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
      : `nav=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  });

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

// "Refresh from Discogs" and "Refresh from BGG" (ARCH.md §16 #55, #60) swap their section in place and say the result
// in a live region that stays on the page, named by the form's data-refresh-status. While the request is out, that
// region says so ("Asking Discogs…", the form's own fixed words). A request that ends without an answer to swap — a
// 500, no connection, aborted, timed out — swaps nothing, so without this the button would come back with nothing
// said and "Asking…" left standing: the region gets a fixed sentence, never the answer's body.
// The button is disabled while it waits. A browser then drops focus from it — to <body>, or, when a second click lands
// on the disabled button, to the nearest focusable ancestor (<main>, a landing place with tabindex=-1). Once the answer
// is in, the button pressed gets focus back, unless the person has since put focus somewhere else themselves (a
// control, a link: anything that isn't a tabindex=-1 landing place). Scoped to these forms; other htmx buttons are
// unchanged.
(() => {
  const statusOf = (e) => {
    const form = e.detail && e.detail.elt && e.detail.elt.closest ? e.detail.elt.closest('form[data-refresh-status]') : null;
    const status = form ? document.getElementById(form.dataset.refreshStatus) : null;
    return status ? { form, status } : null;
  };
  let pressed = null; // the button that had focus when its request went out
  let movedAway = false; // focus since put somewhere of the person's choosing, outside the form
  const landing = (el) => !el || el === document.body || el.getAttribute('tabindex') === '-1';
  document.addEventListener('focusin', (e) => {
    if (pressed && !pressed.form?.contains(e.target) && !landing(e.target)) movedAway = true;
  });
  document.addEventListener('htmx:beforeRequest', (e) => {
    const found = statusOf(e);
    if (!found) return;
    const button = found.form.querySelector('button');
    pressed = button && document.activeElement === button ? button : null;
    movedAway = false;
    if (found.form.dataset.refreshBusy) found.status.textContent = found.form.dataset.refreshBusy;
  });
  // after htmx has swapped (or not) and re-enabled the button, before the page-wide afterSettle handler above
  document.addEventListener('htmx:afterRequest', (e) => {
    const found = statusOf(e);
    if (!found) return;
    if (pressed && pressed.isConnected && !movedAway && !found.form.contains(document.activeElement)) {
      pressed.focus({ preventScroll: true });
    }
    pressed = null;
  });
  const failed = (e) => {
    const found = statusOf(e);
    if (!found) return;
    found.status.textContent = 'Something went wrong — try again.';
    e.preventDefault(); // said here, so not again in the page's own message region below (§16 #65)
  };
  for (const type of ['htmx:responseError', 'htmx:sendError', 'htmx:sendAbort', 'htmx:timeout']) {
    document.addEventListener(type, failed);
  }
})();

// Every other htmx control (ARCH.md §16 #65). htmx swaps nothing when a request fails — a 4xx or 5xx, or no answer at
// all — so without this Played, Finish, the Holding toggle, Another and the rest would silently do nothing. The page's
// one message region (#app-status, rendered by the layout after <main>) says what happened in a fixed sentence chosen
// by the kind of failure: never the answer's body, never the URL. A control with its own status says it there
// instead: its handler, on the document, runs first and calls preventDefault(), and this one — on the window, so it
// runs after every handler on the document — leaves that failure alone. The next request that succeeds empties the
// region. htmx itself re-enables the control and drops its htmx-request class; the button pressed gets focus back if
// the browser dropped it to <body> while it was disabled.
(() => {
  const SAY = {
    network: 'Couldn’t reach Nalanda — check your connection and try again.',
    server: 'Something went wrong — try again.',
    origin: 'Nalanda couldn’t tell that came from this page — reload it and try again.',
    refused: 'You can’t do that here.',
    gone: 'That’s no longer here — reload the page.',
    other: 'That didn’t go through — reload the page and try again.',
  };
  const kindOf = (xhr) => {
    const status = xhr ? xhr.status : 0;
    if (status >= 500) return 'server';
    // the CSRF check's refusal says which it is in a header (src/index.ts): only its value picks a sentence
    if (status === 403) return xhr.getResponseHeader('X-Nalanda-Refused') === 'origin' ? 'origin' : 'refused';
    if (status === 404 || status === 410) return 'gone';
    return 'other';
  };

  let again = 0;
  const say = (text) => {
    const region = document.getElementById('app-status');
    if (!region) return;
    clearTimeout(again);
    if (region.textContent !== text) {
      region.textContent = text;
      return;
    }
    // the same sentence twice is still news: empty the region, then say it again, so a screen reader hears it
    region.textContent = '';
    again = setTimeout(() => {
      region.textContent = text;
    }, 150);
  };
  const clear = () => {
    const region = document.getElementById('app-status');
    clearTimeout(again);
    if (region && region.textContent) region.textContent = '';
  };

  window.addEventListener('htmx:responseError', (e) => {
    if (!e.defaultPrevented) say(SAY[kindOf(e.detail && e.detail.xhr)]);
  });
  const unreached = (e) => {
    if (!e.defaultPrevented) say(SAY.network);
  };
  window.addEventListener('htmx:sendError', unreached);
  window.addEventListener('htmx:timeout', unreached);

  const pressed = new WeakMap(); // the element a request went out from → what had focus in it then
  window.addEventListener('htmx:beforeRequest', (e) => {
    const elt = e.detail && e.detail.elt;
    const active = document.activeElement;
    if (elt && active && active !== document.body && elt.contains(active)) pressed.set(elt, active);
  });
  window.addEventListener('htmx:afterRequest', (e) => {
    const elt = e.detail && e.detail.elt;
    if (e.detail && e.detail.successful === true) clear();
    const button = elt ? pressed.get(elt) : null;
    if (elt) pressed.delete(elt);
    if (e.detail && e.detail.successful === true) return; // a swap: the afterSettle handler above looks after focus
    // dropped to <body> when the button was disabled, or to <main> by a second click on it while it was
    const active = document.activeElement;
    const dropped = !active || active === document.body || active === document.getElementById('main');
    if (button && button.isConnected && dropped) button.focus({ preventScroll: true });
  });

  // An HX-Redirect (a lapsed session sent to log in, src/index.ts) leaves this page with its control still disabled
  // and busy: htmx keeps it so while the browser navigates. Back to it from the browser's page cache, it would stay
  // stuck, so the page loads again instead — as it is now, or the login page again if still signed out.
  let redirected = false;
  window.addEventListener('htmx:beforeOnLoad', (e) => {
    const xhr = e.detail && e.detail.xhr;
    if (xhr && xhr.getResponseHeader('HX-Redirect')) redirected = true;
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && redirected) location.reload();
  });
})();
