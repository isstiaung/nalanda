// A household translation, imported (ARCH.md §16 #93): the Members page's form reads the JSON file HERE in the
// browser and posts the parsed object — like the CSV import, the Worker never parses a file — to
// POST /settings/translations, which keeps the keys it knows. The page's own fixed sentences (data-* on the form)
// say what happened; the server's answer is read for its counts and never shown as text.
(() => {
  const form = document.getElementById('translation-form');
  const status = document.getElementById('translation-status');
  if (!form || !status) return;
  const file = form.querySelector('input[type="file"]');
  const locale = form.querySelector('select[name="locale"]');
  const button = form.querySelector('button[type="submit"]');
  const maxBytes = Number(form.dataset.maxBytes || 0);
  const say = (text) => {
    status.textContent = text;
  };
  const fill = (text, params) => text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const chosen = file && file.files && file.files[0];
    if (!chosen || !locale) return;
    if (maxBytes && chosen.size > maxBytes) {
      say(fill(form.dataset.failed, { reason: fill(form.dataset.tooBig, { kb: Math.round(maxBytes / 1024) }) }));
      return;
    }
    say(form.dataset.reading);
    if (button) button.disabled = true;
    let strings;
    try {
      strings = JSON.parse(await chosen.text());
    } catch {
      say(fill(form.dataset.failed, { reason: form.dataset.notJson }));
      if (button) button.disabled = false;
      return;
    }
    let res = null;
    try {
      res = await fetch('/settings/translations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: locale.value, strings }),
      });
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      say(fill(form.dataset.failed, { reason: res ? String(res.status) : form.dataset.notJson }));
      if (button) button.disabled = false;
      return;
    }
    const result = await res.json();
    say(fill(form.dataset.done, { kept: Number(result.kept) || 0, ignored: Number(result.ignored) || 0 }));
    // the page lists what is imported, and renders in the new words itself: a reload shows both
    setTimeout(() => location.reload(), 800);
  });
})();
