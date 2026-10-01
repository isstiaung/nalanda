// Branded QR codes for share links (ARCH.md §16 #85): drawn here, in the browser, by the vendored qrcode-generator
// (public/vendor/qrcode.js) from each link's address — lampblack modules on palm-leaf, the Nalanda mark centred
// under its vermilion rule, error correction H so the modules the mark covers are recoverable — into every
// <img data-qr> of the Shared links page, with a Download button for the PNG. Nothing leaves the page: the address
// is the one already printed beside it, and the PNG is this drawing. Without JavaScript the address itself remains.
(function () {
  if (typeof qrcode !== 'function') return;
  var css = getComputedStyle(document.documentElement);
  var tone = function (name, fallback) {
    return css.getPropertyValue(name).trim() || fallback;
  };
  var ink = tone('--ink', '#221d14');
  var paper = tone('--paper', '#f6f2e7');
  var stamp = tone('--stamp', '#b93a1c');
  var SIZE = 512; // drawn at print size; the page shows it small (app.css), the download keeps it whole
  var QUIET = 4; // the quiet zone the standard asks for, in modules

  // The mark: /logo.svg, given a width and height so every browser will draw it onto a canvas (an SVG with only a
  // viewBox draws nothing in some). One fetch for the page, however many links; same origin, so the canvas stays clean.
  var mark = null;
  var waiting = [];
  function withMark(fn) {
    if (mark) return fn(mark);
    waiting.push(fn);
    if (waiting.length > 1) return;
    var settle = function (img) {
      mark = img;
      waiting.splice(0).forEach(function (f) {
        f(img);
      });
    };
    fetch('/logo.svg')
      .then(function (r) {
        return r.ok ? r.text() : '';
      })
      .then(function (svg) {
        if (!svg) return settle(null);
        var img = new Image();
        img.onload = function () {
          settle(img);
        };
        img.onerror = function () {
          settle(null);
        };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/<svg\b/, '<svg width="128" height="128"'));
      })
      .catch(function () {
        settle(null);
      });
  }

  function draw(img) {
    var url = img.getAttribute('data-qr');
    if (!url) return;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    var qr = qrcode(0, 'H');
    qr.addData(url);
    qr.make();
    var n = qr.getModuleCount();
    var cell = Math.floor(SIZE / (n + QUIET * 2));
    var offset = Math.floor((SIZE - cell * n) / 2);
    canvas.width = SIZE;
    canvas.height = SIZE;
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = ink;
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
      }
    }
    // the mark's ground: a palm-leaf square over the centre, about a sixth of the area — within what level H can lose
    var box = cell * Math.round(n * 0.4);
    var x = Math.round((SIZE - box) / 2);
    ctx.fillStyle = paper;
    ctx.fillRect(x, x, box, box);
    // the vermilion rule the brand hangs from (.brand-rule), then the mark beneath it
    ctx.fillStyle = stamp;
    var rule = Math.max(2, Math.round(box * 0.05));
    ctx.fillRect(x + Math.round(box * 0.15), x + Math.round(box * 0.1), Math.round(box * 0.7), rule);
    var logo = Math.round(box * 0.62);
    withMark(function (image) {
      if (image) ctx.drawImage(image, x + Math.round((box - logo) / 2), x + Math.round(box * 0.1) + rule + Math.round(box * 0.08), logo, logo);
      var png;
      try {
        png = canvas.toDataURL('image/png');
      } catch (e) {
        return; // a canvas a browser won't export: the address beside it is still the link
      }
      img.src = png;
      var button = img.parentElement && img.parentElement.querySelector('button[data-qr-download]');
      if (!button) return;
      button.hidden = false;
      button.addEventListener('click', function () {
        var a = document.createElement('a');
        a.href = png;
        a.download = button.getAttribute('data-qr-download') || 'share.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
    });
  }

  function run() {
    var all = document.querySelectorAll('img[data-qr]');
    for (var i = 0; i < all.length; i++) draw(all[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
