// Fills a throwaway instance with a small, plausible collection — for the README
// screenshots, and for anyone who wants to see the app with something on the shelves
// before cataloguing their own.
//
//   npm run dev:demo    # terminal 1 — wrangler dev on :8788, its own state directory
//   npm run seed:demo   # terminal 2
//
// It drives the app over HTTP through the same routes the browser uses — /setup,
// /api/import, /api/backfill-covers — so it exercises the real import path and can
// never write a shape the app itself wouldn't. Covers are fetched live from the
// metadata providers, so this needs network; without DISCOGS_TOKEN in .dev.vars the
// vinyl covers come back empty and everything else still works.
//
// Point it at your real instance and it will refuse: /setup only answers on an
// instance with no users.

const BASE = process.argv.find((a) => a.startsWith('--url='))?.slice(6) ?? 'http://localhost:8788';
const USERNAME = 'librarian';
const PASSWORD = 'demo-password';

// libib's CSV column names — mapLibibRow() in src/lib/csv.ts is the contract.
const BOOKS = [
  ['Piranesi', 'Susanna Clarke', '9781635575637', 'completed', '4.5', 'Bloomsbury', '2020', '272',
   'A house of infinite halls and tides, and the gentlest narrator in modern fantasy. Finished it in one sitting and immediately missed it.', 'fantasy, favourites', '1'],
  ['The Left Hand of Darkness', 'Ursula K. Le Guin', '9780441478125', 'completed', '5', 'Ace Books', '1969', '304',
   'The ice crossing is one of the great sustained passages in the genre. Every reread finds another argument buried in it.', 'science fiction, favourites', '1'],
  ['The Dispossessed', 'Ursula K. Le Guin', '9780061054884', 'in progress', '', 'Harper Voyager', '1974', '387',
   '', 'science fiction', '1'],
  ['Braiding Sweetgrass', 'Robin Wall Kimmerer', '9781571313560', 'completed', '4.5', 'Milkweed Editions', '2013', '408',
   'Borrowed from the library and read it twice before returning it. The chapter on the honourable harvest has stayed with me for years.', 'nature writing, essays', '0'],
  ['The Master and Margarita', 'Mikhail Bulgakov', '9780143108276', 'completed', '4', 'Penguin Classics', '1967', '432',
   'A devil, a talking cat, and 1930s Moscow. Read it on loan and never replaced it — one to fix.', 'classics, russian', '0'],
  ['Pachinko', 'Min Jin Lee', '9781455563937', 'completed', '4.5', 'Grand Central', '2017', '496',
   'Four generations, and it never once loses its footing. The opening line earns everything that follows.', 'literary fiction', '1'],
  ['Station Eleven', 'Emily St. John Mandel', '9780804172448', 'completed', '4', 'Vintage', '2014', '352',
   'Survival is insufficient. A quiet book about what outlasts us.', 'science fiction', '1'],
  ['The Overstory', 'Richard Powers', '9780393356687', 'not begun', '', 'W. W. Norton', '2018', '512', '', 'literary fiction', '1'],
  ['Frankenstein', 'Mary Shelley', '9780141439471', 'completed', '4', 'Penguin Classics', '1818', '273',
   'Much stranger and sadder than its afterlife in film suggests.', 'classics, gothic', '1'],
  ['Cloud Atlas', 'David Mitchell', '9780375507250', 'not begun', '', 'Random House', '2004', '509', '', 'literary fiction', '1'],
];

const GAMES = [
  ['Wingspan', 'Elizabeth Hargrave', 'completed', '5', 'Stonemaier Games', '2019', 'engine builder, 1-5 players', '1'],
  ['Spirit Island', 'R. Eric Reuss', 'completed', '5', 'Greater Than Games', '2017', 'co-op, heavy', '1'],
  ['Azul', 'Michael Kiesling', 'completed', '4', 'Plan B Games', '2017', 'abstract, gateway', '1'],
  ['Brass: Birmingham', 'Martin Wallace', 'in progress', '4.5', 'Roxley', '2018', 'economic, heavy', '1'],
  ['Codenames', 'Vlaada Chvátil', 'completed', '4', 'Czech Games Edition', '2015', 'party, gateway', '1'],
];

const VINYL = [
  ['Kind of Blue', 'Miles Davis', 'completed', '5', 'Columbia', '1959', 'jazz', '1'],
  ['Blue', 'Joni Mitchell', 'completed', '5', 'Reprise', '1971', 'folk', '1'],
  ['Rumours', 'Fleetwood Mac', 'completed', '4.5', 'Warner Bros.', '1977', 'rock', '1'],
  ['In Rainbows', 'Radiohead', 'completed', '4.5', 'XL Recordings', '2007', 'rock', '1'],
  ['The Köln Concert', 'Keith Jarrett', 'completed', '5', 'ECM', '1975', 'jazz', '1'],
];

const bookRows = BOOKS.map(([title, creators, ean, status, rating, publisher, published, length, review, tags, copies]) => ({
  Title: title, Creators: creators, 'EAN/ISBN13': ean, 'Item Type': 'Books',
  Status: status, Rating: rating, Publisher: publisher, 'Publish Date': published,
  Length: length, Review: review, Tags: tags, Copies: copies,
}));

const gameRows = GAMES.map(([title, creators, status, rating, publisher, published, tags, copies]) => ({
  Title: title, Creators: creators, 'Item Type': 'Board games', Status: status,
  Rating: rating, Publisher: publisher, 'Publish Date': published, Tags: tags, Copies: copies,
}));

const vinylRows = VINYL.map(([title, creators, status, rating, publisher, published, tags, copies]) => ({
  Title: title, Creators: creators, 'Item Type': 'Vinyl', Status: status,
  Rating: rating, Publisher: publisher, 'Publish Date': published, Tags: tags, Copies: copies,
}));

let cookie = '';

async function call(path, { method = 'GET', form, json } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(new URL(path, BASE), { method, headers, body, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie?.startsWith('nalanda_session=')) cookie = setCookie.split(';')[0];
  return res;
}

async function main() {
  const setup = await call('/setup', {
    method: 'POST',
    form: { username: USERNAME, password: PASSWORD, confirm: PASSWORD },
  });
  if (setup.status === 404) {
    console.error(
      `Refusing to seed: ${BASE} already has accounts.\n` +
        'This script is for a fresh, throwaway instance — see the header comment.',
    );
    process.exit(1);
  }
  if (!cookie) throw new Error(`Setup failed (${setup.status}) — is the dev server running at ${BASE}?`);
  console.log(`admin "${USERNAME}" created (password: ${PASSWORD})`);

  // The shelves /setup creates, read back off the import form rather than assumed.
  const html = await (await call('/import')).text();
  const options = [...html.matchAll(/<option value="(\d+)"[^>]*>([^<]+)<\/option>/g)];
  const shelf = (name) => {
    const hit = options.find((m) => m[2].trim().toLowerCase() === name.toLowerCase());
    if (!hit) throw new Error(`No "${name}" shelf found on /import`);
    return Number(hit[1]);
  };

  for (const [name, rows, defaultType] of [
    ['Books', bookRows, 'book'],
    ['Board games', gameRows, 'boardgame'],
    ['Vinyl', vinylRows, 'vinyl'],
  ]) {
    const res = await call('/api/import', {
      method: 'POST',
      json: { libraryId: shelf(name), rows, defaultType },
    });
    const out = await res.json();
    if (!res.ok) throw new Error(`Import into ${name} failed: ${JSON.stringify(out)}`);
    console.log(`${name}: ${out.inserted} added, ${out.skipped} skipped`);
  }

  // Covers, in the same small batches the browser walks through.
  process.stdout.write('fetching covers');
  let after = 0;
  let found = 0;
  for (;;) {
    const res = await call('/api/backfill-covers', { method: 'POST', json: { after } });
    const out = await res.json();
    found += out.found;
    after = out.lastId;
    process.stdout.write('.');
    if (out.done) break;
  }
  console.log(`\n${found} covers stored`);

  // One live loan and one published share, so those screens aren't empty.
  const shelves = await (await call('/libraries')).text();
  const wingspan = shelves.match(/href="\/items\/(\d+)"[^>]*>\s*Wingspan/)?.[1];
  const items = await (await call('/search?q=Wingspan')).text();
  const itemId = wingspan ?? items.match(/href="\/items\/(\d+)"/)?.[1];
  if (itemId) {
    const due = new Date(Date.now() + 12 * 86400_000).toISOString().slice(0, 10);
    await call(`/items/${itemId}/loan`, {
      method: 'POST',
      form: { borrower: 'Anjali', contact: 'next door', dueOn: due },
    });
    console.log(`lent item ${itemId} until ${due}`);
  }

  // Two links with different scopes: one slice of a shelf, one whole shelf — which is
  // also the difference between a shelf reading "1 view shared" and "Shared".
  for (const share of [
    { libraryId: String(shelf('Books')), name: 'Books I have finished', status: 'completed', sort: 'rating' },
    { libraryId: String(shelf('Vinyl')), name: 'The record shelf', sort: 'title' },
  ]) {
    await call('/shares', { method: 'POST', form: share });
    console.log(`published a share view: "${share.name}"`);
  }

  console.log(`\nDone. ${BASE} — log in as ${USERNAME} / ${PASSWORD}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
