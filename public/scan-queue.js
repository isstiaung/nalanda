// The device's offline scan queue (ARCH.md §16 #48): barcodes scanned with no signal, held in IndexedDB until
// the Add page's review list adds or drops each one. An entry is the barcode and when it was scanned — nothing
// else. The details are looked up only once the device is back online, and only by the Add page, signed in.
//
// Whose they are: localStorage 'nalanda:scan-owner' holds the opaque stamp of the account signed in on this
// device (app.js copies it from <body data-scan-owner> on every signed-in page, empties the queue when a
// different account signs in, and empties it and forgets the stamp on logout). With no stamp — nobody has
// signed in here since the last logout — the queue refuses scans rather than hold them for whoever comes next.
// A signed-in page also checks the stamp itself (mine()), so a page whose app.js failed to load still never shows
// or adds to another account's scans.
window.nalandaScanQueue = (() => {
  const DB = 'nalanda-scans';
  const STORE = 'scans';
  const OWNER_KEY = 'nalanda:scan-owner';
  const LIMIT = 200; // a shelf's worth; the review list looks each one up, one at a time

  const owner = () => {
    try {
      return localStorage.getItem(OWNER_KEY);
    } catch {
      return null; // storage disabled: no owner, so nothing is held
    }
  };

  // Whether this page may use the queue: someone's stamp is on the device and, on a signed-in page, it's theirs.
  // The offline page carries no stamp, and holds for whoever the device's stamp names.
  const mine = () => {
    const held = owner();
    const page = document.body?.dataset.scanOwner;
    return !!held && (page === undefined || page === held);
  };

  const supported = () => {
    try {
      return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch {
      return false;
    }
  };

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'barcode' });
      req.onsuccess = () => {
        const db = req.result;
        // A logout or a different sign-in in another tab deletes the database: let go of it at once.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** One transaction; `work` issues its requests synchronously and returns a getter for the result. */
  async function tx(mode, work) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const result = work(t.objectStore(STORE));
        t.oncomplete = () => resolve(result());
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  }

  const value = (req) => () => req.result;

  /** Every held scan, oldest first. */
  async function list() {
    if (!supported() || !mine()) return [];
    const all = await tx('readonly', (s) => value(s.getAll()));
    return all.sort((a, b) => (a.scannedAt < b.scannedAt ? -1 : a.scannedAt > b.scannedAt ? 1 : 0));
  }

  async function count() {
    if (!supported() || !mine()) return 0;
    return tx('readonly', (s) => value(s.count()));
  }

  /**
   * Holds a barcode. Resolves { held, count, why } — why is 'nobody' (no one signed in on this device),
   * 'unsupported', 'full', or 'already' (that barcode is waiting already; its first scan time stands).
   */
  async function hold(barcode) {
    if (!supported()) return { held: false, count: 0, why: 'unsupported' };
    if (!mine()) return { held: false, count: 0, why: 'nobody' };
    const code = String(barcode).trim();
    if (!/^\d{8,14}$/.test(code)) return { held: false, count: await count(), why: 'invalid' };
    return tx('readwrite', (s) => {
      let outcome = { held: false, count: 0, why: '' };
      const existing = s.get(code);
      existing.onsuccess = () => {
        // asked from inside the first answer, so the transaction stays open for the put
        const total = s.count();
        total.onsuccess = () => {
          if (existing.result) {
            outcome = { held: false, count: total.result, why: 'already' };
          } else if (total.result >= LIMIT) {
            outcome = { held: false, count: total.result, why: 'full' };
          } else {
            s.put({ barcode: code, scannedAt: new Date().toISOString() });
            outcome = { held: true, count: total.result + 1, why: '' };
          }
        };
      };
      return () => outcome;
    });
  }

  async function remove(barcode) {
    if (!supported() || !mine()) return;
    await tx('readwrite', (s) => {
      s.delete(String(barcode));
      return () => undefined;
    });
  }

  /** Deletes the whole queue. Resolves once it's gone, or when another tab holds it open (it goes when they let go). */
  function clear() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(DB);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  return { list, count, hold, remove, clear, owner, mine, LIMIT, OWNER_KEY };
})();
