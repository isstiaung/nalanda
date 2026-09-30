// Provider responses recorded on 2026-09-30 for the series work (ARCH.md §16 #52), with the fields the app asks
// for. Trimmed only where lists run long (publishers, ISBNs); every series field is as the provider sent it.

/** openlibrary.org/search.json?q=isbn:9780316129077 — Abaddon's Gate, The Expanse #3. */
export const OL_ISBN_ABADDON = {
  numFound: 1,
  start: 0,
  numFoundExact: true,
  num_found: 1,
  q: 'isbn:9780316129077',
  offset: null,
  docs: [
    {
      author_name: ['James S. A. Corey'],
      cover_i: 8624248,
      first_publish_year: 2013,
      key: '/works/OL17074648W',
      number_of_pages_median: 571,
      publisher: ['Orbit', 'Hachette Book Group', 'Little, Brown Book Group Limited'],
      series_name: ['The Expanse'],
      series_position: ['3'],
      title: 'Abaddon’s Gate',
    },
  ],
};

/** openlibrary.org/search.json?q=isbn:9780547773742 — A Wizard of Earthsea: Open Library has no series for it. */
export const OL_ISBN_EARTHSEA = {
  numFound: 1,
  start: 0,
  numFoundExact: true,
  num_found: 1,
  q: 'isbn:9780547773742',
  offset: null,
  docs: [
    {
      author_name: ['Ursula K. Le Guin'],
      cover_i: 13617691,
      first_publish_year: 1968,
      key: '/works/OL59798W',
      number_of_pages_median: 205,
      publisher: ['Parnassus Press', 'Houghton Mifflin Harcourt', 'Bantam'],
      title: 'A Wizard of Earthsea',
    },
  ],
};

/** openlibrary.org/search.json?q=the last wish sapkowski — a prequel numbered 0.5. */
export const OL_SEARCH_LAST_WISH = {
  numFound: 3,
  start: 0,
  numFoundExact: true,
  num_found: 3,
  q: 'the last wish sapkowski',
  offset: null,
  docs: [
    {
      author_name: ['Andrzej Sapkowski'],
      cover_i: 7360819,
      first_publish_year: 1993,
      isbn: ['9780316029186', '9780316497541', '9780316495967'],
      key: '/works/OL2577482W',
      number_of_pages_median: 342,
      publisher: ['Orbit', 'Gollancz', 'SuperNOWA'],
      series_name: ['The Witcher'],
      series_position: ['0.5'],
      title: 'Ostatnie Życzenie',
    },
    {
      author_name: ['Andrzej Sapkowski'],
      cover_i: 13814994,
      first_publish_year: 2020,
      isbn: ['9780316703291', '031670329X'],
      key: '/works/OL21909292W',
      number_of_pages_median: 752,
      publisher: ['Orbit'],
      title: 'Witcher Stories Boxed Set',
    },
  ],
};

/** openlibrary.org/search.json?q=the two towers — a volume, and the omnibus Open Library places at "1-3". */
export const OL_SEARCH_TWO_TOWERS = {
  numFound: 2,
  start: 0,
  numFoundExact: true,
  num_found: 2,
  q: 'the two towers',
  offset: null,
  docs: [
    {
      author_name: ['J.R.R. Tolkien'],
      cover_i: 14627564,
      first_publish_year: 1954,
      isbn: ['0345008634', '9780812417852', '2266070606'],
      key: '/works/OL27479W',
      number_of_pages_median: 434,
      publisher: ['Ballantine Books', 'George Allen & Unwin'],
      series_name: ['The Lord of the Rings'],
      series_position: ['2'],
      title: 'The Two Towers',
    },
    {
      author_name: ['J.R.R. Tolkien'],
      cover_i: 14625765,
      first_publish_year: 1954,
      isbn: ['4566023621', '0898452236', '0044406797'],
      key: '/works/OL27448W',
      number_of_pages_median: 1193,
      publisher: ['HarperCollins Publishers', 'Houghton Mifflin'],
      series_name: ['The Lord of the Rings'],
      series_position: ['1-3'],
      title: 'The Lord of the Rings',
    },
  ],
};

/**
 * googleapis.com/books/v1/volumes?q=isbn:9781646684656 — one of the few volumes carrying seriesInfo (a Play Books
 * comic): a display number and a seriesId, but no series name. /books/v1/series/get?series_id=SpcsGwAAABBnjM, which
 * would name it, answered 401 "API keys are not supported by this API. Expected OAuth2 access token…".
 */
export const GB_ISBN_ORCS = {
  kind: 'books#volumes',
  totalItems: 1,
  items: [
    {
      kind: 'books#volume',
      id: '3lQuEAAAQBAJ',
      volumeInfo: {
        title: 'ORCS! #4',
        authors: ['Christine Larsen'],
        publisher: 'Boom! Studios',
        publishedDate: '2021-05-19',
        description:
          'The Orcs have made it to safety! Yes! Wait. Looks like Bog, Zep, Pez, Utzu, and Gurh have a new battle ahead of them against an ancient evil from the Astral Plane.',
        industryIdentifiers: [
          { type: 'ISBN_13', identifier: '9781646684656' },
          { type: 'ISBN_10', identifier: '1646684656' },
        ],
        pageCount: 44,
        printType: 'BOOK',
        seriesInfo: {
          kind: 'books#volume_series_info',
          bookDisplayNumber: '4',
          volumeSeries: [{ seriesId: 'SpcsGwAAABBnjM', seriesBookType: 'ISSUE', orderNumber: 10 }],
        },
        imageLinks: { thumbnail: 'http://books.google.com/books/content?id=3lQuEAAAQBAJ&printsec=frontcover&img=1&zoom=1&source=gbs_api' },
        language: 'en',
      },
    },
  ],
};

/** googleapis.com/books/v1/volumes?q=isbn:9780316129077 — Abaddon's Gate in print: no seriesInfo at all. */
export const GB_ISBN_ABADDON = {
  kind: 'books#volumes',
  totalItems: 1,
  items: [
    {
      kind: 'books#volume',
      id: 'IzI00gEACAAJ',
      volumeInfo: {
        title: "Abaddon's Gate",
        authors: ['James S. A. Corey'],
        publisher: 'Orbit',
        publishedDate: '2013-06-04',
        // cut: the description goes on for several paragraphs
        description:
          "The third book in the NYT bestselling Expanse series, Abaddon's Gate opens the door to the ruins of an alien gate network, and the crew of the Rocinante may hold the key to unlocking its secrets.",
        industryIdentifiers: [
          { type: 'ISBN_10', identifier: '0316129070' },
          { type: 'ISBN_13', identifier: '9780316129077' },
        ],
        pageCount: 0,
        printType: 'BOOK',
        categories: ['Fiction'],
        language: 'en',
      },
    },
  ],
};
