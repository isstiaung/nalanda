// Recorded Discogs responses, in the shapes its API documentation gives (discogs.com/developers: Database →
// Release, and Database → Search). Tests replay them through test/fetch-mock.ts; nothing here calls Discogs.

/**
 * GET /releases/249504 — the Release endpoint's own documented example, fields as the documentation lists them
 * (images and videos trimmed to one each; nothing Nalanda reads is changed).
 */
export const RELEASE_249504 = {
  title: 'Never Gonna Give You Up',
  id: 249504,
  artists: [
    { anv: '', id: 72872, join: '', name: 'Rick Astley', resource_url: 'https://api.discogs.com/artists/72872', role: '', tracks: '' },
  ],
  data_quality: 'Correct',
  thumb: 'https://api-img.discogs.com/kAXVhuZuh_uat5NNr50zMjN7lho=/fit-in/300x300/R-249504-1334592212.jpeg.jpg',
  community: {
    contributors: [{ resource_url: 'https://api.discogs.com/users/memory', username: 'memory' }],
    data_quality: 'Correct',
    have: 252,
    rating: { average: 3.42, count: 45 },
    status: 'Accepted',
    submitter: { resource_url: 'https://api.discogs.com/users/memory', username: 'memory' },
    want: 42,
  },
  companies: [],
  country: 'UK',
  date_added: '2004-04-30T08:10:05-07:00',
  date_changed: '2012-12-03T02:50:12-07:00',
  estimated_weight: 60,
  extraartists: [
    { anv: '', id: 20942, join: '', name: 'Me Co', resource_url: 'https://api.discogs.com/artists/20942', role: 'Design', tracks: '' },
  ],
  format_quantity: 1,
  formats: [{ descriptions: ['7"', 'Single', '45 RPM'], name: 'Vinyl', qty: '1' }],
  genres: ['Electronic', 'Pop'],
  identifiers: [
    { type: 'Barcode', value: '5012394144777' },
    { type: 'Matrix / Runout', description: 'Side A', value: 'PB 41447 A-1' },
  ],
  images: [
    {
      height: 600,
      resource_url: 'https://api-img.discogs.com/z_u8yqxvDcwVnR4tX2HLNLaQO2Y=/fit-in/600x600/R-249504-1334592212.jpeg.jpg',
      type: 'primary',
      uri: 'https://api-img.discogs.com/z_u8yqxvDcwVnR4tX2HLNLaQO2Y=/fit-in/600x600/R-249504-1334592212.jpeg.jpg',
      uri150: 'https://api-img.discogs.com/0ZYgPR4X2HdUKA_jkhPJF4SN5mM=/fit-in/150x150/R-249504-1334592212.jpeg.jpg',
      width: 600,
    },
  ],
  labels: [{ catno: 'PB 41447', entity_type: '1', id: 895, name: 'RCA', resource_url: 'https://api.discogs.com/labels/895' }],
  lowest_price: 0.63,
  master_id: 96559,
  master_url: 'https://api.discogs.com/masters/96559',
  notes: 'UK Release has a black label with the text "Manufactured In England" printed on it.\r\n\r\nDurations do not appear on the release.\r\n',
  num_for_sale: 58,
  released: '1987',
  released_formatted: '1987',
  resource_url: 'https://api.discogs.com/releases/249504',
  series: [],
  status: 'Accepted',
  styles: ['Synth-pop'],
  tracklist: [
    { duration: '3:32', position: 'A', title: 'Never Gonna Give You Up', type_: 'track' },
    { duration: '3:30', position: 'B', title: 'Never Gonna Give You Up (Instrumental)', type_: 'track' },
  ],
  uri: 'https://www.discogs.com/Rick-Astley-Never-Gonna-Give-You-Up/release/249504',
  videos: [
    {
      description: 'Rick Astley - Never Gonna Give You Up (Extended Version)',
      duration: 330,
      embed: true,
      title: 'Rick Astley - Never Gonna Give You Up (Extended Version)',
      uri: 'https://www.youtube.com/watch?v=te2jJncBVG4',
    },
  ],
  year: 1987,
};

/**
 * A double LP in the same documented shape, with what the example above lacks: two labels (one disambiguated by
 * Discogs' "(2)", one with no catalogue number), a format with a quantity and free text, side headings, a guest
 * artist, and an index track with its parts.
 */
export const RELEASE_DOUBLE_LP = {
  id: 7700123,
  title: 'Monsoon Suites',
  artists: [{ anv: '', id: 5501, join: '', name: 'The Hillside Quartet', role: '', tracks: '' }],
  country: 'Europe',
  year: 2019,
  released: '2019-06-14',
  format_quantity: 2,
  formats: [{ name: 'Vinyl', qty: '2', descriptions: ['LP', 'Album', 'Reissue', '180 Gram'], text: 'Red Translucent' }],
  genres: ['Jazz'],
  styles: ['Modal'],
  labels: [
    { catno: 'SHVL 804', entity_type: '1', id: 1234, name: 'Harvest (2)' },
    { catno: 'none', entity_type: '1', id: 26126, name: 'EMI' },
  ],
  identifiers: [{ type: 'Barcode', value: '0724384260910' }],
  tracklist: [
    { position: '', title: 'Side A', type_: 'heading', duration: '' },
    { position: 'A1', title: 'First Rain', type_: 'track', duration: '7:02' },
    {
      position: 'A2',
      title: 'Kanha',
      type_: 'track',
      duration: '9:14',
      artists: [
        { anv: '', id: 5501, join: 'Feat.', name: 'The Hillside Quartet', role: '', tracks: '' },
        { anv: 'R. Iyer', id: 88, join: '', name: 'Ravi Iyer (3)', role: '', tracks: '' },
      ],
    },
    { position: '', title: 'Side B', type_: 'heading', duration: '' },
    {
      position: 'B1',
      title: 'The Long Monsoon',
      type_: 'index',
      duration: '',
      sub_tracks: [
        { position: 'B1a', title: 'Clouds', type_: 'track', duration: '4:10' },
        { position: 'B1b', title: 'Downpour', type_: 'track', duration: '6:45' },
      ],
    },
    { position: 'C1', title: 'Petrichor', type_: 'track', duration: '11:30' },
    { position: 'D1', title: 'After', type_: 'track', duration: '' },
  ],
  uri: 'https://www.discogs.com/release/7700123',
};

/**
 * GET /database/search?barcode=…&type=release — the Search endpoint's documented result fields for a release. A
 * search result's `format` flattens name and descriptions, and it carries no tracklist.
 */
export const SEARCH_BY_BARCODE = {
  pagination: { per_page: 1, pages: 1, page: 1, urls: {}, items: 1 },
  results: [
    {
      style: ['Modal'],
      thumb: 'https://i.discogs.com/thumb/R-7700123.jpeg',
      title: 'The Hillside Quartet - Monsoon Suites',
      country: 'Europe',
      format: ['Vinyl', 'LP', 'Album', 'Reissue', '180 Gram'],
      uri: '/release/7700123-The-Hillside-Quartet-Monsoon-Suites',
      community: { want: 12, have: 80 },
      label: ['Harvest (2)', 'EMI'],
      catno: 'SHVL 804',
      year: '2019',
      genre: ['Jazz'],
      resource_url: 'https://api.discogs.com/releases/7700123',
      type: 'release',
      id: 7700123,
      barcode: ['0724384260910', '0 7243 8 42609 1 0'],
      cover_image: 'https://i.discogs.com/cover/R-7700123.jpeg',
      master_id: 33001,
    },
  ],
};
