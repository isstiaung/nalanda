// A cover that fails to load — its R2 object gone, a connection's library offline — gets the same media-icon box
// as an item that never had a cover. Every cover <img> carries its icon in data-fallback; nothing else is needed.
// Loaded by the app and the public share pages alike, deferred. No inline onerror= (CLAUDE.md): one capture-phase
// listener catches every later failure, including lazy images and htmx-swapped results, and a sweep at start-up
// catches the ones that failed before this script ran.
(function () {
  function useFallback(img) {
    var icon = img.getAttribute('data-fallback');
    if (!icon || !img.parentNode) return;
    var thumb = img.classList.contains('thumb'); // the table's small cover has its own fallback class
    var box = document.createElement(thumb ? 'span' : 'div');
    box.className = thumb ? 'thumb-fallback' : 'cover-fallback';
    box.textContent = icon;
    if (img.alt) {
      // the picture is gone, not what it described: the box keeps the image's name for screen readers
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', img.alt);
    } else {
      box.setAttribute('aria-hidden', 'true');
    }
    img.replaceWith(box);
  }

  document.addEventListener(
    'error',
    function (e) {
      var t = e.target;
      if (t && t.tagName === 'IMG' && t.hasAttribute('data-fallback')) useFallback(t);
    },
    true // error events don't bubble; capture sees them on the way down
  );

  // Complete with no pixels means it already failed — but only if the image was ever requested, so a lazy cover still
  // waiting below the fold is never swapped before it had a chance to load. Both guards hold that line: Chromium
  // leaves currentSrc empty until it starts the fetch, and WebKit (checked with Playwright's build) reports such an
  // image as not yet complete. Requiring both keeps an engine that gets one of them wrong from swapping early.
  document.querySelectorAll('img[data-fallback]').forEach(function (img) {
    if (img.complete && img.naturalWidth === 0 && img.currentSrc) useFallback(img);
  });
})();
