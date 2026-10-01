import { Hono, type Context } from 'hono';
import type { Item, ItemStatus, MediaType, NewItem } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import {
  activeLoansForItem,
  addPastRead,
  applyGameFill,
  applyPressingFill,
  addPurchaseLink,
  deletePurchaseLink,
  existingForWant,
  itemPageLog,
  setWant,
  wantsAndLinks,
  addProgress,
  closeRead,
  createItemWithTags,
  deleteItem,
  deletePlay,
  deleteProgress,
  deleteRead,
  deleteReview,
  getItem,
  getLibrary,
  getPlay,
  getProgressEntry,
  getRead,
  getSeries,
  getReview,
  getSiteSettings,
  listLibraries,
  listPeople,
  logPlay,
  moveRead,
  moveReview,
  pastLoansForItem,
  playLog,
  readingLog,
  seriesNames,
  seriesWithVolumes,
  startRead,
  tagsForItem,
  TRASH_DAYS,
  updateItemWithTags,
  updateRead,
  updateReview,
  type Actor,
  type ReadEntry,
  type ReviewEntry,
  setCover,
  editionsOf,
  getLibraryAndSettings,
  addQuote,
  getQuote,
  updateQuote,
  deleteQuote,
  markNotOwnedUnlessLent,
  markOwnedUnlessBorrowed,
  openBorrowLender,
  openReadPages,
  quoteCount,
  historyOf,
  itemHistoryStatements,
  type Writer,
} from '../db/queries';
import type { AppEnv } from '../env';
import { scanQueueOwner } from '../lib/auth';
import { isRecord, parseGrade } from '../lib/condition';
import { deleteCover, isDiscogsUrl, isUploadableCover, storeCover, storeUploadedCover } from '../lib/covers';
import { bggIdOf, fillGame, type GameFill } from '../lib/games';
import { isPlayable, MAX_PLAYS_PER_ITEM, playDateProblem } from '../lib/plays';
import { fillPressing, recordBarcode, releaseIdOf, type Filled } from '../lib/pressing';
import { checkPurchaseLink, MAX_LINKS_PER_ITEM } from '../lib/links';
import { isCurrencyCode, isStoredPrice, parseMoney } from '../lib/money';
import { MAX_PROGRESS_PAGE, MAX_PROGRESS_PER_READ } from '../lib/progress';
import { isReadStatus, readDateProblem, summarizeReads, type ReadDraft } from '../lib/reads';
import { reviewText } from '../lib/reviews';
import { cleanSeriesName, formatSeriesNumber, parseSeriesNumber, type SeriesDraft } from '../lib/series';
import { parseDetails } from '../lib/share';
import { bggRefresh, discogsPressing, recordCover } from '../metadata';
import {
  accNo,
  BuySection,
  buyIsShown,
  CopiesPill,
  Cover,
  DetailsList,
  Grade,
  HoldingPill,
  ItemForm,
  MarkNotOwnedButton,
  MarkOwnedButton,
  Money,
  type PriceFieldProps,
  ItemStatusPills,
  LendingHistory,
  AllPlays,
  Pagination,
  PlaysSection,
  PressingSwap,
  ReadingSection,
  RecordDetails,
  ReadsByPerson,
  ReviewAdded,
  ReviewsSection,
  stars,
  type Person,
  type Viewer,
  WantBar,
  WantedPill,
  BorrowedFrom,
  BorrowedPill,
  FormatPills,
  LanguagePill,
  ItemHistory,
} from '../views/components';
import { Fill, lengthUnit, mediaLabel, useI18n } from '../views/i18n';
import { page, partial, todayOf } from '../views/layout';
import { CreatorLinks } from '../views/creators';
import { CoverPhotoForm, PHOTO_REFUSED } from '../views/cover-photo';
import { cleanEdition, FORMATS, formatLabel, formatsFromPressing, formatsOf, MAX_EDITIONS_PER_ITEM, normalizeFormats, type EditionDraft } from '../lib/formats';
import { isLanguageCode } from '../lib/language';
import { QuotesSection } from '../views/quotes';
import { cleanQuote, MAX_QUOTES_PER_ITEM, type QuoteDraft } from '../lib/quotes';
import { BggAttribution, fromBgg } from '../views/attribution';
import { itemComments } from './comments';
import { recommendOnItemPage } from './recommendations';
import { SeriesSection } from '../views/series';
import { ledgerDate } from '../lib/dates';

const items = new Hono<AppEnv>();

/** The signed-in person, as the reading and review routes check them: their own, or anyone's for an admin (§16 #43). */
/** Who is writing (§16 #84): the signed-in member, with the key that says it is still their account (#56). */
export function writerOf(c: Context<AppEnv>): Writer {
  const user = c.get('user');
  return { id: user.id, sessionKey: user.sessionKey };
}

function viewerOf(c: Context<AppEnv>): Viewer & Actor {
  const user = c.get('user');
  return { id: user.id, admin: user.role === 'admin' };
}

/**
 * Whether the book's page shows people: once the household has more than one member, or anyone but the viewer has
 * read or reviewed it (a member removed since, say). A household of one sees the page as it always was.
 */
const showsPeople = (people: Person[], viewer: Viewer, log: { reads: ReadEntry[]; reviews: ReviewEntry[] }) =>
  people.length > 1 || log.reads.some((r) => r.readerId !== viewer.id) || log.reviews.some((r) => r.userId !== viewer.id);

/**
 * The item as one person's edit form shows it (§16 #43): their reading — the status and dates of their read that
 * decides their status, their finishes, whether they're reading it again — and their rating and review, over the
 * household's item. The form edits exactly these, whoever else has read or reviewed it.
 */
function personalItem(item: Item, log: { reads: ReadEntry[]; reviews: ReviewEntry[] }, person: number): Item {
  // summarizeReads takes reads in insertion order
  const mine = log.reads.filter((r) => r.readerId === person).sort((a, b) => a.id - b.id);
  const review = log.reviews.find((r) => r.userId === person);
  return { ...item, ...summarizeReads(mine), rating: review?.rating ?? null, review: review?.review ?? null };
}

/**
 * What's wrong with the form's status and dates, or null (§16 #41). They describe the editor's read that decides
 * their status (§16 #43) — `existing` is the item as personalItem() shows it to them — so: a book not started has no
 * dates, one in progress no completion date, and a book they've read can't be made not started from here — their
 * reads are deleted on its page. A book they're reading again has its reading fields locked (see `rereadLocked`):
 * they describe their last finish, and changing them here would rewrite that.
 */
function formReadProblem(existing: Item | null, v: { status: ItemStatus; beganOn: string | null; completedOn: string | null }): string | null {
  if (v.status === 'not_started') {
    // a book's reads are deleted on its page, one by one; anything else has no such page, so the form clears them
    if (existing && existing.status !== 'not_started' && existing.mediaType === 'book') {
      return 'This book has reads. To make it not started, delete them on its page.';
    }
    return v.beganOn || v.completedOn ? 'A book not started has no reading dates: choose a status, or clear the dates.' : null;
  }
  if (v.status === 'in_progress' && v.completedOn) return 'A book in progress has no completion date: clear it, or choose Completed.';
  // A finished book's status here edits its last finish. "In progress" would reopen that finish and "Abandoned" relabel
  // it a stop — the old way of saying "reading it again", which now loses a read. Its page has the controls for both.
  if (existing?.mediaType === 'book' && existing.readCount > 0) {
    if (v.status === 'in_progress') return 'This book has been finished. To read it again, use Read again on its page.';
    if (v.status === 'abandoned') {
      return 'This book has been finished. To record a read you stopped, use its page: Read again, then Stop — or correct a read there.';
    }
  }
  // Not dead code: the guard above is for books. A record or game has no Reading section, but it can hold a finish
  // and an open read: from a Nalanda re-import, or a re-read book whose type was changed to a record. The database
  // already refuses a second open read (formReadStatements), so without this the form would answer "saved" and drop
  // the status change silently. This says why instead.
  if (v.status === 'in_progress' && existing?.rereading) return 'It already has a read in progress: choose Not started to clear its reads.';
  return readDateProblem({ status: v.status, beganOn: v.beganOn, endedOn: v.status === 'in_progress' ? null : v.completedOn });
}

type ParsedForm = {
  values: Omit<NewItem, 'libraryId'> & { libraryId: number };
  tags: string[];
  coverUrl: string;
  photo: File | null; // a picture taken or picked on a multipart form (§16 #73)
  editions: EditionDraft[]; // "also held as" lines, tidied (§16 #75)
  removeCover: boolean;
  // the item's series (§16 #52): null for none. `seriesSent` is the typed text, for a refused form to give back, and
  // `seriesProblem` why it can't be saved.
  series: SeriesDraft | null;
  seriesSent: { name: string; number: string };
  seriesProblem: string | null;
  /** Why a grade was refused: one off the fixed scale (§16 #55). */
  gradeProblem: string | null;
  /** Why the typed cover URL was refused: it's Discogs' image (§16 #67). */
  coverProblem: string | null;
  /** Why the tags were refused: more than an item takes, or one too long. */
  tagProblem: string | null;
};

/** The most tags one item takes from the form, and the longest — bulk edit's tag action has its own, per action. */
const MAX_TAGS_PER_ITEM = 50;
const MAX_TAG_LENGTH = 100;
const TAGS_REFUSED = `An item takes up to ${MAX_TAGS_PER_ITEM} tags, each up to ${MAX_TAG_LENGTH} characters.`;

const DISCOGS_COVER =
  'Discogs’ images can’t be kept as a cover: its API terms restrict them. Use another image’s URL, or leave the cover blank.';

/** The series fields: a name, and a number that needs one. Blank both, and the item is in no series. */
function parseSeriesFields(nameRaw: string, numberRaw: string): Pick<ParsedForm, 'series' | 'seriesProblem'> {
  const name = cleanSeriesName(nameRaw);
  const number = parseSeriesNumber(numberRaw);
  if (number === undefined) return { series: null, seriesProblem: 'A number in a series is like 3, or 2.5 for a book between two others.' };
  if (!name) return { series: null, seriesProblem: number === null ? null : 'A number in a series needs the series’ name too.' };
  return { series: { name, number }, seriesProblem: null };
}

type Grades = Partial<Pick<NewItem, 'mediaCondition' | 'sleeveCondition'>>;

/**
 * The form's grades (§16 #55). For a record, a field the form didn't send leaves the grade as it is; one it sent
 * blank clears it; one off the scale is refused. An item that isn't a record keeps no grade, whatever the form sent:
 * a record whose type is changed to something else loses its grades with the change — even from a form opened
 * before grades existed, which sends no grade fields at all.
 */
function formGrades(body: Record<string, string | File>, mediaType: MediaType): { grades: Grades; problem: string | null } {
  if (!isRecord(mediaType)) return { grades: { mediaCondition: null, sleeveCondition: null }, problem: null };
  const grades: Grades = {};
  let problem: string | null = null;
  if ('mediaCondition' in body) {
    const g = parseGrade(body['mediaCondition'], 'media');
    if (g === undefined) problem = 'Choose the media grade from the list — Mint to Poor, or Not graded.';
    else grades.mediaCondition = g;
  }
  if ('sleeveCondition' in body) {
    const g = parseGrade(body['sleeveCondition'], 'sleeve');
    if (g === undefined) problem ??= 'Choose the sleeve grade from the list — Mint to Poor, Generic, No Cover, or Not graded.';
    else grades.sleeveCondition = g;
  }
  return { grades, problem };
}

/**
 * The form's purchase price (§16 #61), or nothing to change when the form didn't send the field — one opened before
 * prices existed, or one shown while no currency was set. Blank clears it. The amount is in the currency the form sent,
 * which may only be the household's, or the one the item's price is already in (entered before the household changed
 * currency): the form offers nothing else, and a request that sends another is refused rather than stored.
 */
function formPrice(
  body: Record<string, string | File>,
  household: string | null,
  existing: Item | null,
): { values: Pick<NewItem, 'purchasePrice' | 'purchaseCurrency'> | null; sent?: { amount: string; currency: string }; problem: string | null } {
  if (!('purchasePrice' in body)) return { values: null, problem: null };
  const amount = typeof body['purchasePrice'] === 'string' ? body['purchasePrice'].trim() : '';
  const sentCurrency = typeof body['purchaseCurrency'] === 'string' ? body['purchaseCurrency'].trim() : '';
  const own = isStoredPrice(existing?.purchasePrice, existing?.purchaseCurrency) ? existing!.purchaseCurrency : null;
  const allowed = [own, household].filter((c): c is string => !!c && isCurrencyCode(c));
  const currency = sentCurrency ? (allowed.includes(sentCurrency) ? sentCurrency : null) : (household ?? own ?? null);
  const sent = { amount, currency: currency ?? sentCurrency };
  if (!amount) return { values: { purchasePrice: null, purchaseCurrency: null }, sent, problem: null };
  if (!currency || !isCurrencyCode(currency)) {
    return { values: null, sent, problem: household ? `Enter the price in ${household}.` : 'Set the household currency first: prices are entered in it.' };
  }
  const parsed = parseMoney(amount, currency);
  if (!parsed.ok) return { values: null, sent, problem: parsed.problem };
  return { values: { purchasePrice: parsed.minor, purchaseCurrency: parsed.minor === null ? null : currency }, sent, problem: null };
}

/** The price field's props, for a form shown to `c`'s user. */
const priceField = (c: Context<AppEnv>, household: string | null, price?: ReturnType<typeof formPrice>): PriceFieldProps => ({
  household,
  admin: c.get('user').role === 'admin',
  ...(price?.sent ? { sent: price.sent } : {}),
  error: price?.problem ?? null,
});

/** The "also held as" lines a form sent (`edition-<n>-<field>`), each tidied, empty ones dropped, at most MAX_EDITIONS_PER_ITEM. */
function editionsFromForm(body: Record<string, unknown>, mediaType: MediaType): EditionDraft[] {
  const out: EditionDraft[] = [];
  for (let i = 0; i < MAX_EDITIONS_PER_ITEM + 2 && out.length < MAX_EDITIONS_PER_ITEM; i++) {
    const line = cleanEdition(mediaType, {
      format: body[`edition-${i}-format`],
      isbn: body[`edition-${i}-isbn`],
      publisher: body[`edition-${i}-publisher`],
      year: body[`edition-${i}-year`],
    });
    if (line) out.push(line);
  }
  return out;
}

/** A rating from a form: half-stars 1–10, or none. */
const formRating = (raw: unknown): number | null => {
  const n = Number.parseInt(typeof raw === 'string' ? raw.trim() : '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
};

function parseItemForm(body: Record<string, string | File>): ParsedForm | null {
  const str = (k: string) => {
    const v = body[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const orNull = (v: string) => (v === '' ? null : v);

  const title = str('title');
  const libraryId = Number.parseInt(str('libraryId'), 10);
  if (!title || !Number.isInteger(libraryId)) return null;

  const mediaType = (MEDIA_TYPES as readonly string[]).includes(str('mediaType'))
    ? (str('mediaType') as MediaType)
    : 'other';
  const status = (ITEM_STATUSES as readonly string[]).includes(str('status'))
    ? (str('status') as ItemStatus)
    : 'not_started';
  const lengthNum = Number.parseInt(str('length').replace(/\D/g, ''), 10);
  const copiesNum = Number.parseInt(str('copies').replace(/\D/g, ''), 10);

  // keep details lossless: invalid JSON from the advanced box is discarded, not saved broken
  const detailsObj = parseDetails(str('details') || '{}');
  // the dedicated "Reviewed in" field owns reviewed_in — blank field clears it
  delete detailsObj['reviewed_in'];
  const reviewedIn = str('reviewedIn')
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u));
  if (reviewedIn.length) detailsObj['reviewed_in'] = reviewedIn;
  const details = JSON.stringify(detailsObj);
  const { grades, problem: gradeProblem } = formGrades(body, mediaType);
  const tags = str('tags').split(',').map((t) => t.trim()).filter(Boolean);

  return {
    values: {
      libraryId,
      mediaType,
      title,
      creators: orNull(str('creators')),
      isbn13: orNull(str('isbn13').replace(/\D/g, '')),
      isbn10Upc: orNull(str('isbn10Upc')),
      publisher: orNull(str('publisher')),
      published: orNull(str('published')),
      description: orNull(str('description')),
      length: Number.isFinite(lengthNum) && lengthNum > 0 ? lengthNum : null,
      status,
      rating: formRating(body['rating']),
      review: orNull(str('review')),
      notes: orNull(str('notes')),
      // where it lives (§16 #51): free text, one line — a pasted line break would only hide half of it
      location: orNull(str('location').replace(/\s+/g, ' ')),
      // its language (§16 #76): a code of ours, else null here and the household's in the handler; the original title as written
      language: isLanguageCode(str('language')) ? str('language') : null,
      originalTitle: orNull(str('originalTitle').replace(/\s+/g, ' ')),
      copies: Number.isFinite(copiesNum) && copiesNum >= 0 ? copiesNum : 1, // 0 = cataloged, not owned
      beganOn: orNull(str('beganOn')),
      completedOn: orNull(str('completedOn')),
      details,
      // held as (§16 #75): the kind's checkboxes (`format-<code>`), plus what a provider's hidden field said
      formats: normalizeFormats(mediaType, [
        ...FORMATS[mediaType].filter((f) => str(`format-${f.code}`) === '1').map((f) => f.code),
        ...str('formats').split(','),
      ]),
      ...grades,
    },
    editions: editionsFromForm(body, mediaType),
    tags,
    tagProblem: tags.length > MAX_TAGS_PER_ITEM || tags.some((t) => t.length > MAX_TAG_LENGTH) ? TAGS_REFUSED : null,
    coverUrl: str('coverUrl'),
    // a photo taken or a file picked (§16 #73): a File from a multipart form, else nothing
    photo: body['photo'] instanceof File && body['photo'].size > 0 ? body['photo'] : null,
    removeCover: str('removeCover') === '1',
    ...parseSeriesFields(str('seriesName'), str('seriesNumber')),
    seriesSent: { name: str('seriesName'), number: str('seriesNumber') },
    gradeProblem,
    // A Discogs result's own form never sends its image now, and one from a page rendered before that is ignored on
    // save (POST /items): only a URL someone typed is refused, with the reason — Discogs' image, or a host by number.
    coverProblem:
      body['source'] !== 'discogs' && isDiscogsUrl(str('coverUrl')) ? DISCOGS_COVER : null,
  };
}

/**
 * Why the form can't be saved — a grade off the scale (§16 #55), Discogs' image (§16 #67), a photo that isn't one
 * (§16 #73), its reading, its series, or its tags — or null.
 */
const formProblem = (readProblem: string | null, parsed: ParsedForm, photoProblem: string | null = null) =>
  parsed.gradeProblem ?? parsed.coverProblem ?? photoProblem ?? readProblem ?? parsed.seriesProblem ?? parsed.tagProblem;

/** A photo on the form that can't be a cover: said back on the form, tied to its field, rather than silently kept out. */
const photoProblemOf = async (parsed: ParsedForm): Promise<string | null> =>
  parsed.photo && !(await isUploadableCover(parsed.photo)) ? PHOTO_REFUSED : null;

/** The form's status and dates, as the read they describe. */
const readFields = (v: ParsedForm['values']) => ({ status: v.status ?? 'not_started', beganOn: v.beganOn ?? null, completedOn: v.completedOn ?? null });

/** What a refused form shows again: what was submitted, over the item as it stands (or nothing, for a new one). */
const formItem = (existing: Item | null, v: ParsedForm['values']): Item =>
  ({ ...(existing ?? { id: 0, coverKey: null, readCount: 0, rereading: false }), ...v }) as Item;

/**
 * A book the editor is reading again: their form's status and dates describe their last finish, and are shown
 * locked — the re-read is started, finished and corrected on the book's page. A form that sends them anyway (opened
 * before the re-read began) may only send them unchanged. `item` is the editor's view (personalItem).
 */
const rereadLocked = (item: Item) => item.mediaType === 'book' && item.rereading;

items.post('/items', async (c) => {
  const body = await c.req.parseBody();
  // The Add page's review list posts here with htmx and gets the entry back, added; everything else is redirected.
  const htmx = !!c.req.header('HX-Request');
  // A scan held offline carries the stamp of whoever its review list was shown to (ARCH.md §16 #48). Someone else
  // signed in since, in this tab or another, can't add it as theirs.
  const heldFor = body['scanOwner'];
  if (heldFor !== undefined && heldFor !== (await scanQueueOwner(c.env.SESSION_SECRET ?? '', c.get('user')))) {
    return c.text('That scan was held for whoever was signed in before. Nothing was added — reload Add items.', 409);
  }
  const parsed = parseItemForm(body);
  if (!parsed) return c.text('Title and shelf are required.', 400);
  // the shelf and the household's settings in one call: every added item takes the household's language unless the
  // form or its source said (§16 #76), and a price is read in the household's currency
  const { library: lib, settings: site } = await getLibraryAndSettings(c.env.DB, parsed.values.libraryId);
  if (!lib) return c.text('No such shelf.', 400);
  parsed.values.language ??= site.language;

  // "Log — not owned" on scan/search results: a copies=0 reading-log entry,
  // landing on the edit form so rating/review/status go in immediately.
  const logOnly = body['logOnly'] === '1';
  if (logOnly) parsed.values.copies = 0;
  // "Want to read" / "Want" on a scan or search result (§16 #53): onto the adder's want list. Already in the catalog —
  // a book by ISBN-13, a record by barcode or Discogs id, a game by BGG id — the want goes on that item, with no second
  // copy; otherwise it joins as Not owned, as a Goodreads import's books do, and the want rides in its insert's batch.
  const want = body['want'] === '1';
  if (want) {
    const existing = await existingForWant(c.env.DB, {
      mediaType: parsed.values.mediaType ?? 'other',
      isbn13: parsed.values.isbn13,
      isbn10Upc: parsed.values.isbn10Upc,
      details: parseDetails(parsed.values.details),
    });
    if (existing) {
      await setWant(c.env.DB, existing, c.get('user').id, true);
      // the review list's Want gets its entry back, as its Add does: a redirect reads there as a lapsed session
      if (htmx) return c.html(<ReviewAdded id={existing} title={parsed.values.title} shelf={lib.name} want="existing" />);
      return c.redirect(`/items/${existing}`);
    }
    parsed.values.copies = 0;
  }

  // a price is read only from a form that has the field: a scan's or a search result's add costs no extra call
  const household = 'purchasePrice' in body ? site.currency : null;
  const price = formPrice(body, household, null);
  if (price.values) Object.assign(parsed.values, price.values);
  const photoProblem = await photoProblemOf(parsed);
  const problem = formProblem(formReadProblem(null, readFields(parsed.values)), parsed, photoProblem) ?? price.problem;
  if (problem && htmx) return c.text(problem, 400);
  if (problem) {
    const [libs, people, names, currency] = await Promise.all([
      listLibraries(c.env.DB),
      listPeople(c.env.DB),
      seriesNames(c.env.DB),
      // read above only when the form had a price field; the form shown back always has one
      'purchasePrice' in body ? household : site.currency,
    ]);
    c.status(400);
    return page(
      c,
      'Add item',
      <>
        <div class="page-head">
          <h1>Add item</h1>
        </div>
        <ItemForm
          libraries={libs}
          action="/items"
          submitLabel="Add item"
          item={formItem(null, parsed.values)}
          tags={parsed.tags}
          coverUrl={parsed.coverUrl}
          error={problem}
          coverError={problem === parsed.coverProblem}
          photoError={problem === photoProblem}
          perMember={people.length > 1}
          series={parsed.seriesSent}
          seriesNames={names}
          money={priceField(c, currency, price)}
          editions={parsed.editions}
          language={site.language}
        />
      </>,
      libs, // nothing was written: the sidebar's list too (§16 #68)
    );
  }

  // A Discogs result: one request for its release, before anything is written, for the tracklist and the full
  // pressing the search result lacked (§16 #55). A failure adds the record as the search described it.
  if (body['source'] === 'discogs' && isRecord(parsed.values.mediaType) && c.env.DISCOGS_TOKEN) {
    const releaseId = releaseIdOf(parseDetails(parsed.values.details));
    const found = releaseId ? await discogsPressing(c.env, { releaseId }) : null;
    if (found?.ok) {
      const v = parsed.values;
      const fill = fillPressing(
        { details: v.details ?? '{}', publisher: v.publisher ?? null, published: v.published ?? null, length: v.length ?? null },
        found.pressing,
        'add',
      );
      Object.assign(v, { details: fill.details, publisher: fill.publisher, published: fill.published, length: fill.length });
    }
    // the carrier Discogs names — LP, CD, cassette — as the record's formats, unless the form already said (§16 #75)
    if (!parsed.values.formats) {
      const pressing = parseDetails(parsed.values.details)['format'];
      parsed.values.formats = normalizeFormats(parsed.values.mediaType ?? 'vinyl', formatsFromPressing(typeof pressing === 'string' ? pressing : null));
    }
  }

  // A record from a Discogs result takes its cover from the Cover Art Archive, or has none: never the image the result
  // showed, which is Discogs' Restricted Data (§16 #67). A cover URL typed into the form is the person's own.
  const coverKey =
    parsed.photo
      ? await storeUploadedCover(c.env.COVERS, parsed.photo)
      : body['source'] === 'discogs' && isRecord(parsed.values.mediaType)
      ? (
          await recordCover(
            {
              barcode: recordBarcode({ isbn13: parsed.values.isbn13 ?? null, isbn10Upc: parsed.values.isbn10Upc ?? null }),
              musicbrainzId: parseDetails(parsed.values.details)['musicbrainz_id'],
              title: parsed.values.title,
              creators: parsed.values.creators,
            },
            (url) => storeCover(c.env.COVERS, url),
          )
        ).key
      : await storeCover(c.env.COVERS, parsed.coverUrl);
  let id: number;
  try {
    // its status, dates, rating and review become the adder's read and review (added_by)
    id = await createItemWithTags(
      c.env.DB,
      { ...parsed.values, coverKey, addedBy: c.get('user').id },
      parsed.tags,
      parsed.series,
      { ...(want ? { wantedBy: c.get('user').id } : {}), editions: parsed.editions },
    );
  } catch (err) {
    c.executionCtx.waitUntil(deleteCover(c.env.COVERS, coverKey)); // nothing points at it
    throw err;
  }
  if (htmx && !logOnly) return c.html(<ReviewAdded id={id} title={parsed.values.title} shelf={lib.name} want={want ? 'new' : undefined} />);
  return c.redirect(logOnly ? `/items/${id}/edit` : `/items/${id}`);
});

/** What "Refresh from Discogs" came back with (§16 #55), by the code its redirect carries. Never text from the URL. */
const DISCOGS_NOTICE: Record<string, string> = {
  nothing: 'Discogs had nothing to add: every field it knows is already filled in here.',
  not_found: 'Discogs has no release for this record’s release id or barcode.',
  busy: 'Discogs is busy — it allows 60 requests a minute. Try again in a minute.',
  refused: 'Discogs refused the DISCOGS_TOKEN — it may have been revoked or mistyped.',
  unavailable: 'Discogs didn’t answer. Try again in a moment.',
  changed: 'This record was saved by someone else while Discogs was asked, so nothing was written. Refresh again.',
  nosource: 'Nothing to look it up by: add its barcode, or its Discogs release id as discogs_id in details.',
  notoken: 'Set the DISCOGS_TOKEN secret to fill pressing details from Discogs.',
};

const FILLED_LABEL: Record<string, string> = {
  discogs_id: 'release id',
  label: 'label',
  catno: 'catalogue number',
  country: 'country',
  year: 'year',
  format: 'format',
  genres: 'genres',
  tracklist: 'tracklist',
  publisher: 'publisher',
  published: 'published',
  length: 'length',
};

/**
 * The sentence for a refresh's code: only the fixed ones above, and only the field names it knows. `filled` is what
 * was written, `byBarcode` whether the release was found by a barcode search, `details` the record's as they stand.
 */
function discogsSentence(code: string, filled: string[], byBarcode: boolean, details: Record<string, unknown>): string | null {
  // found by barcode: a search result has no tracklist, but the release id it stored fetches one next time — a
  // promise only while there is a usable id to fetch it by (a hand-typed discogs_id that isn't one keeps the barcode)
  const more =
    byBarcode && !Array.isArray(details['tracklist']) && releaseIdOf(details) ? ' Found by barcode — refresh again for the tracklist.' : '';
  if (code === 'filled') {
    const fields = filled.filter((f) => Object.hasOwn(FILLED_LABEL, f)).map((f) => FILLED_LABEL[f]);
    return `Filled from Discogs: ${fields.length ? fields.join(', ') : 'nothing new'}.${more}`;
  }
  const notice = Object.hasOwn(DISCOGS_NOTICE, code) ? DISCOGS_NOTICE[code]! : null;
  return notice ? notice + (code === 'nothing' ? more : '') : null;
}

/** The sentence for the code the no-script redirect carries, on the page it lands on. Never text from the URL. */
function discogsNotice(c: Context<AppEnv>, details: Record<string, unknown>): string | null {
  const code = c.req.query('discogs');
  if (!code) return null;
  return discogsSentence(code, (c.req.query('f') ?? '').split(','), c.req.query('via') === 'barcode', details);
}

/**
 * Where a refresh's result is said: a live region (an <output>, role "status") that stays on the page while the
 * section beside it is swapped, so htmx fills it out of band and a screen reader hears it — one inserted with its
 * words already in isn't reliably read. The no-script redirect's page shows its sentence here too.
 */
const RefreshStatus = ({ id, notice }: { id: string; notice: string | null }) => (
  <output id={id} class="notice refresh-status" aria-live="polite">
    {notice}
  </output>
);

/**
 * A Refresh button's form. With htmx it swaps `target` in place (§16 #55, #60), its button disabled until the answer
 * is in — one click, one request — and public/app.js says "Asking …" (`busy`) in the live region while it waits, and a
 * fixed sentence there if the request fails. Without script it posts and the handler redirects back.
 */
function RefreshForm({ action, target, status, busy, cls, label, hint }: { action: string; target: string; status: string; busy: string; cls: string; label: string; hint: string }) {
  return (
    <form
      method="post"
      action={action}
      class={`inline-form ${cls}`}
      hx-post={action}
      hx-target={`#${target}`}
      hx-swap="outerHTML"
      hx-disabled-elt="find button"
      data-refresh-status={status}
      data-refresh-busy={busy}
    >
      {/* keeps its id: nothing replaces it, and focus stays on it */}
      <button type="submit" class="btn" id={`${cls}-button`}>
        {label}
      </button>
      <small class="muted">{hint}</small>
    </form>
  );
}

/** The Refresh button, or why there isn't one — and where its result is said. */
function DiscogsRefresh({ item, token, notice }: { item: Item; token: boolean; notice: string | null }) {
  const lookup = !!releaseIdOf(parseDetails(item.details)) || !!recordBarcode(item);
  return (
    <>
      <RefreshStatus id="discogs-status" notice={notice} />
      {!token ? (
        notice ? null : <p class="muted discogs-note">Set the DISCOGS_TOKEN secret to fill pressing details from Discogs.</p>
      ) : !lookup ? (
        notice ? null : <p class="muted discogs-note">Add its barcode, or its Discogs release id, to fill these from Discogs.</p>
      ) : (
        <RefreshForm
          action={`/items/${item.id}/discogs`}
          target="pressing-body"
          status="discogs-status"
          busy="Asking Discogs…"
          cls="discogs-refresh"
          label="Refresh from Discogs"
          hint="Fills what’s blank — never changes what’s here."
        />
      )}
    </>
  );
}

/** What "Refresh from BGG" came back with (§16 #60), by the code its redirect carries. Never text from the URL or BGG. */
const BGG_NOTICE: Record<string, string> = {
  nothing: 'BoardGameGeek had nothing to add: players, playing time and weight are already filled in here.',
  not_found: 'BoardGameGeek has no game with this bgg_id.',
  busy: 'BoardGameGeek is busy — it asks apps to wait a few seconds between requests. Try again shortly.',
  refused: 'BoardGameGeek refused the BGG_TOKEN — it may have been revoked or mistyped.',
  unavailable: 'BoardGameGeek didn’t answer. Try again in a moment.',
  changed: 'This game was saved by someone else while BoardGameGeek was asked, so nothing was written. Refresh again.',
  noid: 'Nothing to look it up by: add its BoardGameGeek id as bgg_id in details.',
  notoken: 'Set the BGG_TOKEN secret to fill game details from BoardGameGeek.',
};

const BGG_FILLED_LABEL: Record<string, string> = {
  players_min: 'min players',
  players_max: 'max players',
  playtime_min: 'min playtime',
  playtime_max: 'max playtime',
  weight: 'weight',
  length: 'length',
};

/** The sentence for a refresh's code: only the fixed ones above, and only the field names it knows. */
function bggSentence(code: string, filled: string[]): string | null {
  if (code === 'filled') {
    const fields = filled.filter((f) => Object.hasOwn(BGG_FILLED_LABEL, f)).map((f) => BGG_FILLED_LABEL[f]);
    return `Filled from BoardGameGeek: ${fields.length ? fields.join(', ') : 'nothing new'}.`;
  }
  return Object.hasOwn(BGG_NOTICE, code) ? BGG_NOTICE[code]! : null;
}

/** The sentence for the code the no-script redirect carries, on the page it lands on. Never text from the URL. */
function bggNotice(c: Context<AppEnv>): string | null {
  const code = c.req.query('bgg');
  if (!code) return null;
  return bggSentence(code, (c.req.query('f') ?? '').split(','));
}

/** A board game's details list: what "Refresh from BGG" swaps in place. */
const GameDetailsList = ({ details }: { details: Record<string, unknown> }) => (
  <div id="game-details">{Object.keys(details).length ? <DetailsList details={details} /> : <p class="muted">No details yet.</p>}</div>
);

/** A board game's details, with the Refresh button — or why there isn't one — below them, and where its result is said. */
function GameDetails({ item, details, token, notice }: { item: Item; details: Record<string, unknown>; token: boolean; notice: string | null }) {
  const lookup = !!bggIdOf(details);
  return (
    <div class="detail-section" id="details">
      <p class="eyebrow">Details</p>
      <GameDetailsList details={details} />
      <RefreshStatus id="bgg-status" notice={notice} />
      {!token ? (
        notice ? null : <p class="muted bgg-note">Set the BGG_TOKEN secret to fill game details from BoardGameGeek.</p>
      ) : !lookup ? (
        notice ? null : <p class="muted bgg-note">Add its BoardGameGeek id as bgg_id in details to fill these from BoardGameGeek.</p>
      ) : (
        <RefreshForm
          action={`/items/${item.id}/bgg`}
          target="game-details"
          status="bgg-status"
          busy="Asking BGG…"
          cls="bgg-refresh"
          label="Refresh from BGG"
          hint="Fills players, playing time and weight where blank — never changes what’s here."
        />
      )}
    </div>
  );
}

/**
 * Published, publisher and length: the item page's props that "Refresh from Discogs" and "Refresh from BGG" can fill,
 * grouped under one id so a refresh's answer swaps them out of band (`oob`). `.props-group` is `display: contents`,
 * so the rows stay in the list's grid; a <div> is a valid way to group a <dl>'s rows.
 */
function FilledProps({ item, oob }: { item: Pick<Item, 'mediaType' | 'published' | 'publisher' | 'length'>; oob?: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div id="item-filled" class="props-group" hx-swap-oob={oob ? 'true' : undefined}>
      {item.published ? (
        <>
          <dt>{t('item.published')}</dt>
          <dd>{item.published}</dd>
        </>
      ) : null}
      {item.publisher ? (
        <>
          <dt>{t('item.publisher')}</dt>
          <dd>
            <a href={`/publishers/${encodeURIComponent(item.publisher.trim())}`}>{item.publisher}</a>
          </dd>
        </>
      ) : null}
      {item.length ? (
        <>
          <dt>{t('item.length')}</dt>
          <dd class="mono">
            {item.length} {lengthUnit(i18n, item.mediaType)}
          </dd>
        </>
      ) : null}
    </div>
  );
}

/**
 * The item page. `reviewError` says why a change to a review from this page was refused; `link` why a purchase link
 * was, with what was sent, so the form shows it again.
 */
async function itemPage(c: Context<AppEnv>, id: number, reviewError?: string, link?: { error: string; label: string; url: string }) {
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const viewer = viewerOf(c);
  // "Recommend to…" (§16 #58): its queries ride in the reading log's batch — no call of their own
  const recommend = await recommendOnItemPage(c, item);
  // the item's history (§16 #84), admins only: its read rides in the reading log's batch too
  const history = viewer.admin ? itemHistoryStatements(c.env.DB, id) : [];
  const [lib, tags, loans, people, log, lent, plays, inSeries] = await Promise.all([
    getLibrary(c.env.DB, item.libraryId),
    tagsForItem(c.env.DB, id),
    activeLoansForItem(c.env.DB, id),
    listPeople(c.env.DB),
    // with its want list and purchase links, in the same call (§16 #53), and Recommend to…'s (§16 #58)
    itemPageLog(c.env.DB, id, [...recommend.statements, ...history]),
    pastLoansForItem(c.env.DB, id),
    playLog(c.env.DB, id),
    // its series, with the viewer's own reading of every volume (§16 #52): one call, only for an item in one
    item.seriesId !== null ? seriesWithVolumes(c.env.DB, item.seriesId, viewer.id) : null,
  ]);
  const editions = log.editions; // "also held as" (§16 #75), read in the reading log's call
  const addedBy = item.addedBy ? (people.find((p) => p.id === item.addedBy) ?? null) : null;
  const grouped = showsPeople(people, viewer, log);
  const ratings = log.reviews.filter((r) => r.rating !== null).length;
  const today = todayOf(c);
  const isOverdue = (l: { dueOn: string | null }) => !!(l.dueOn && l.dueOn < today);
  const overdue = loans.some(isOverdue);
  const loan = loans[0] ?? null; // for the status pill: lent at all, and overdue if any is
  const copyFree = item.copies > loans.length;
  const details = parseDetails(item.details);
  const record = isRecord(item.mediaType);
  const discussion = await itemComments(c, item); // null unless connections are enabled and someone commented
  const recommending = recommend.render(log.extra); // null unless connections are enabled and one is active (§16 #58)
  const changes = viewer.admin ? historyOf(log.extra[recommend.statements.length]) : null;
  const i18n = c.get('i18n');
  const { t } = i18n; // the page's own labels, pills and buttons (§16 #93); its sections keep their English for now

  return page(
    c,
    item.title,
    <article class="item-detail">
      <div class="item-detail-cover">
        <Cover coverKey={item.coverKey} title={item.title} mediaType={item.mediaType} />
        <CoverPhotoForm itemId={item.id} hasCover={!!item.coverKey} error={c.req.query('cover') === 'refused'} />
      </div>
      <div class="item-detail-body">
        <hgroup>
          <h1>{item.title}</h1>
          {item.originalTitle ? <p class="original-title muted">{item.originalTitle}</p> : null}
          {item.creators ? <CreatorLinks creators={item.creators} /> : null}
        </hgroup>
        {tags.length ? (
          <p>
            {tags.map((t) => (
              <a href={`/tags/${encodeURIComponent(t)}`} class="tag">
                {t}
              </a>
            ))}
          </p>
        ) : null}
        <WantBar item={item} wanters={log.want.wanters} viewer={viewer} />

        <dl class="props">
          <dt>{t('item.accession')}</dt>
          <dd class="mono">{accNo(item.id)}</dd>
          <dt>{t('item.shelf')}</dt>
          <dd>{lib ? <a href={`/libraries/${lib.id}`}>{lib.name}</a> : '—'}</dd>
          <dt>{t('item.type')}</dt>
          <dd>
            {mediaLabel(i18n, item.mediaType)} <FormatPills formats={formatsOf(item)} /> <LanguagePill language={item.language} household={log.householdLanguage} />
          </dd>
          {editions.length ? (
            <>
              <dt>{t('item.also_held_as')}</dt>
              <dd>
                <ul class="editions-list">
                  {editions.map((e) => (
                    <li>
                      {[e.format ? formatLabel(e.format) : null, e.publisher, e.year].filter(Boolean).join(', ') || t('item.another_edition')}
                      {e.isbn ? <span class="mono muted"> · {e.isbn}</span> : null}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
          {/* a game or record has no reading status (it takes plays): the row stays only to say it's out */}
          {!isPlayable(item.mediaType) || loan ? (
            <>
              <dt>{t('item.status')}</dt>
              <dd>
                <ItemStatusPills item={item} />
                {loan ? <span class={overdue ? 'pill overdue' : 'pill lent'}>{overdue ? t('pill.overdue') : t('pill.lent')}</span> : null}
              </dd>
            </>
          ) : null}
          <dt>{t('item.holding')}</dt>
          <dd>
            <HoldingPill item={item} />
            {item.copies === 0 && log.want.wanters.length ? <WantedPill /> : null}
            {item.copies === 0 && log.borrows.some((b) => !b.returnedOn) ? <BorrowedPill /> : null}
          </dd>
          {/* where it lives (§16 #51) — private, like notes: share pages and connections never carry it */}
          {item.location ? (
            <>
              <dt>{t('item.location')}</dt>
              <dd>{item.location}</dd>
            </>
          ) : null}
          {/* what was paid (§16 #61): this page only — money is never on share pages or to connections */}
          {isStoredPrice(item.purchasePrice, item.purchaseCurrency) ? (
            <>
              <dt>{t('item.paid')}</dt>
              <dd>
                <Money minor={item.purchasePrice!} currency={item.purchaseCurrency} />
              </dd>
            </>
          ) : null}
          {/* the copy's own condition (§16 #55): this page only — never on share pages or to connections */}
          {record && item.mediaCondition ? (
            <>
              <dt>{t('item.media_grade')}</dt>
              <dd>
                <Grade grade={item.mediaCondition} />
              </dd>
            </>
          ) : null}
          {record && item.sleeveCondition ? (
            <>
              <dt>{t('item.sleeve_grade')}</dt>
              <dd>
                <Grade grade={item.sleeveCondition} />
              </dd>
            </>
          ) : null}
          {item.rating ? (
            <>
              <dt>{t('item.rating')}</dt>
              <dd>
                <span class="rating">{stars(item.rating)}</span>
                {/* the household's: everyone's ratings averaged, as share pages and connections see it */}
                {grouped && ratings > 1 ? <span class="muted rating-note"> {t('item.rating_average', { count: ratings })}</span> : null}
              </dd>
            </>
          ) : null}
          <FilledProps item={item} />
          {item.isbn13 ? (
            <>
              <dt>{t('item.isbn13')}</dt>
              <dd class="mono">{item.isbn13}</dd>
            </>
          ) : null}
          {item.isbn10Upc ? (
            <>
              <dt>{t('item.isbn10')}</dt>
              <dd class="mono">{item.isbn10Upc}</dd>
            </>
          ) : null}
          {item.copies > 1 ? (
            <>
              <dt>{t('item.copies')}</dt>
              <dd class="mono">{item.copies}</dd>
            </>
          ) : null}
          {/* a book's dates are its reads, in the Reading section below; a game or record has no reading dates to show */}
          {item.beganOn && item.mediaType !== 'book' && !isPlayable(item.mediaType) ? (
            <>
              <dt>{t('item.began')}</dt>
              <dd class="mono">{item.beganOn}</dd>
            </>
          ) : null}
          {item.completedOn && item.mediaType !== 'book' && !isPlayable(item.mediaType) ? (
            <>
              <dt>{t('item.completed')}</dt>
              <dd class="mono">{item.completedOn}</dd>
            </>
          ) : null}
          <dt>{t('item.added')}</dt>
          <dd class="mono">
            {ledgerDate(item.addedAt)}
            {addedBy ? ` · ${addedBy.username}` : ''}
          </dd>
        </dl>

        {inSeries ? <SeriesSection series={inSeries.series} volumes={inSeries.volumes} currentId={item.id} /> : null}

        {item.description ? <p class="prewrap">{item.description}</p> : null}

        {record ? (
          <RecordDetails
            details={details}
            inPlace
            after={<DiscogsRefresh item={item} token={!!c.env.DISCOGS_TOKEN} notice={discogsNotice(c, details)} />}
          />
        ) : item.mediaType === 'boardgame' ? (
          <GameDetails item={item} details={details} token={!!c.env.BGG_TOKEN} notice={bggNotice(c)} />
        ) : Object.keys(details).length ? (
          <div class="detail-section">
            <p class="eyebrow">{t('item.details')}</p>
            <DetailsList details={details} />
          </div>
        ) : null}
        {fromBgg(item) ? <BggAttribution /> : null}

        {/* a game's or record's plays (§16 #54) — and any item's that has some, from before its type changed */}
        {isPlayable(item.mediaType) || plays.count ? (
          <PlaysSection item={item} count={plays.count} plays={plays.plays} today={today} viewer={viewer} people={people} />
        ) : null}

        {buyIsShown(item, log.want.wanters) || link ? (
          <BuySection itemId={item.id} links={log.want.links} error={link?.error} label={link?.label} url={link?.url} />
        ) : null}

        {grouped ? (
          <>
            {reviewError ? <p class="error" role="alert">{reviewError}</p> : null}
            <ReviewsSection item={item} reviews={log.reviews} viewer={viewer} people={people} />
          </>
        ) : item.review ? (
          <div class="detail-section">
            <p class="eyebrow">{t('item.review')}</p>
            <p class="prewrap">{item.review}</p>
          </div>
        ) : null}

        {item.mediaType === 'book' ? (
          <QuotesSection
            itemId={item.id}
            quotes={log.quotes}
            viewer={viewer}
            people={people}
            error={
              c.req.query('quote') === 'refused'
                ? 'A quote needs some text.'
                : c.req.query('quote') === 'full'
                  ? `This book has as many quotes as it can hold (${MAX_QUOTES_PER_ITEM}).`
                  : undefined
            }
          />
        ) : null}

        {item.mediaType === 'book' ? (
          <ReadingSection
            item={item}
            reads={log.reads}
            entries={log.entries}
            today={today}
            viewer={viewer}
            people={people}
            grouped={grouped}
          />
        ) : grouped && log.reads.length && !isPlayable(item.mediaType) ? (
          // a record's or game's reads are kept from the edit form; with more than one person, here is whose they are
          <ReadsByPerson item={item} reads={log.reads} viewer={viewer} people={people} today={today} />
        ) : null}

        {discussion}

        {item.notes ? (
          <div class="detail-section">
            <p class="eyebrow">{t('item.notes')}</p>
            <p class="prewrap">{item.notes}</p>
          </div>
        ) : null}

        <div class={loan ? 'circulation' : 'circulation free'}>
          <p class="eyebrow">{t('item.circulation')}</p>
          {item.copies === 0 && !loans.length ? (
            <p class="muted">{t('item.nothing_to_lend')}</p>
          ) : null}
          {/* borrowed from someone not on Nalanda (§16 #82): the mirror of a loan, on an item not owned */}
          {item.copies === 0 ? <BorrowedFrom itemId={item.id} borrows={log.borrows} today={today} /> : null}
          {/* every open loan: with two copies out, both borrowers show, each with its own return */}
          {loans.map((l) => (
            <form method="post" action={`/loans/${l.id}/return`} class="inline-form">
              <span class={isOverdue(l) ? 'error' : undefined}>
                {/* the sentence's order is the translation's: the borrower, the copy and the date go where it puts them */}
                <Fill
                  text={t('item.lent_line')}
                  with={{
                    borrower: <strong>{l.borrower}</strong>,
                    edition: l.edition ? <> ({formatLabel(l.edition).toLowerCase()})</> : '',
                    date: <span class="mono">{l.loanedOn}</span>,
                  }}
                />
                {l.dueOn ? <Fill text={t('item.lent_due')} with={{ date: <span class="mono">{l.dueOn}</span> }} /> : null}
                {/* said in words, not by the vermilion alone */}
                {isOverdue(l) ? <strong>{t('item.lent_overdue')}</strong> : null}
              </span>
              <button type="submit" class="btn">
                {t('item.mark_returned')}
              </button>
            </form>
          ))}
          {copyFree ? (
            <form method="post" action={`/items/${item.id}/loan`} class="inline-form lend-form">
              <input name="borrower" placeholder={t('item.borrower')} aria-label={t('item.borrower')} required />
              <input name="contact" placeholder={t('item.contact')} aria-label={t('item.contact')} />
              {/* which copy, when the item is held in more than one form (§16 #75) */}
              {formatsOf(item).length > 1 ? (
                <select name="edition" aria-label={t('item.which_copy')}>
                  <option value="">{t('item.which_copy_q')}</option>
                  {formatsOf(item).map((code) => (
                    <option value={code}>{formatLabel(code)}</option>
                  ))}
                </select>
              ) : null}
              <label>
                <span class="muted">{t('item.due')}</span>
                <input type="date" name="dueOn" aria-label={t('item.due_date')} />
              </label>
              <button type="submit">{t('item.lend')}</button>
            </form>
          ) : null}
        </div>

        <LendingHistory loans={lent.loans} total={lent.total} />
        {changes ? <ItemHistory entries={changes} /> : null}

        {recommending}

        <div class="actions">
          <a href={`/items/${item.id}/edit`} class="btn">
            {t('item.edit')}
          </a>
          {/* data-confirm, never an inline handler: a translated sentence is text, and the head's listener reads it (§16 #93) */}
          <form method="post" action={`/items/${item.id}/delete`} class="inline" data-confirm={t('item.delete_confirm', { days: TRASH_DAYS })}>
            <button type="submit" class="btn-danger">
              {t('item.delete')}
            </button>
          </form>
        </div>
      </div>
    </article>,
  );
}

items.get('/items/:id', (c) => itemPage(c, Number(c.req.param('id'))));

items.get('/items/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const [libs, tags, log, people, names, current, settings, editions] = await Promise.all([
    listLibraries(c.env.DB),
    tagsForItem(c.env.DB, id),
    readingLog(c.env.DB, id),
    listPeople(c.env.DB),
    seriesNames(c.env.DB),
    item.seriesId !== null ? getSeries(c.env.DB, item.seriesId) : null,
    getSiteSettings(c.env.DB), // the household's currency, for the price field (§16 #61)
    editionsOf(c.env.DB, id), // "also held as" (§16 #75)
  ]);
  return page(
    c,
    `Edit · ${item.title}`,
    <>
      <div class="page-head">
        <div>
          <h1>Edit item</h1>
          <span class="sub mono">{accNo(item.id)}</span>
        </div>
      </div>
      <ItemForm
        libraries={libs}
        action={`/items/${id}`}
        submitLabel="Save changes"
        item={personalItem(item, log, c.get('user').id)}
        tags={tags}
        perMember={people.length > 1}
        series={current ? { name: current.name, number: item.seriesNumber !== null ? formatSeriesNumber(item.seriesNumber) : '' } : null}
        seriesNames={names}
        money={priceField(c, settings.currency)}
        editions={editions}
        language={settings.language}
      />
    </>,
    libs, // the sidebar's list too (§16 #68)
  );
});

// Quick actions from the shelf table / item page: flip copies 0 ↔ 1 in place,
// no edit form. htmx-only — each swaps the clicked button (hx-swap="outerHTML")
// for the other direction's button, so the toggle round-trips.
/**
 * The Reading section after a change, with the status pill above it swapped out of band — starting, finishing or
 * stopping a read changes that too. Without htmx the form posts and lands back on the item page. The change is
 * already saved when this reads it back, so a failed read-back reloads the page rather than failing the request:
 * a retry would record the page, or add the read, twice (§16 #39).
 */
async function readingResponse(c: Context<AppEnv>, id: number, error?: string) {
  if (!c.req.header('HX-Request')) return c.redirect(`/items/${id}`);
  let item: Item | null;
  let log: Awaited<ReturnType<typeof readingLog>>;
  let people: Person[];
  try {
    [item, log, people] = await Promise.all([getItem(c.env.DB, id), readingLog(c.env.DB, id), listPeople(c.env.DB)]);
  } catch {
    c.header('HX-Redirect', `/items/${id}`);
    return c.body(null, 200);
  }
  if (!item) return c.notFound();
  const viewer = viewerOf(c);
  return c.html(
    <>
      {item.mediaType === 'book' ? (
        <ReadingSection
          item={item}
          reads={log.reads}
          entries={log.entries}
          today={todayOf(c)}
          viewer={viewer}
          people={people}
          grouped={showsPeople(people, viewer, log)}
          error={error}
        />
      ) : (
        <ReadsByPerson item={item} reads={log.reads} viewer={viewer} people={people} today={todayOf(c)} error={error} />
      )}
      <ItemStatusPills item={item} oob={true} />
    </>,
  );
}

/** A change to someone else's reading or review, refused (§16 #43). The page never offers one; a hand-made request gets this. */
const notYours = (c: Context<AppEnv>, what: string) => c.text(`That ${what} is someone else’s: only they or an admin can change it.`, 403);

/**
 * The book a reading route is for, or null: starting a read, adding a past one and pages are for books (the edit
 * form covers the rest). Correcting, closing, deleting and moving a read work for any item (`anyType`): a record's or
 * game's reads are someone's too, and an admin fixes them from its page (§16 #43).
 */
async function bookFor(c: Context<AppEnv>, anyType = false): Promise<Item | null> {
  const item = await getItem(c.env.DB, Number(c.req.param('id')));
  return item && (anyType || item.mediaType === 'book') ? item : null;
}

const formDate = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Records a page, in the signed-in person's own open read. A bad number re-renders the section with the reason, and
 * htmx swaps the section either way; without htmx the form posts and lands back on the item page (the browser's
 * pattern check stops most junk before it's sent).
 */
items.post('/items/:id/progress', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  if (item.mediaType !== 'book') return c.text('Reading progress is for books', 400);

  const raw = ((await c.req.parseBody())['page'] ?? '').toString().trim();
  const page = Number(raw);
  const invalid = !/^\d+$/.test(raw) || !Number.isSafeInteger(page) || page < 1 || page > MAX_PROGRESS_PAGE;
  // a finished or stopped book has no open read to record into: reading it again starts with "Read again"; a read
  // that holds all the pages it can takes no more
  const recorded = !invalid && (await addProgress(c.env.DB, id, page, c.get('user').id, todayOf(c)));
  const full = !invalid && !recorded && (await openReadPages(c.env.DB, id, c.get('user').id)) >= MAX_PROGRESS_PER_READ;
  return readingResponse(
    c,
    id,
    invalid
      ? 'Give a whole page number, from 1 to 100,000.'
      : full
        ? `This read has as many pages recorded as it can hold (${MAX_PROGRESS_PER_READ.toLocaleString('en')}). Finish it, or remove an entry.`
        : !recorded
          ? 'This book isn’t being read now. Start a new read first, then record its pages.'
          : undefined,
  );
});

/** Removes a page: its reader's, or anyone's for an admin. */
items.post('/items/:id/progress/:entryId/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const viewer = viewerOf(c);
  const entry = await getProgressEntry(c.env.DB, id, Number(c.req.param('entryId')));
  if (entry && !viewer.admin && entry.ownerId !== viewer.id) return notYours(c, 'page');
  if (entry) await deleteProgress(c.env.DB, id, entry.id, viewer);
  return readingResponse(c, id);
});

// ---------- reads (ARCH.md §16 #41, #43) ----------

/**
 * Starts a read of the signed-in person's own: their first, or "Read again" on a book they've finished — which stays
 * Completed, marked re-reading. Someone else reading it doesn't stop them.
 */
items.post('/items/:id/reads/start', async (c) => {
  const item = await bookFor(c);
  if (!item) return c.notFound();
  const beganOn = formDate((await c.req.parseBody())['date']) ?? todayOf(c);
  const problem = readDateProblem({ status: 'in_progress', beganOn, endedOn: null });
  if (problem) return readingResponse(c, item.id, problem);
  const started = await startRead(c.env.DB, item.id, beganOn, c.get('user').id);
  return readingResponse(
    c,
    item.id,
    started ? undefined : 'A read is already open — finish or stop it first — or this book has as many reads as it can hold.',
  );
});

/**
 * The read a route names, when the signed-in person may change it: 'missing' when there's no such read of this book,
 * 'refused' when it's someone else's and they aren't an admin.
 */
async function readFor(c: Context<AppEnv>, item: Item): Promise<ReadEntry | 'missing' | 'refused'> {
  const read = await getRead(c.env.DB, item.id, Number(c.req.param('readId')));
  if (!read) return 'missing';
  const viewer = viewerOf(c);
  return viewer.admin || read.readerId === viewer.id ? read : 'refused';
}

/** Finishes or stops an open read, on the date given or today — the reader's own, or anyone's for an admin. */
for (const [action, status] of [
  ['finish', 'completed'],
  ['stop', 'abandoned'],
] as const) {
  items.post(`/items/:id/reads/:readId/${action}`, async (c) => {
    const item = await bookFor(c, true);
    if (!item) return c.notFound();
    const read = await readFor(c, item);
    if (read === 'refused') return notYours(c, 'read');
    const endedOn = formDate((await c.req.parseBody())['date']) ?? todayOf(c);
    const problem = readDateProblem({ status, beganOn: null, endedOn });
    if (problem) return readingResponse(c, item.id, problem);
    const closed = read !== 'missing' && (await closeRead(c.env.DB, item.id, read.id, status, endedOn, viewerOf(c)));
    return readingResponse(c, item.id, closed ? undefined : 'That read isn’t open any more, or began after that date.');
  });
}

/** A read of the signed-in person's from before, finished or stopped: "I also read this in 2010". */
items.post('/items/:id/reads', async (c) => {
  const item = await bookFor(c);
  if (!item) return c.notFound();
  const body = await c.req.parseBody();
  const status = body['status'] === 'abandoned' ? 'abandoned' : 'completed';
  const read: ReadDraft = { status, beganOn: formDate(body['beganOn']), endedOn: formDate(body['endedOn']) };
  const problem = readDateProblem(read);
  if (problem) return readingResponse(c, item.id, problem);
  const added = await addPastRead(c.env.DB, item.id, read, c.get('user').id);
  return readingResponse(c, item.id, added ? undefined : 'This book has as many reads as it can hold.');
});

/** Corrects one read's outcome and dates — the reader's own, or anyone's for an admin. */
items.post('/items/:id/reads/:readId', async (c) => {
  const item = await bookFor(c, true);
  if (!item) return c.notFound();
  const found = await readFor(c, item);
  if (found === 'refused') return notYours(c, 'read');
  const body = await c.req.parseBody();
  if (!isReadStatus(body['status'])) return readingResponse(c, item.id, 'Choose how that read went.');
  const read: ReadDraft = {
    status: body['status'],
    beganOn: formDate(body['beganOn']),
    endedOn: body['status'] === 'in_progress' ? null : formDate(body['endedOn']),
  };
  const problem = readDateProblem(read);
  if (problem) return readingResponse(c, item.id, problem);
  const updated = found !== 'missing' && (await updateRead(c.env.DB, item.id, found.id, read, viewerOf(c)));
  return readingResponse(c, item.id, updated ? undefined : 'Another read is open. Finish or stop it before reopening this one.');
});

/** Deletes a read and the pages logged in it — the reader's own, or anyone's for an admin. */
items.post('/items/:id/reads/:readId/delete', async (c) => {
  const item = await bookFor(c, true);
  if (!item) return c.notFound();
  const read = await readFor(c, item);
  if (read === 'refused') return notYours(c, 'read');
  if (read !== 'missing') await deleteRead(c.env.DB, item.id, read.id, viewerOf(c));
  return readingResponse(c, item.id);
});

/** The member a move names, when there is one. */
async function moveTarget(c: Context<AppEnv>): Promise<Person | null> {
  const raw = (await c.req.parseBody())['to'];
  const to = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
  return (await listPeople(c.env.DB)).find((p) => p.id === to) ?? null;
}

/**
 * Moves a read, with its pages, to another member — admins only, to fix history credited to the wrong person, such
 * as everything the upgrade to 1.3.0 gave the first admin (§16 #43).
 */
items.post('/items/:id/reads/:readId/move', async (c) => {
  const item = await bookFor(c, true);
  if (!item) return c.notFound();
  const viewer = viewerOf(c);
  if (!viewer.admin) return c.text('Only an admin can move a read to someone else.', 403);
  const read = await getRead(c.env.DB, item.id, Number(c.req.param('readId')));
  const to = await moveTarget(c);
  if (!read || !to) return readingResponse(c, item.id, 'Choose a member to move that read to.');
  if (read.readerId === to.id) return readingResponse(c, item.id, `That read is ${to.username}’s already.`);
  const moved = await moveRead(c.env.DB, item.id, read.id, to.id, viewer);
  return readingResponse(
    c,
    item.id,
    moved
      ? undefined
      : read.status === 'in_progress'
        ? `${to.username} is reading this book now. Finish or stop that read first, then move this one.`
        : `${to.username} has as many reads of this book as it can hold.`,
  );
});

// ---------- reviews (ARCH.md §16 #43) ----------

/** The review a route names, when the signed-in person may change it — as readFor. */
async function reviewFor(c: Context<AppEnv>, itemId: number): Promise<ReviewEntry | 'missing' | 'refused'> {
  const review = await getReview(c.env.DB, itemId, Number(c.req.param('reviewId')));
  if (!review) return 'missing';
  const viewer = viewerOf(c);
  return viewer.admin || review.userId === viewer.id ? review : 'refused';
}

/** Edits a review from the item page — the writer's own, or anyone's for an admin. Both fields empty deletes it. */
items.post('/items/:id/reviews/:reviewId', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const found = await reviewFor(c, id);
  if (found === 'refused') return notYours(c, 'review');
  if (found === 'missing') return itemPage(c, id, 'That review isn’t there any more.');
  const body = await c.req.parseBody();
  await updateReview(c.env.DB, id, found.id, { rating: formRating(body['rating']), review: reviewText(String(body['review'] ?? '').trim()) }, viewerOf(c));
  return c.redirect(`/items/${id}#reviews`);
});

// ---------- quotes and highlights (§16 #77) ----------

/** What a quote form sent, tidied, or null without any text. */
const quoteFromForm = (body: Record<string, unknown>): QuoteDraft | null =>
  cleanQuote({ text: body['text'], page: body['where'], note: body['note'], shared: body['shared'] === '1' });

/** Adds the signed-in person's quote to a book. */
items.post('/items/:id/quotes', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  if (item.mediaType !== 'book') return c.text('Quotes are for books', 400); // the page offers them for books only
  const draft = quoteFromForm(await c.req.parseBody());
  if (!draft) return c.redirect(`/items/${id}?quote=refused#quotes`);
  const added = await addQuote(c.env.DB, id, c.get('user').id, draft);
  // not added: the same text of theirs is on it already (nothing to say), or the book holds all it can
  if (!added && (await quoteCount(c.env.DB, id)) >= MAX_QUOTES_PER_ITEM) return c.redirect(`/items/${id}?quote=full#quotes`);
  return c.redirect(`/items/${id}#quotes`);
});

/** Edits a quote — the writer's own, or anyone's for an admin; the share checkbox is part of it. */
items.post('/items/:id/quotes/:quoteId', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const quote = await getQuote(c.env.DB, id, Number(c.req.param('quoteId')));
  if (!quote) return c.redirect(`/items/${id}#quotes`);
  const viewer = viewerOf(c);
  if (!viewer.admin && quote.userId !== viewer.id) return notYours(c, 'quote');
  const draft = quoteFromForm(await c.req.parseBody());
  if (!draft) return c.redirect(`/items/${id}?quote=refused#quotes`);
  await updateQuote(c.env.DB, id, quote.id, draft, viewer);
  return c.redirect(`/items/${id}#quotes`);
});

items.post('/items/:id/quotes/:quoteId/delete', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const quote = await getQuote(c.env.DB, id, Number(c.req.param('quoteId')));
  if (quote) {
    const viewer = viewerOf(c);
    if (!viewer.admin && quote.userId !== viewer.id) return notYours(c, 'quote');
    await deleteQuote(c.env.DB, id, quote.id, viewer);
  }
  return c.redirect(`/items/${id}#quotes`);
});

/** Deletes a review — the writer's own, or anyone's for an admin. */
items.post('/items/:id/reviews/:reviewId/delete', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const found = await reviewFor(c, id);
  if (found === 'refused') return notYours(c, 'review');
  if (found !== 'missing') await deleteReview(c.env.DB, id, found.id, viewerOf(c));
  return c.redirect(`/items/${id}#reviews`);
});

/** Moves a review to another member — admins only, as a read. One review each: a member who has one must lose it first. */
items.post('/items/:id/reviews/:reviewId/move', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const viewer = viewerOf(c);
  if (!viewer.admin) return c.text('Only an admin can move a review to someone else.', 403);
  const review = await getReview(c.env.DB, id, Number(c.req.param('reviewId')));
  const to = await moveTarget(c);
  if (!review || !to) return itemPage(c, id, 'Choose a member to move that review to.');
  if (review.userId === to.id) return itemPage(c, id, `That review is ${to.username}’s already.`);
  if (!(await moveReview(c.env.DB, id, review.id, to.id, viewer))) {
    c.status(409);
    return itemPage(c, id, `${to.username} has a review of this already: delete one of the two first, then move.`);
  }
  return c.redirect(`/items/${id}#reviews`);
});

// ---------- plays (ARCH.md §16 #54) ----------

/**
 * The Plays section after a change, for htmx; without it, back to the item page. As readingResponse: the change is
 * already saved, so a failed read-back reloads the page rather than failing the request — a retry would log the play
 * twice.
 */
async function playsResponse(c: Context<AppEnv>, id: number, error?: string) {
  if (!c.req.header('HX-Request')) return c.redirect(`/items/${id}`);
  let item: Item | null;
  let plays: Awaited<ReturnType<typeof playLog>>;
  let people: Person[];
  try {
    [item, plays, people] = await Promise.all([getItem(c.env.DB, id), playLog(c.env.DB, id), listPeople(c.env.DB)]);
  } catch {
    c.header('HX-Redirect', `/items/${id}`);
    return c.body(null, 200);
  }
  if (!item) return c.notFound();
  return c.html(<PlaysSection item={item} count={plays.count} plays={plays.plays} today={todayOf(c)} viewer={viewerOf(c)} people={people} error={error} />);
}

/** "Played": a play of a board game or a record, today or on the date given, logged by the signed-in person. */
items.post('/items/:id/plays', async (c) => {
  const item = await getItem(c.env.DB, Number(c.req.param('id')));
  if (!item) return c.notFound();
  if (!isPlayable(item.mediaType)) return c.text('Plays are for board games and records. A book has reads.', 400);
  const playedOn = formDate((await c.req.parseBody())['date']) ?? todayOf(c);
  const problem = playDateProblem(playedOn);
  if (problem) return playsResponse(c, item.id, problem);
  const logged = await logPlay(c.env.DB, item.id, playedOn, c.get('user').id);
  return playsResponse(c, item.id, logged ? undefined : 'This has as many plays as it can hold.');
});

/** Every play of an item, a page at a time — where a play older than the item page lists can be removed. */
const PLAYS_PAGE = 100;
items.get('/items/:id/plays', async (c) => {
  const item = await getItem(c.env.DB, Number(c.req.param('id')));
  if (!item) return c.notFound();
  // held to what an item can hold (MAX_PLAYS_PER_ITEM / PLAYS_PAGE pages): a huge ?page= would bind an offset SQLite refuses
  const pageNum = Math.min(Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1), Math.ceil(MAX_PLAYS_PER_ITEM / PLAYS_PAGE) + 1);
  const [plays, people] = await Promise.all([playLog(c.env.DB, item.id, PLAYS_PAGE, (pageNum - 1) * PLAYS_PAGE), listPeople(c.env.DB)]);
  const pages = Math.max(1, Math.ceil(plays.count / PLAYS_PAGE));
  return page(
    c,
    `Plays · ${item.title}`,
    <>
      <div class="page-head">
        <div>
          <h1>{item.mediaType === 'vinyl' ? 'Listening log' : 'Play log'}</h1>
          <span class="sub">
            <a href={`/items/${item.id}`}>{item.title}</a> · <span class="mono">{plays.count}</span> {plays.count === 1 ? 'play' : 'plays'}
          </span>
        </div>
      </div>
      {plays.plays.length ? (
        <AllPlays item={item} plays={plays.plays} viewer={viewerOf(c)} people={people} page={pageNum} />
      ) : (
        <p class="muted">{plays.count ? 'No plays on this page.' : 'Not played yet.'}</p>
      )}
      <Pagination page={Math.min(pageNum, pages)} pages={pages} makeHref={(p) => `/items/${item.id}/plays?page=${p}`} />
    </>,
  );
});

/**
 * Removes a play — one the signed-in person logged, or any for an admin. From the plays page (`back`), the form posts
 * and returns there; from the item page, htmx swaps the section.
 */
items.post('/items/:id/plays/:playId/delete', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const viewer = viewerOf(c);
  const play = await getPlay(c.env.DB, id, Number(c.req.param('playId')));
  if (play && !viewer.admin && play.loggedBy !== viewer.id) {
    return c.text('That play was logged by someone else: only they or an admin can remove it.', 403);
  }
  if (play) await deletePlay(c.env.DB, id, play.id, viewer);
  const back = c.req.query('back');
  if (back && /^plays(\?page=\d{1,6})?$/.test(back)) return c.redirect(`/items/${id}/${back}`);
  return playsResponse(c, id);
});

/**
 * "Refresh from Discogs" (§16 #55): one Discogs request per click — the release by its stored id, else a barcode
 * search — then the blanks it can fill, written only if nothing changed meanwhile. It never overwrites a value:
 * fillPressing() says exactly which fields it may write. With htmx it answers 200 whatever the result — htmx swaps
 * nothing on an error status — with the pressing section's content, what else a fill changes (the rest of the details,
 * published, publisher, length) out of band, and the result's fixed sentence into the section's live region: no read
 * beyond the record's own, since a fill's values are what it wrote — except after losing the race ("changed"), the
 * rare path, which reads the record again to show the edit that won. Without htmx, a redirect back to the section.
 */
items.post('/items/:id/discogs', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  if (!isRecord(item.mediaType)) return c.text('Pressing details are for records.', 400);
  const htmx = !!c.req.header('HX-Request');
  const answer = (code: string, fill?: Filled, byBarcode = false, current: Item = item) => {
    if (!htmx) {
      const f = fill ? `&f=${fill.filled.join(',')}` : '';
      return c.redirect(`/items/${id}?discogs=${code}${f}${byBarcode ? '&via=barcode' : ''}#pressing`);
    }
    const shown = fill ? { ...item, details: fill.details, publisher: fill.publisher, published: fill.published, length: fill.length } : current;
    const details = parseDetails(shown.details);
    return c.html(
      <>
        <PressingSwap details={details} />
        <FilledProps item={shown} oob />
        <output id="discogs-status" hx-swap-oob="innerHTML">
          {discogsSentence(code, fill?.filled ?? [], byBarcode, details)}
        </output>
      </>,
    );
  };
  if (!c.env.DISCOGS_TOKEN) return answer('notoken');
  const releaseId = releaseIdOf(parseDetails(item.details));
  const barcode = recordBarcode(item);
  if (!releaseId && !barcode) return answer('nosource');
  const found = await discogsPressing(c.env, releaseId ? { releaseId } : { barcode: barcode! });
  if (!found.ok) return answer(found.failure);
  const byBarcode = found.via === 'barcode';
  const fill = fillPressing(item, found.pressing, 'gaps');
  if (!fill.filled.length) return answer('nothing', undefined, byBarcode);
  if (!(await applyPressingFill(c.env.DB, id, item, fill, writerOf(c)))) {
    // someone saved it meanwhile: in place, show what they saved (one more read, on this rare path only)
    const now = htmx ? await getItem(c.env.DB, id) : item;
    return now ? answer('changed', undefined, false, now) : c.notFound();
  }
  return answer('filled', fill, byBarcode);
});

// ---------- want lists and purchase links (ARCH.md §16 #53) ----------

/**
 * Puts the item on the signed-in member's own want list, or takes it off — `want` says which, so a double submit
 * can't flip it back. Nobody changes anyone else's list: there is no member in the request to name. htmx swaps the
 * bar; otherwise back to the item page.
 */
items.post('/items/:id/want', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const user = c.get('user');
  const body = await c.req.parseBody();
  await setWant(c.env.DB, id, user.id, body['want'] === '1');
  // "Take off my list" on the want-list page goes back there
  if (!c.req.header('HX-Request')) return c.redirect(body['back'] === 'wants' ? '/wants' : `/items/${id}`);
  // saved already: a failed read-back reloads the page rather than failing the request (§16 #39)
  try {
    const { wanters } = await wantsAndLinks(c.env.DB, id);
    return c.html(<WantBar item={item} wanters={wanters} viewer={{ id: user.id }} />);
  } catch {
    c.header('HX-Redirect', `/items/${id}`);
    return c.body(null, 200);
  }
});

/** The Where to buy section after a change, for htmx; the item page otherwise — with the reason when a link was refused. */
async function linksResponse(c: Context<AppEnv>, id: number, refused?: { error: string; label: string; url: string }) {
  if (!c.req.header('HX-Request')) {
    if (!refused) return c.redirect(`/items/${id}#buy`);
    c.status(400);
    return itemPage(c, id, undefined, refused);
  }
  try {
    const { links } = await wantsAndLinks(c.env.DB, id);
    // a refusal answers 200: htmx swaps nothing on a 4xx by default, and the section must show why
    return c.html(<BuySection itemId={id} links={links} error={refused?.error} label={refused?.label} url={refused?.url} />);
  } catch {
    c.header('HX-Redirect', `/items/${id}`);
    return c.body(null, 200);
  }
}

/** Adds a pasted purchase link — the item's, so any member may. Only an absolute http(s) address is taken. */
items.post('/items/:id/links', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const body = await c.req.parseBody();
  const label = typeof body['label'] === 'string' ? body['label'] : '';
  const url = typeof body['url'] === 'string' ? body['url'] : '';
  const link = checkPurchaseLink(label, url);
  if (typeof link === 'string') return linksResponse(c, id, { error: link, label, url });
  const added = await addPurchaseLink(c.env.DB, id, link);
  if (added === 'missing') return c.notFound();
  if (added === 'duplicate') return linksResponse(c, id, { error: 'That link is here already.', label, url });
  if (added === 'full') return linksResponse(c, id, { error: `An item holds at most ${MAX_LINKS_PER_ITEM} links: remove one first.`, label, url });
  return linksResponse(c, id);
});

/** Removes a purchase link — any member may. */
items.post('/items/:id/links/:linkId/delete', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return c.notFound();
  const linkId = Number(c.req.param('linkId'));
  if (Number.isSafeInteger(linkId)) await deletePurchaseLink(c.env.DB, id, linkId);
  return linksResponse(c, id);
});

/**
 * "Refresh from BGG" (§16 #60): one BGG request per click — the game by its stored bgg_id — then the blanks it can
 * fill, written only if nothing changed meanwhile. It never overwrites a value: fillGame() says exactly which fields it
 * may write. Never called on a page load. With htmx it answers 200 whatever the result — htmx swaps nothing on an
 * error status — with the details list, the length out of band, and the result's fixed sentence into the section's
 * live region: no read beyond the game's own, since a fill's values are what it wrote — except after losing the race
 * ("changed"), the rare path, which reads the game again to show the edit that won. Without htmx, a redirect back to
 * the details section.
 */
items.post('/items/:id/bgg', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  if (item.mediaType !== 'boardgame') return c.text('BoardGameGeek details are for board games.', 400);
  const htmx = !!c.req.header('HX-Request');
  const answer = (code: string, fill?: GameFill, current: Item = item) => {
    if (!htmx) return c.redirect(`/items/${id}?bgg=${code}${fill ? `&f=${fill.filled.join(',')}` : ''}#details`);
    const shown = fill ? { ...item, details: fill.details, length: fill.length } : current;
    return c.html(
      <>
        <GameDetailsList details={parseDetails(shown.details)} />
        <FilledProps item={shown} oob />
        <output id="bgg-status" hx-swap-oob="innerHTML">
          {bggSentence(code, fill?.filled ?? [])}
        </output>
      </>,
    );
  };
  if (!c.env.BGG_TOKEN) return answer('notoken');
  const bggId = bggIdOf(parseDetails(item.details));
  if (!bggId) return answer('noid');
  const found = await bggRefresh(c.env, bggId);
  if (!found.ok) return answer(found.failure);
  const fill = fillGame(item, found.game);
  if (!fill.filled.length) return answer('nothing');
  if (!(await applyGameFill(c.env.DB, id, item, fill, writerOf(c)))) {
    // someone saved it meanwhile: in place, show what they saved (one more read, on this rare path only)
    const now = htmx ? await getItem(c.env.DB, id) : item;
    return now ? answer('changed', undefined, now) : c.notFound();
  }
  return answer('filled', fill);
});

items.post('/items/:id/mark-owned', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  if (item.copies === 0 && !(await markOwnedUnlessBorrowed(c.env.DB, id, writerOf(c)))) {
    // borrowed from someone (§16 #82): theirs until it is marked returned — the button stays, and says why
    const lender = await openBorrowLender(c.env.DB, id);
    return partial(
      c,
      <>
        <MarkOwnedButton id={id} />{' '}
        <small class="error" role="alert">
          Borrowed from {lender ?? 'someone'} — mark it returned first.
        </small>
      </>,
    );
  }
  return partial(c, <MarkNotOwnedButton id={id} />);
});

items.post('/items/:id/mark-not-owned', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  // Only the single copy the toggle knows how to restore. A real count (2+) is
  // left alone even for a hand-rolled POST — zeroing it would silently discard a
  // number that round-trips through /export.csv.
  if (item.copies > 1) return partial(c, <CopiesPill copies={item.copies} />);
  if (item.copies === 1 && !(await markNotOwnedUnlessLent(c.env.DB, id, writerOf(c)))) {
    // the copy is out on loan — still ours until it is back (§16 #13) — or the count changed since the page was drawn
    const now = await getItem(c.env.DB, id);
    if (!now) return c.notFound();
    if (now.copies > 1) return partial(c, <CopiesPill copies={now.copies} />);
    if (now.copies === 1) {
      const [loan] = await activeLoansForItem(c.env.DB, id);
      return partial(
        c,
        <>
          <MarkNotOwnedButton id={id} />{' '}
          <small class="error" role="alert">
            Out on loan{loan ? ` to ${loan.borrower}` : ''} — mark it returned first.
          </small>
        </>,
      );
    }
  }
  return partial(c, <MarkOwnedButton id={id} />);
});

items.post('/items/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await getItem(c.env.DB, id);
  if (!existing) return c.notFound();
  const body = await c.req.parseBody();
  const parsed = parseItemForm(body);
  if (!parsed) return c.text('Title and shelf are required.', 400);
  const [lib, log, people, settings] = await Promise.all([
    getLibrary(c.env.DB, parsed.values.libraryId),
    readingLog(c.env.DB, id),
    listPeople(c.env.DB),
    getSiteSettings(c.env.DB), // the household's currency (§16 #61)
  ]);
  if (!lib) return c.text('No such shelf.', 400);
  const price = formPrice(body, settings.currency, existing);
  if (price.values) Object.assign(parsed.values, price.values);
  const user = c.get('user');
  // the form's reading, rating and review are the editor's own (§16 #43)
  const mine = personalItem(existing, log, user.id);
  const locked = rereadLocked(mine);
  const sent = readFields(parsed.values);
  const unchanged =
    sent.status === mine.status && sent.beganOn === (mine.beganOn || null) && sent.completedOn === (mine.completedOn || null);
  const photoProblem = await photoProblemOf(parsed);
  const refused = async (problem: string) => {
    const [libs, names] = await Promise.all([listLibraries(c.env.DB), seriesNames(c.env.DB)]);
    c.status(400);
    return page(
      c,
      `Edit · ${existing.title}`,
      <>
        <div class="page-head">
          <div>
            <h1>Edit item</h1>
            <span class="sub mono">{accNo(existing.id)}</span>
          </div>
        </div>
        <ItemForm
          libraries={libs}
          action={`/items/${id}`}
          submitLabel="Save changes"
          item={formItem(mine, locked ? { ...parsed.values, status: mine.status, beganOn: mine.beganOn, completedOn: mine.completedOn } : parsed.values)}
          tags={parsed.tags}
          coverUrl={parsed.coverUrl}
          removeCover={parsed.removeCover}
          error={problem}
          coverError={problem === parsed.coverProblem}
          photoError={problem === photoProblem}
          editions={parsed.editions}
          perMember={people.length > 1}
          series={parsed.seriesSent}
          seriesNames={names}
          money={priceField(c, settings.currency, price)}
        />
      </>,
      libs, // nothing was written: the sidebar's list too (§16 #68)
    );
  };
  const problem = formProblem(
    locked
      ? 'status' in body && !unchanged
        ? 'This book is being read again: its reads are started, finished and corrected on its page, not here.'
        : null
      : formReadProblem(mine, sent),
    parsed,
    photoProblem,
  ) ?? price.problem;
  if (problem) return refused(problem);

  // a form without a language of ours keeps the item's own (§16 #76): never a NULL written over a code
  parsed.values.language ??= existing.language ?? settings.language;
  let coverKey = existing.coverKey;
  if (parsed.removeCover) coverKey = null;
  // a photo on the form takes the place of a URL beside it — it's the one the person just took, and the URL isn't
  // fetched (§16 #73)
  if (parsed.photo) coverKey = (await storeUploadedCover(c.env.COVERS, parsed.photo)) ?? coverKey;
  else if (parsed.coverUrl) coverKey = (await storeCover(c.env.COVERS, parsed.coverUrl)) ?? coverKey;

  let saved: boolean;
  try {
    saved = await updateItemWithTags(
      c.env.DB,
      id,
      { ...parsed.values, coverKey },
      parsed.tags,
      locked ? undefined : { ...sent, clearReads: existing.mediaType !== 'book' },
      user.id,
      { rating: parsed.values.rating ?? null, review: reviewText(parsed.values.review) },
      // a form without the series fields (one opened before they existed) leaves the series as it is
      'seriesName' in body || 'seriesNumber' in body ? parsed.series : undefined,
      // likewise "also held as": a form without its lines leaves them as they are (§16 #75)
      'edition-0-isbn' in body ? parsed.editions : undefined,
      writerOf(c), // for the item's history (§16 #84)
    );
  } catch (err) {
    if (coverKey !== existing.coverKey) c.executionCtx.waitUntil(deleteCover(c.env.COVERS, coverKey)); // the new one: unused
    throw err;
  }
  if (!saved) {
    // the count was refused in the statement, and nothing of the form was saved: a copy can't be counted as yours while
    // a borrow is open (§16 #82), nor can copies go below what is out on loan (§16 #13) — say which held it
    if (coverKey !== existing.coverKey) c.executionCtx.waitUntil(deleteCover(c.env.COVERS, coverKey)); // the new one: unused
    const lender = (parsed.values.copies ?? 1) > 0 ? await openBorrowLender(c.env.DB, id) : null;
    const out = (await activeLoansForItem(c.env.DB, id)).length;
    return refused(
      lender
        ? `Borrowed from ${lender} — mark it returned before counting a copy as yours.`
        : `${out} ${out === 1 ? 'copy is' : 'copies are'} out on loan — mark ${out === 1 ? 'it' : 'them'} returned before counting fewer.`,
    );
  }
  // Only now is the old cover unreferenced. Deleted before the save, as it was, a failed save left the item
  // pointing at a cover that was gone.
  if (coverKey !== existing.coverKey) c.executionCtx.waitUntil(deleteCover(c.env.COVERS, existing.coverKey));
  return c.redirect(`/items/${id}`);
});

/**
 * A cover from the phone's camera, or a file (§16 #73): any member, as any catalog edit is. The browser resized it;
 * here it is only sniffed and stored, and the item pointed at it, the old object deleted once nothing points at it. A
 * file that isn't a raster image, or is empty or past the size limit, is refused back to the page with the reason.
 * `action=remove` clears the cover instead.
 */
items.post('/items/:id/cover', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const body = await c.req.parseBody();
  if (body['action'] === 'remove') {
    const was = await setCover(c.env.DB, id, null, writerOf(c));
    c.executionCtx.waitUntil(deleteCover(c.env.COVERS, was?.before));
    return c.redirect(`/items/${id}`);
  }
  const photo = body['photo'] instanceof File && body['photo'].size > 0 ? body['photo'] : null;
  const key = await storeUploadedCover(c.env.COVERS, photo);
  if (!key) return c.redirect(`/items/${id}?cover=refused`);
  const was = await setCover(c.env.DB, id, key, writerOf(c));
  if (!was) {
    c.executionCtx.waitUntil(deleteCover(c.env.COVERS, key)); // the item went while the photo was stored
    return c.notFound();
  }
  if (was.before !== key) c.executionCtx.waitUntil(deleteCover(c.env.COVERS, was.before));
  return c.redirect(`/items/${id}`);
});

/** Deletes an item into the trash (§16 #74): its cover's object stays until the trash row is purged. */
items.post('/items/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item) return c.notFound();
  const user = c.get('user');
  const expired = await deleteItem(c.env.DB, id, { id: user.id, sessionKey: user.sessionKey });
  c.executionCtx.waitUntil(Promise.all(expired.map((k) => deleteCover(c.env.COVERS, k)))); // purged rows' covers, not this one's
  return c.redirect(`/libraries/${item.libraryId}`);
});

export default items;
