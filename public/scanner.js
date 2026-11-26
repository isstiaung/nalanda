// Barcode scanning, entirely on-device: native BarcodeDetector where available
// (Chrome/Android), lazy-loaded ZXing-WASM everywhere else (iOS Safari, Firefox).
// Requires HTTPS (or localhost) for camera access.
//
// With no signal it keeps going (ARCH.md §16 #48): a barcode found offline — or whose lookup never reached the
// server — is held on the device by scan-queue.js, and the camera stays on for the next one. The offline page
// (offline.html, <body data-scan-mode="hold">) only ever holds; the Add page looks up while it can — unless its
// "Keep scanning" box is on (§16 #94), when every barcode is held the same way, with a beep and a running count, and
// the review list's "Add all" looks them up later, twenty a request. Online and offline are one mode: a held barcode
// is a barcode and a time, nothing is looked up at scan time.
(() => {
  const video = document.getElementById('scanner-video');
  const startBtn = document.getElementById('scanner-start');
  const stopBtn = document.getElementById('scanner-stop');
  const status = document.getElementById('scanner-status');
  if (!video || !startBtn) return;
  const holdOnly = document.body.dataset.scanMode === 'hold';
  const queue = window.nalandaScanQueue;

  // The camera is a small state machine, held here and nowhere else, and mirrored on the scan section as
  // data-scanner (for the stylesheet, the tests and anyone reading the page):
  //
  //   idle ──Start──▶ starting ──camera answers──▶ live ──Stop, a lookup, leaving the page──▶ idle
  //                      └──refused, timed out, Stop, leaving──▶ idle
  //
  // Start does nothing unless idle, so a second tap while the permission prompt is up can't open a second camera.
  // Every Start is an attempt with its own number; Stop and leaving the page end the current one. A camera that
  // answers for an attempt that has ended — after the 8-second timeout gave up on it, or after Stop — is closed the
  // moment it arrives, so the camera light never stays on with nothing on screen.
  let state = 'idle';
  let attempt = 0;
  let stream = null;
  let timer = null;
  const section = startBtn.closest('section, main') || document.body;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const say = (msg) => { if (status) status.textContent = msg; };

  function enter(next) {
    state = next;
    section.dataset.scanner = next;
    // aria-, not `disabled`: a disabled button drops keyboard focus, which wouldn't come back when the camera is
    // refused. start() itself does nothing unless idle.
    if (next === 'starting') {
      startBtn.setAttribute('aria-busy', 'true');
      startBtn.setAttribute('aria-disabled', 'true');
    } else {
      startBtn.removeAttribute('aria-busy');
      startBtn.removeAttribute('aria-disabled');
    }
    startBtn.hidden = next === 'live';
    if (stopBtn) stopBtn.hidden = next !== 'live';
  }
  const current = (mine) => mine === attempt && state !== 'idle';
  const close = (s) => s?.getTracks().forEach((t) => t.stop());

  // The decoder, loaded once: one promise every frame waits on, so a slow connection fetching ZXing's 1 MB of WASM
  // gets one download and one set-up — not one per frame while it arrives. A failed load is said once and tried again
  // at most every RETRY_MS, quietly, so the status line (a live region) isn't rewritten on every frame.
  const RETRY_MS = 5000;
  let decoder = null; // Promise<{ kind: 'native' | 'zxing', impl }>
  let failedAt = 0; // when the last load failed; 0 while none has
  async function loadDetector() {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('ean_13')) {
          return { kind: 'native', impl: new window.BarcodeDetector({ formats: ['ean_13', 'upc_a', 'ean_8'] }) };
        }
      } catch { /* fall through to zxing */ }
    }
    if (!failedAt) say('Loading barcode decoder…');
    const zxing = await import('/vendor/zxing/reader/index.js');
    zxing.prepareZXingModule({
      overrides: {
        // serve the wasm from our own origin, never zxing-wasm's default CDN
        locateFile: (path, prefix) =>
          path.endsWith('.wasm') ? '/vendor/zxing/zxing_reader.wasm' : prefix + path,
      },
    });
    if (state === 'live') say(hint()); // the loading line was news; the camera's own line comes back
    return { kind: 'zxing', impl: zxing };
  }
  function getDetector() {
    if (!decoder && failedAt && Date.now() - failedAt < RETRY_MS) return Promise.reject(new Error('decoder unavailable'));
    decoder ??= loadDetector().then(
      (d) => {
        failedAt = 0;
        return d;
      },
      (err) => {
        decoder = null;
        if (!failedAt && state === 'live') say('Couldn’t load the barcode decoder — check the connection, or type the barcode below.');
        failedAt = Date.now();
        throw err;
      },
    );
    return decoder;
  }

  async function detectFrame() {
    if (state !== 'live' || !stream || video.readyState < 2) return null;
    const d = await getDetector();
    if (d.kind === 'native') {
      const codes = await d.impl.detect(video);
      return codes[0]?.rawValue ?? null;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const results = await d.impl.readBarcodes(imageData, {
      formats: ['EAN-13', 'UPC-A', 'EAN-8'],
      maxNumberOfSymbols: 1,
    });
    return results[0]?.text ?? null;
  }

  const offline = () => holdOnly || !navigator.onLine || !window.htmx;

  // "Keep scanning" (§16 #94): the Add page's box, remembered on this device, off until someone turns it on. The
  // offline page has no box and always holds.
  const keepBox = document.getElementById('scanner-keep');
  const KEEP_KEY = 'nalanda:keep-scanning';
  if (keepBox) {
    try {
      keepBox.checked = localStorage.getItem(KEEP_KEY) === '1';
    } catch { /* storage disabled: off, as the box shows */ }
    keepBox.addEventListener('change', () => {
      try {
        localStorage.setItem(KEEP_KEY, keepBox.checked ? '1' : '0');
      } catch { /* not remembered, still on for this page */ }
      if (state === 'live') say(hint());
    });
  }
  const keeping = () => !!keepBox?.checked;
  // whether a barcode found now is held rather than looked up
  const holding = () => offline() || keeping();
  const hint = () =>
    offline()
      ? 'Offline — point at a barcode; each one is held on this device.'
      : keeping()
        ? 'Keep scanning — point at each barcode in turn; each one is held for the list above.'
        : 'Point at a barcode…';

  // A short tone when a barcode is held — Web Audio, no file to fetch — beside the vibration and the status line,
  // never the only signal. The context is made on Start, a click, so browsers let it sound.
  let audio = null;
  function tune() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !audio) audio = new Ctx();
    } catch {
      audio = null;
    }
  }
  function beep() {
    if (!audio) return;
    try {
      if (audio.state === 'suspended') audio.resume();
      const at = audio.currentTime;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = 1047; // C6: short and clear over a shop's noise
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.13);
    } catch { /* no sound: the vibration and the status line say it */ }
  }

  // what a hold says; the offline page and the Add page both show the count
  const HOLD_WHY = {
    already: (code) => `${code} is already held — it's on the list once.`,
    full: () => `The device already holds ${queue.LIMIT} scans. Review them on Add items before scanning more.`,
    nobody: () => 'Nobody is signed in on this device, so scans can’t be held. Sign in once you have signal.',
    unsupported: () => 'This browser can’t hold scans offline. Try again with signal.',
    invalid: (code) => `${code} doesn’t look like a barcode.`,
  };

  async function hold(code) {
    if (!queue) {
      say('This page can’t hold scans offline. Try again with signal.');
      return;
    }
    let outcome;
    try {
      outcome = await queue.hold(code);
    } catch {
      say('Couldn’t hold that scan on this device.');
      return;
    }
    const waiting = outcome.count ? ` ${outcome.count} on the list to review.` : '';
    say(outcome.held ? `Held ${code}.${waiting}` : `${HOLD_WHY[outcome.why]?.(code) ?? 'Not held.'}${waiting}`);
    if (outcome.held) beep();
    document.dispatchEvent(new CustomEvent('nalanda:held', { detail: outcome }));
  }
  // for the typed-barcode box on the offline page, which has no camera to go through
  window.nalandaHoldScan = hold;

  // This page's holds: the barcode still in frame isn't held again every 350 ms, but one brought back a few seconds
  // later is asked of the queue, which says it's on the list once.
  const seen = new Map();
  const inFrame = (code) => {
    const last = seen.get(code);
    seen.set(code, Date.now());
    return last !== undefined && Date.now() - last < 3000;
  };

  function found(code) {
    if (holding()) {
      // held, and the camera keeps going for the next barcode
      if (inFrame(code)) return;
      if (navigator.vibrate) navigator.vibrate(80);
      hold(code);
      return;
    }
    stop();
    if (navigator.vibrate) navigator.vibrate(80);
    say(`Found ${code} — looking it up…`);
    window.htmx.ajax('GET', `/add/results?barcode=${encodeURIComponent(code)}`, {
      target: '#scan-results',
      swap: 'innerHTML',
    });
  }

  // A lookup that never reached the server — signal gone mid-scan, or the typed box — holds its barcode instead.
  document.addEventListener('htmx:sendError', (e) => {
    const path = e.detail?.pathInfo?.finalRequestPath ?? '';
    if (!path.startsWith('/add/results')) return;
    const code = new URL(path, location.origin).searchParams.get('barcode')?.trim();
    if (!code) return;
    hold(code);
    e.preventDefault(); // the scanner's own status says what became of it, not the page's message region (§16 #65)
  });

  // why the camera didn't start, in words someone can act on
  function refusal(err) {
    if (!window.isSecureContext) return 'Camera needs HTTPS. Type the barcode below instead.';
    if (err?.name === 'NotAllowedError') return 'Camera permission was refused — allow it in the browser’s settings, or type the barcode below.';
    if (err?.name === 'TimeoutError') return 'The camera didn’t start within 8 seconds. Try again, or type the barcode below.';
    return `Camera unavailable (${err?.name || 'unknown'}). Type the barcode below instead.`;
  }

  async function start() {
    if (state !== 'idle') return; // a second tap while the camera is starting, or already on
    const mine = ++attempt;
    enter('starting');
    say('Starting the camera…');
    tune(); // inside the click, so the beep is allowed
    const request = navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
      : Promise.reject(Object.assign(new Error('no camera API'), { name: 'NotSupportedError' }));
    // A camera that answers for an attempt that has ended is closed at once. Registered first, so when it answers in
    // time this sees the attempt still current and leaves it be.
    request.then((late) => { if (!current(mine) || state !== 'starting') close(late); }, () => {});
    // A timeout race, not just try/catch: getUserMedia can hang indefinitely rather than reject (a permission prompt
    // nobody answers) — without this, "nothing visibly happens" is indistinguishable from "still waiting."
    let giveUp = 0;
    const timeout = new Promise((_, reject) => {
      giveUp = setTimeout(() => reject(Object.assign(new Error('timed out after 8s'), { name: 'TimeoutError' })), 8000);
    });
    let opened;
    try {
      opened = await Promise.race([request, timeout]);
    } catch (err) {
      if (mine === attempt) {
        enter('idle');
        say(refusal(err));
      }
      return;
    } finally {
      clearTimeout(giveUp);
    }
    if (!current(mine)) return close(opened); // stopped while it was starting: the handler above closed it
    stream = opened;
    video.srcObject = stream;
    video.classList.add('live');
    try {
      await video.play();
    } catch { /* autoplay refused or interrupted: frames still arrive for a muted inline video */ }
    if (!current(mine)) return;
    enter('live');
    say(hint());
    tick(mine);
  }

  // One frame at a time: the next read is scheduled only once this one has finished, so a slow decoder (ZXing on an
  // old phone, or still loading) never has reads piling up behind it.
  async function tick(mine) {
    if (!current(mine) || state !== 'live') return;
    try {
      const code = await detectFrame();
      if (current(mine) && state === 'live' && code && /^\d{8,14}$/.test(code)) found(code);
    } catch { /* keep scanning */ }
    if (current(mine) && state === 'live') timer = setTimeout(() => tick(mine), 350);
  }

  function stop() {
    attempt++; // ends whatever attempt was running, starting or live
    clearTimeout(timer);
    timer = null;
    close(stream);
    stream = null;
    video.classList.remove('live');
    video.srcObject = null;
    enter('idle');
  }

  enter('idle');
  startBtn.addEventListener('click', start);
  stopBtn?.addEventListener('click', () => { stop(); say(''); });
  window.addEventListener('pagehide', stop);
})();
