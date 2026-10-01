// Kindle highlights (ARCH.md §16 #77), parsed here in the browser as the CSV import is, never on the server. Two
// files Kindle gives: "My Clippings.txt" from the device, and the app's emailed notebook export, HTML. Both become
// books with highlights — each highlight's text, its page or location, the note Kindle attached to it at the same
// place, and when Kindle recorded it. Bookmarks are ignored. An ES module, so test/quotes.spec.ts runs the same code.

const SEPARATOR = /\r?\n==========\r?\n?/;

/** "Piranesi (Clarke, Susanna)" → title and author; "Last, First" is turned round as Creators does. */
function splitTitle(line) {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(line.trim());
  if (!m) return { title: line.trim(), author: null };
  let author = m[2].trim();
  const parts = author.split(',').map((s) => s.trim());
  if (parts.length === 2 && parts[0] && parts[1] && !parts[0].includes('.')) author = `${parts[1]} ${parts[0]}`;
  return { title: m[1].trim(), author: author || null };
}

/** "- Your Highlight on page 42 | Location 612-614 | Added on Monday, 1 September 2025 21:14:03" */
function splitMeta(line) {
  const type = /Your (Highlight|Note|Bookmark)/i.exec(line)?.[1]?.toLowerCase() ?? null;
  const page = /page (\d+(?:-\d+)?)/i.exec(line)?.[1] ?? null;
  const location = /Location (\d+(?:-\d+)?)/i.exec(line)?.[1] ?? null;
  const added = /Added on (.+)$/i.exec(line)?.[1] ?? null;
  // where it is, as a span: a highlight's "180-182", a note's "182" — a note matches the highlight whose span holds it
  const span = (s) => (s ? s.split('-').map(Number) : null);
  return { type, place: page ? `p. ${page}` : location ? `loc. ${location}` : null, key: span(location) ?? span(page), at: kindleDate(added) };
}

/** Kindle's "Monday, 1 September 2025 21:14:03" (or "September 1, 2025 9:14:03 PM") as 'YYYY-MM-DD HH:MM:SS', else null. */
export function kindleDate(text) {
  if (!text) return null;
  const t = Date.parse(text.replace(/^[A-Za-z]+,\s*/, ''));
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * My Clippings.txt → [{ title, author, highlights: [{ text, page, note, at }] }]. A note at the same place as a
 * highlight (the usual pair Kindle writes) becomes that highlight's note; a note on its own is kept as a quote of
 * the reader's own words, marked so. Books in the order first seen; highlights in file order.
 */
export function parseClippings(text) {
  const books = new Map();
  const bookOf = (title, author) => {
    const key = `${title.toLowerCase()}|${(author ?? '').toLowerCase()}`;
    if (!books.has(key)) books.set(key, { title, author, highlights: [] });
    return books.get(key);
  };
  for (const block of text.replace(/^\uFEFF/, '').split(SEPARATOR)) {
    const lines = block.split(/\r?\n/);
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines.length < 2) continue;
    const { title, author } = splitTitle(lines[0]);
    const meta = splitMeta(lines[1]);
    const body = lines.slice(2).join('\n').trim();
    if (!title || !meta.type || meta.type === 'bookmark' || !body) continue;
    const book = bookOf(title, author);
    if (meta.type === 'note') {
      // Kindle writes the note right after its highlight at the same location: attach it, else keep it as its own
      const within = (h) => h.key && meta.key && meta.key[0] >= h.key[0] && meta.key[0] <= (h.key[1] ?? h.key[0]);
      const target = meta.key ? [...book.highlights].reverse().find((h) => h.note === null && !h.ownWords && within(h)) : undefined;
      if (target) target.note = body;
      else book.highlights.push({ text: body, page: meta.place, note: null, at: meta.at, key: meta.key, ownWords: true });
      continue;
    }
    book.highlights.push({ text: body, page: meta.place, note: null, at: meta.at, key: meta.key });
  }
  return [...books.values()].map((b) => ({
    title: b.title,
    author: b.author,
    highlights: b.highlights.map(({ key: _k, ownWords, ...h }) => (ownWords ? { ...h, note: h.text, text: h.text } : h)),
  }));
}

/**
 * The Kindle app's notebook export (HTML): one book, its title and author in the heading, then sections of
 * "noteHeading" (Highlight (Yellow) | Page 42 · Location 612) and "noteText". Read with regular expressions, so it
 * runs where there is no DOMParser too; tags inside are stripped.
 */
export function parseNotebookHtml(html) {
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  const title = strip(/class="bookTitle"[^>]*>([\s\S]*?)<\//.exec(html)?.[1] ?? '');
  const author = strip(/class="authors"[^>]*>([\s\S]*?)<\//.exec(html)?.[1] ?? '') || null;
  if (!title) return [];
  const highlights = [];
  const re = /class="noteHeading"[^>]*>([\s\S]*?)<\/div>\s*<div class="noteText"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const heading = strip(m[1]);
    const body = strip(m[2]);
    if (!body) continue;
    const page = /Page (\d+)/i.exec(heading)?.[1];
    const location = /Location (\d+(?:-\d+)?)/i.exec(heading)?.[1];
    const place = page ? `p. ${page}` : location ? `loc. ${location}` : null;
    if (/^Note/i.test(heading)) {
      const last = highlights[highlights.length - 1];
      if (last && last.note === null) last.note = body;
      else highlights.push({ text: body, page: place, note: body, at: null });
    } else if (/^Highlight/i.test(heading)) {
      highlights.push({ text: body, page: place, note: null, at: null });
    }
  }
  return highlights.length ? [{ title, author: splitTitle(`x (${author ?? ''})`).author ?? author, highlights }] : [];
}

/** Either file, by its shape. */
export function parseKindle(text) {
  return /class="noteText"/.test(text) ? parseNotebookHtml(text) : parseClippings(text);
}
