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

  let stream = null;
  let timer = null;
  let detector = null; // { kind: 'native' | 'zxing', impl }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const say = (msg) => { if (status) status.textContent = msg; };

  async function getDetector() {
    if (detector) return detector;
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('ean_13')) {
          detector = { kind: 'native', impl: new window.BarcodeDetector({ formats: ['ean_13', 'upc_a', 'ean_8'] }) };
          return detector;
        }
      } catch { /* fall through to zxing */ }
    }
    say('Loading barcode decoder…');
    const zxing = await import('/vendor/zxing/reader/index.js');
    zxing.prepareZXingModule({
      overrides: {
        // serve the wasm from our own origin, never zxing-wasm's default CDN
        locateFile: (path, prefix) =>
          path.endsWith('.wasm') ? '/vendor/zxing/zxing_reader.wasm' : prefix + path,
      },
    });
    detector = { kind: 'zxing', impl: zxing };
    return detector;
  }

  async function detectFrame() {
    if (!stream || video.readyState < 2) return null;
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
      if (stream) say(hint());
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

  async function start() {
    tune(); // inside the click, so the beep is allowed
    const request = navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } },
      audio: false,
    });
    // A timeout race, not just try/catch: getUserMedia can hang indefinitely rather
    // than reject (e.g. a permission prompt the user never responds to) — without
    // this, "nothing visibly happens" is indistinguishable from "still waiting."
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 8s')), 8000));
    try {
      stream = await Promise.race([request, timeout]);
    } catch (err) {
      say(
        location.protocol === 'http:' && location.hostname !== 'localhost'
          ? 'Camera needs HTTPS. Type the barcode below instead.'
          : `Camera unavailable (${err.name ?? 'timed out'}). Type the barcode below instead.`,
      );
      return;
    }
    video.srcObject = stream;
    video.classList.add('live');
    await video.play();
    startBtn.hidden = true;
    stopBtn.hidden = false;
    say(hint());
    timer = setInterval(async () => {
      try {
        const code = await detectFrame();
        if (code && /^\d{8,14}$/.test(code)) found(code);
      } catch { /* keep scanning */ }
    }, 350);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.classList.remove('live');
    video.srcObject = null;
    startBtn.hidden = false;
    stopBtn.hidden = true;
  }

  startBtn.addEventListener('click', start);
  stopBtn?.addEventListener('click', () => { stop(); say(''); });
  window.addEventListener('pagehide', stop);
})();
