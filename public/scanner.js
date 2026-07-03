// Barcode scanning, entirely on-device: native BarcodeDetector where available
// (Chrome/Android), lazy-loaded ZXing-WASM everywhere else (iOS Safari, Firefox).
// Requires HTTPS (or localhost) for camera access.
(() => {
  const video = document.getElementById('scanner-video');
  const startBtn = document.getElementById('scanner-start');
  const stopBtn = document.getElementById('scanner-stop');
  const status = document.getElementById('scanner-status');
  if (!video || !startBtn) return;

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

  function found(code) {
    stop();
    if (navigator.vibrate) navigator.vibrate(80);
    say(`Found ${code} — looking it up…`);
    window.htmx.ajax('GET', `/add/results?barcode=${encodeURIComponent(code)}`, {
      target: '#scan-results',
      swap: 'innerHTML',
    });
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } },
        audio: false,
      });
    } catch (err) {
      say(
        location.protocol === 'http:' && location.hostname !== 'localhost'
          ? 'Camera needs HTTPS. Type the barcode below instead.'
          : `Camera unavailable (${err.name}). Type the barcode below instead.`,
      );
      return;
    }
    video.srcObject = stream;
    video.classList.add('live');
    await video.play();
    startBtn.hidden = true;
    stopBtn.hidden = false;
    say('Point at a barcode…');
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
