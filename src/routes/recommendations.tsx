// Recommendations between connected households (ARCH.md §16 #58): "Recommend to…" on an item's page, which sends one
// of this household's items to one connected household with an optional note, and the Recommended page, which lists
// what connected households recommended here — to add to a want list, or dismiss.
//
// Any member may recommend, signed with outwardName() — a display name while names go to connections, else "A member",
// never the username. Only an item inside a connection view can be recommended, so a recommendation never shows a
// connection anything its views don't. Everything a recommendation from them carries is a string from another
// instance and renders only as escaped text; its cover loads only from their own /covers/<uuid>.
import { Hono, type Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import {
  claimRecommendation,
  dismissRecommendation,
  getConnection,
  getFederationSettings,
  getRecommendation,
  linkWantedItem,
  openRecommendations,
  recommendableItem,
  recommendTargets,
  recommendToConnection,
  sentRecommendations,
  sentToday,
  wantedBefore,
  wantRecommendedAs,
  type RecommendTarget,
} from '../db/federation';
import { createItemWithTags, existingForWant, getItem, getLibrary, listLibraries, outwardName } from '../db/queries';
import type { FederationSettings, Item, RecommendationStatus } from '../db/schema';
import type { AppEnv } from '../env';
import { refreshInBackground } from '../federation/background';
import { MAX_RECOMMEND_NOTE_CHARS, MAX_SENT_PER_DAY, RECOMMENDATIONS_SHOWN } from '../federation/config';
import { fetchDescriptor, peerAccepts } from '../federation/http';
import { coverUrl, itemStamp, toRecommendedItem } from '../federation/items';
import { loadIdentity, type Identity } from '../federation/keys';
import { recommend, RECOMMEND_ID_KEYS, recommendId, type RecommendIds } from '../federation/messages';
import { pushNow } from '../federation/outbox';
import { deleteCover, storeCover } from '../lib/covers';
import { MEDIA_LABEL } from '../views/components';
import { page } from '../views/layout';
import { TheirCover } from './borrowing';

const recommendations = new Hono<AppEnv>();

type Enabled = { identity: Identity; settings: FederationSettings };

async function enabled(c: Context<AppEnv>): Promise<Enabled | null> {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return null;
  const settings = await getFederationSettings(c.env.DB);
  return settings ? { identity, settings } : null;
}

const digits = (raw: unknown) => (typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : null);
const noteText = (raw: unknown) => (typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').trim() : '');

// ---------- sending, from an item's page ----------

/**
 * What became of a send, by the code its redirect carries: the sentence, whether it's an error, and which field it's
 * about. Only these codes are ever shown, and the household's name comes from this instance's own list.
 */
const OUTCOMES: Record<string, { error: boolean; field: 'to' | 'note'; text: (household: string) => string }> = {
  sent: { error: false, field: 'to', text: (h) => `Recommended to ${h}.` },
  queued: {
    error: false,
    field: 'to',
    text: (h) => `Recommended to ${h}. Their library didn’t answer just now, so it waits here and reaches them when it’s back.`,
  },
  old: {
    error: true,
    field: 'to',
    text: (h) => `${h} runs an older version of Nalanda that can’t take recommendations yet. Nothing was sent.`,
  },
  unreachable: { error: true, field: 'to', text: (h) => `Couldn’t reach ${h} just now. Nothing was sent — try again later.` },
  refused: {
    error: true,
    field: 'to',
    text: (h) => `${h} couldn’t take it: they may have too many recommendations waiting, or have had enough for today.`,
  },
  duplicate: { error: true, field: 'to', text: (h) => `You’ve already recommended this to ${h}.` },
  limit: { error: true, field: 'to', text: (h) => `You’ve sent ${h} as many messages as one day allows. Try again tomorrow.` },
  household: { error: true, field: 'to', text: () => 'Choose a connected household to recommend it to.' },
  note: { error: true, field: 'note', text: () => `A note can be at most ${MAX_RECOMMEND_NOTE_CHARS} characters.` },
  unshared: {
    error: true,
    field: 'to',
    text: () => 'Only items on a shelf you share with connections can be recommended. Nothing was sent.',
  },
};

const SENT_STATE: Partial<Record<RecommendationStatus, string>> = { open: 'recommended', refused: 'refused' };

/**
 * "Recommend to…" for an item's page: null unless connections are on and there is a household to send to, so the page
 * is otherwise unchanged. One D1 call for the households, a second for the name it would be signed with.
 */
export async function recommendSection(c: Context<AppEnv>, item: Item): Promise<Child | null> {
  if (!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY))) return null;
  const { shared, households } = await recommendTargets(c.env.DB, item.id);
  if (!households.length) return null;
  const code = c.req.query('recommend');
  const outcome = code && Object.hasOwn(OUTCOMES, code) ? OUTCOMES[code]! : null;
  const to = digits(c.req.query('to'));
  const named = households.find((h) => h.id === to)?.householdName ?? 'them';
  const open = households.filter((h) => h.lastStatus !== 'open');
  const signedAs = shared && open.length ? await outwardName(c.env.DB, c.get('user').id) : null;
  const errorFor = (field: 'to' | 'note') => (outcome?.error && outcome.field === field ? 'recommend-status' : undefined);

  return (
    <details class="recommend" id="recommend" open={outcome ? true : undefined}>
      <summary>Recommend to…</summary>
      {outcome ? (
        <p id="recommend-status" class={outcome.error ? 'error' : 'notice'} role={outcome.error ? 'alert' : 'status'}>
          {outcome.text(named)}
        </p>
      ) : null}
      {!shared ? (
        <p class="muted">
          Only items on a shelf you share with connections can be recommended. An admin chooses what’s shared on Connections.
        </p>
      ) : open.length ? (
        <form method="post" action={`/items/${item.id}/recommend`} class="recommend-form">
          <label for="recommend-to">Household</label>
          <select id="recommend-to" name="connectionId" required aria-invalid={errorFor('to') ? 'true' : undefined} aria-describedby={errorFor('to')}>
            {open.map((h) => (
              <option value={String(h.id)} selected={h.id === to}>
                {h.householdName}
              </option>
            ))}
          </select>
          <label for="recommend-note">
            Note <span class="muted">(optional)</span>
          </label>
          <textarea
            id="recommend-note"
            name="note"
            rows={2}
            maxlength={MAX_RECOMMEND_NOTE_CHARS}
            aria-invalid={errorFor('note') ? 'true' : undefined}
            aria-describedby={['recommend-hint', errorFor('note')].filter(Boolean).join(' ')}
          ></textarea>
          <p id="recommend-hint" class="muted">
            They see this {MEDIA_LABEL[item.mediaType].toLowerCase()} as your shared shelves show it, and your note, signed “{signedAs}”.
          </p>
          <button type="submit">Send recommendation</button>
        </form>
      ) : (
        <p class="muted">Recommended to every connected household.</p>
      )}
      <SentTo households={households} />
    </details>
  );
}

/** The households this item has already gone to, and whether any turned it away. */
const SentTo: FC<{ households: RecommendTarget[] }> = ({ households }) => {
  const sent = households.filter((h) => h.lastStatus && SENT_STATE[h.lastStatus]);
  return sent.length ? (
    <ul class="recommend-sent">
      {sent.map((h) => (
        <li>
          {h.householdName}
          <span class="muted"> · {SENT_STATE[h.lastStatus!]} </span>
          <span class="mono">{h.lastAt?.slice(0, 10)}</span>
        </li>
      ))}
    </ul>
  ) : null;
};

/**
 * Send one: checked against their descriptor first — a household that doesn't list `Recommend` in `accepts` is on 1.4.0
 * or older, which refuses a type it doesn't know, so nothing is queued for it — then stored and queued in one batch and
 * pushed at once, so the member learns what happened. A push that doesn't land waits in the outbox for their pull.
 */
recommendations.post('/items/:id/recommend', async (c) => {
  const ctx = await enabled(c);
  if (!ctx) return c.notFound();
  const item = await getItem(c.env.DB, Number(c.req.param('id')));
  if (!item) return c.notFound();
  const back = (code: keyof typeof OUTCOMES, to?: number) =>
    c.redirect(`/items/${item.id}?recommend=${code}${to ? `&to=${to}` : ''}#recommend`);

  const form = await c.req.parseBody();
  const connectionId = digits(form['connectionId']);
  const note = noteText(form['note']);
  const connection = connectionId ? await getConnection(c.env.DB, connectionId) : null;
  if (!connection || connection.status !== 'active') return back('household');
  if (note.length > MAX_RECOMMEND_NOTE_CHARS) return back('note', connection.id);
  const found = await recommendableItem(c.env.DB, item.id);
  if (!found) return back('unshared', connection.id);
  if ((await sentToday(c.env.DB, connection.id)) >= MAX_SENT_PER_DAY) return back('limit', connection.id);

  const descriptor = await fetchDescriptor(connection.baseUrl);
  if (!descriptor) return back('unreachable', connection.id);
  if (!peerAccepts(descriptor, 'Recommend')) return back('old', connection.id);

  const user = c.get('user');
  const message = recommend(
    ctx.settings.baseUrl,
    toRecommendedItem(found.item, await itemStamp(found.item), found.viewId),
    // a display name while names go to connections, else "A member" — never the username (§16 #45)
    await outwardName(c.env.DB, user.id),
    note || null,
  );
  const id = await recommendToConnection(
    c.env.DB,
    {
      activityId: message.id,
      connectionId: connection.id,
      ourItemId: item.id,
      senderId: user.id,
      mediaType: message.item.mediaType,
      title: message.item.title,
      creators: message.item.creators,
      published: message.item.published,
      coverKey: message.item.coverKey,
      identifiers: JSON.stringify(message.item.ids),
      recommender: message.recommender,
      note: message.note,
    },
    message,
  );
  if (id === null) return back('duplicate', connection.id);
  // A refusal takes it out of the outbox and marks it refused, together (dropRefused); nothing is retried after it.
  const status = await pushNow(c.env.DB, ctx.identity, ctx.settings, connection, message);
  if (status !== null && status >= 200 && status < 300) return back('sent', connection.id);
  if (status !== null && status >= 400 && status < 500 && status !== 429) return back('refused', connection.id);
  return back('queued', connection.id);
});

// ---------- the Recommended page ----------

const DONE: Record<string, { error: boolean; text: string }> = {
  dismissed: { error: false, text: 'Dismissed.' },
  wanted: { error: false, text: 'Added to your want list.' },
  shelf: { error: true, text: 'Choose a shelf for it first. Nothing was added.' },
  gone: { error: true, text: 'That recommendation isn’t waiting any more — someone here may have answered it already.' },
};

const SENT_PILL: Record<RecommendationStatus, [string, string]> = {
  open: ['pill done', 'Sent'],
  refused: ['pill dropped', 'Refused'],
  dismissed: ['pill ghost', 'Sent'], // never on a sent one: their answer stays with them
  wanted: ['pill ghost', 'Sent'],
};

recommendations.get('/recommendations', async (c) => {
  const ctx = await enabled(c);
  if (!ctx) return c.notFound();
  const [received, sent, shelves] = await Promise.all([
    openRecommendations(c.env.DB, RECOMMENDATIONS_SHOWN),
    sentRecommendations(c.env.DB, RECOMMENDATIONS_SHOWN),
    listLibraries(c.env.DB),
  ]);
  // opening the list pulls connections' outboxes too, after the response — where a recommendation that missed its push waits
  refreshInBackground(c, ctx.identity, ctx.settings, false);
  const code = c.req.query('done');
  const done = code && Object.hasOwn(DONE, code) ? DONE[code]! : null;
  const added = code === 'wanted' ? digits(c.req.query('item')) : null;

  return page(
    c,
    'Recommended to you',
    <>
      <div class="page-head">
        <div>
          <h1>Recommended to you</h1>
          <span class="sub">{received.length} FROM CONNECTED HOUSEHOLDS</span>
        </div>
      </div>
      {done ? (
        <p class={done.error ? 'error' : 'notice'} role={done.error ? 'alert' : 'status'}>
          {done.text}
          {added ? (
            <>
              {' '}
              <a href={`/items/${added}`}>Open it</a>
            </>
          ) : null}
        </p>
      ) : null}

      {received.length ? (
        <ol class="feed recommend-list">
          {received.map((r) => (
            <li class="feed-card" id={`recommendation-${r.id}`}>
              <div class="feed-cover">
                <TheirCover baseUrl={r.baseUrl} coverKey={r.coverKey} title={r.title} mediaType={r.mediaType} />
              </div>
              <div class="feed-body">
                <p class="eyebrow">{MEDIA_LABEL[r.mediaType]}</p>
                <p class="feed-line">
                  <strong>
                    <bdi>{r.title}</bdi>
                  </strong>
                  {r.creators ? (
                    <>
                      <br />
                      <small>
                        <bdi>{r.creators}</bdi>
                      </small>
                    </>
                  ) : null}
                </p>
                <p class="recommend-from">
                  From <bdi class="reviewer">{r.recommender}</bdi> at <bdi>{r.householdName}</bdi> ·{' '}
                  <span class="mono">{r.createdAt.slice(0, 10)}</span>
                </p>
                {r.note ? <p class="feed-review prewrap recommend-note">{r.note}</p> : null}
                <div class="recommend-actions">
                  {shelves.length ? (
                    <form method="post" action={`/recommendations/${r.id}/want`} class="inline-form">
                      {shelves.length > 1 ? (
                        <>
                          <label for={`want-shelf-${r.id}`} class="visually-hidden">
                            Shelf for {r.title}
                          </label>
                          <select id={`want-shelf-${r.id}`} name="libraryId">
                            {shelves.map((l) => (
                              <option value={String(l.id)}>{l.name}</option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <input type="hidden" name="libraryId" value={String(shelves[0]!.id)} />
                      )}
                      <button type="submit">
                        Add to my want list<span class="visually-hidden">: {r.title}</span>
                      </button>
                    </form>
                  ) : null}
                  <form method="post" action={`/recommendations/${r.id}/dismiss`} class="inline">
                    <button type="submit" class="btn">
                      Dismiss<span class="visually-hidden">: {r.title}</span>
                    </button>
                  </form>
                  {r.theirItemId && r.theirViewId ? (
                    <a href={`/households/${r.connectionId}/views/${r.theirViewId}/items/${r.theirItemId}`}>
                      On their shelf<span class="visually-hidden">: {r.title}</span>
                    </a>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p class="muted">Nothing waiting. When a connected household recommends something to you, it shows up here.</p>
      )}

      <section class="recommend-sent-section">
        <p class="eyebrow">Recommended from here</p>
        {sent.length ? (
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>To</th>
                  <th class="hide-sm">By</th>
                  <th class="hide-sm">Sent</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sent.map((r) => (
                  <tr>
                    <td>{r.ourItemId ? <a href={`/items/${r.ourItemId}`}>{r.title}</a> : r.title}</td>
                    <td>{r.householdName}</td>
                    <td class="hide-sm">{r.senderName ?? '—'}</td>
                    <td class="date hide-sm">{r.createdAt.slice(0, 10)}</td>
                    <td>
                      <span class={SENT_PILL[r.status][0]}>{SENT_PILL[r.status][1]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">Nothing yet. Open an item on a shelf you share with connections and choose “Recommend to…”.</p>
        )}
      </section>
      <p class="muted">
        Adding one puts it on your want list as a Not owned item — or, when it’s already in your catalog, puts that on your
        want list. What you do with a recommendation stays here: the household that sent it isn’t told whether you added
        it or dismissed it.
      </p>
    </>,
  );
});

/** Any member may dismiss one; it leaves the list for the whole household. */
recommendations.post('/recommendations/:id/dismiss', async (c) => {
  if (!(await enabled(c))) return c.notFound();
  const id = digits(c.req.param('id'));
  const moved = id ? await dismissRecommendation(c.env.DB, id, c.get('user').id) : false;
  return c.redirect(`/recommendations?done=${moved ? 'dismissed' : 'gone'}`);
});

/** The identifiers a recommendation kept, read back: only the known keys, each a whole id. */
function idsOf(json: string): RecommendIds {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  const ids: RecommendIds = {};
  if (!raw || typeof raw !== 'object') return ids;
  for (const key of RECOMMEND_ID_KEYS) {
    const id = recommendId((raw as Record<string, unknown>)[key]);
    if (id !== null) ids[key] = id;
  }
  return ids;
}

/**
 * Onto the signed-in member's own want list, as the Add page's Want does it (§16 #53): a copy already in the catalog —
 * a record by its Discogs id, a game by its BGG id (existingForWant), or the item this same one of theirs went onto
 * before — takes the want; otherwise it joins as a Not owned item made from what they sent, its cover copied from their
 * /covers/, with the want in its insert's batch. Either way the recommendation is claimed in that same batch, from open
 * only, so a second click or another member's makes no second item or want (§16 #39, #58).
 */
recommendations.post('/recommendations/:id/want', async (c) => {
  if (!(await enabled(c))) return c.notFound();
  const id = digits(c.req.param('id'));
  const rec = id ? await getRecommendation(c.env.DB, id) : null;
  if (!rec || !rec.incoming || rec.status !== 'open') return c.redirect('/recommendations?done=gone');
  const form = await c.req.parseBody();
  const libraryId = digits(form['libraryId']);
  const shelf = libraryId ? await getLibrary(c.env.DB, libraryId) : null;
  if (!shelf) return c.redirect('/recommendations?done=shelf');
  const user = c.get('user');
  const ids = idsOf(rec.identifiers);

  const existing = (await existingForWant(c.env.DB, { mediaType: rec.mediaType, details: ids })) ?? (await wantedBefore(c.env.DB, rec));
  if (existing !== null) {
    const taken = await wantRecommendedAs(c.env.DB, rec.id, user.id, existing);
    return c.redirect(taken ? `/recommendations?done=wanted&item=${existing}` : '/recommendations?done=gone');
  }

  const connection = await getConnection(c.env.DB, rec.connectionId);
  if (!connection) return c.redirect('/recommendations?done=gone');
  // only ever <their origin>/covers/<uuid> (coverUrl), fetched and kept here as any added item's cover is
  const coverKey = await storeCover(c.env.COVERS, coverUrl(connection.baseUrl, rec.coverKey));
  try {
    const itemId = await createItemWithTags(
      c.env.DB,
      {
        libraryId: shelf.id,
        mediaType: rec.mediaType,
        title: rec.title,
        creators: rec.creators,
        published: rec.published,
        coverKey,
        copies: 0, // Not owned, as a Want from a scan is
        details: JSON.stringify(ids),
        addedBy: user.id,
      },
      [],
      null,
      { wantedBy: user.id, before: claimRecommendation(c.env.DB, rec.id, user.id, null), after: [linkWantedItem(c.env.DB, rec.id)] },
    );
    return c.redirect(`/recommendations?done=wanted&item=${itemId}`);
  } catch (err) {
    c.executionCtx.waitUntil(deleteCover(c.env.COVERS, coverKey)); // nothing points at it
    // the claim failed the batch: someone answered it first
    if ((await getRecommendation(c.env.DB, rec.id))?.status !== 'open') return c.redirect('/recommendations?done=gone');
    throw err;
  }
});


export default recommendations;
