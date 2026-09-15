// The Connections admin page (docs/proposals/connections.md §3, §5). Session-authenticated,
// admin-only, and 404 while connections are disabled — to a household without a federation key
// this route doesn't exist.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { FC } from 'hono/jsx';
import {
  activateConnection,
  applyLifecycle,
  countConnections,
  countConnectionViews,
  countItemsInView,
  countOpenInvites,
  createConnection,
  createConnectionView,
  createInvite,
  createSubscription,
  deleteConnection,
  deleteConnectionView,
  deleteSubscription,
  getConnection,
  getConnectionByBaseUrl,
  getFederationSettings,
  getSubscription,
  listConnections,
  listConnectionViews,
  listInvites,
  listSubscriptions,
  pruneOrphanThreads,
  purgeSubscription,
  revokeInvite,
  saveFederationSettings,
  storageByConnection,
  updateSubscription,
  type SubscriptionSettings,
  type SubscriptionWithUsage,
} from '../db/federation';
import { getLibrary, listLibraries } from '../db/queries';
import {
  ITEM_STATUSES,
  MEDIA_TYPES,
  type Connection,
  type ConnectionInvite,
  type ConnectionStatus,
  type ConnectionView,
  type FederationSettings,
  type ItemStatus,
  type Library,
  type MediaType,
} from '../db/schema';
import type { AppEnv } from '../env';
import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_PULL_INTERVAL,
  DEFAULT_RETENTION_DAYS,
  INVITE_TTL_DAYS,
  MAX_ACTIVE_CONNECTIONS,
  MAX_CONNECTION_VIEWS,
  MAX_HOUSEHOLD_NAME,
  MAX_RETENTION_DAYS,
  MAX_STORED_ENTRIES_PER_CONNECTION,
  MAX_VIEW_NAME,
  MIN_MAX_ENTRIES,
  PULL_INTERVALS,
  type PullInterval,
} from '../federation/config';
import { estimateBytes, fetchSharedViews, formatBytes, perMonth, type SharedView } from '../federation/feed';
import {
  fetchDescriptor,
  inviteLink,
  isHouseholdName,
  normaliseBaseUrl,
  parseInviteLink,
  postSigned,
} from '../federation/http';
import { isId } from '../federation/items';
import { loadIdentity, type Identity } from '../federation/keys';
import { connectRequest, inboxMessage, type InboxType } from '../federation/messages';
import { forgetPeer } from '../federation/peers';
import { clearSharedViewsCache } from '../federation/routes';
import { hashToken, newInviteToken } from '../federation/tokens';
import { MEDIA_LABEL, STATUS_LABEL } from '../views/components';
import { page } from '../views/layout';

const connections = new Hono<AppEnv>();

const gate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY))) return c.notFound();
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  await next();
};
connections.use('/connections', gate);
connections.use('/connections/*', gate);

// SQLite's datetime('now') format, in UTC, for comparing with stored timestamps
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function inviteState(invite: ConnectionInvite): 'Used' | 'Expired' | 'Unused' {
  if (invite.usedAt) return 'Used';
  return invite.expiresAt <= sqlNow() ? 'Expired' : 'Unused';
}

type Flash = { minted?: string; error?: string; notice?: string };

type PageProps = Flash & {
  settings: FederationSettings | null;
  identity: Identity;
  origin: string;
  invites: ConnectionInvite[];
  connections: Connection[];
  views: Array<ConnectionView & { itemCount: number }>;
  libraries: Library[];
  storage: Map<number, { entries: number; bytes: number }>;
};

// Peer household names come from the peer's own server. They are only ever rendered as text,
// which hono/jsx escapes — never inside an inline handler such as onsubmit="confirm('…')", where
// the browser decodes HTML escapes back into quotes before running the script.
const ConnectionTable: FC<{
  title: string;
  hint?: string;
  rows: Connection[];
  since: (row: Connection) => string;
  actions: (row: Connection) => unknown;
}> = ({ title, hint, rows, since, actions }) =>
  rows.length ? (
    <section class="fed-section" style="margin-top:1.5rem">
      <p class="eyebrow">{title}</p>
      {hint ? <p class="muted">{hint}</p> : null}
      <div class="data-table">
        <table>
          <thead>
            <tr>
              <th>Library</th>
              <th class="hide-sm">Address</th>
              <th class="hide-sm">Since</th>
              <th class="actions-cell"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr>
                <td>
                  <strong>{row.householdName}</strong>
                </td>
                <td class="hide-sm mono break-anywhere">{row.baseUrl}</td>
                <td class="date hide-sm">{since(row).slice(0, 10)}</td>
                <td class="actions-cell">{actions(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  ) : null;

/** "Books · Completed · Owned" — how a connection view's filters read. */
function scopeLabel(v: ConnectionView): string {
  const parts: string[] = [];
  if (v.mediaType) parts.push(MEDIA_LABEL[v.mediaType]);
  if (v.status) parts.push(STATUS_LABEL[v.status]);
  if (v.owned !== null) parts.push(v.owned ? 'Owned' : 'Not owned');
  return parts.length ? parts.join(' · ') : 'Everything';
}

const SharedViews: FC<{ views: PageProps['views']; libraries: Library[] }> = ({ views, libraries }) => {
  const shelfName = new Map(libraries.map((l) => [l.id, l.name]));
  return (
    <section class="fed-section" style="margin-top:1.5rem">
      <p class="eyebrow">Shared with connections</p>
      <p class="muted">
        Connected households see nothing until you share a view here, and every view is shared with every connection. For
        the books in it they see the title, creators, cover, rating, review and when you finished it — never notes, loans or
        how many copies you have.
      </p>
      {views.length ? (
        <div class="data-table">
          <table>
            <thead>
              <tr>
                <th>View</th>
                <th class="hide-sm">Shelf</th>
                <th>Scope</th>
                <th>Items</th>
                <th class="actions-cell"></th>
              </tr>
            </thead>
            <tbody>
              {views.map((v) => (
                <tr>
                  <td>
                    <strong>{v.name}</strong>
                  </td>
                  <td class="hide-sm">
                    {v.libraryId === null ? <span class="muted">All shelves</span> : (shelfName.get(v.libraryId) ?? '—')}
                  </td>
                  <td>
                    <span class="pill">{scopeLabel(v)}</span>
                  </td>
                  <td class="num">{v.itemCount}</td>
                  <td class="actions-cell">
                    <form method="post" action={`/connections/views/${v.id}/delete`} class="inline">
                      <button class="btn-danger" type="submit">
                        Stop sharing
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {views.length < MAX_CONNECTION_VIEWS ? (
        <form method="post" action="/connections/views" class="inline-form view-form">
          <input name="name" placeholder="View name, e.g. Finished this year" maxlength={MAX_VIEW_NAME} aria-label="View name" required />
          <select name="libraryId" aria-label="Shelf">
            <option value="">All shelves</option>
            {libraries.map((l) => (
              <option value={String(l.id)}>{l.name}</option>
            ))}
          </select>
          <select name="mediaType" aria-label="Type">
            <option value="">Any type</option>
            {MEDIA_TYPES.map((t) => (
              <option value={t}>{MEDIA_LABEL[t]}</option>
            ))}
          </select>
          <select name="status" aria-label="Status">
            <option value="">Any status</option>
            {ITEM_STATUSES.map((st) => (
              <option value={st}>{STATUS_LABEL[st]}</option>
            ))}
          </select>
          <select name="owned" aria-label="Holding">
            <option value="">Owned or not</option>
            <option value="1">Owned</option>
            <option value="0">Not owned</option>
          </select>
          <button type="submit">Share view</button>
        </form>
      ) : (
        <p class="muted">You’re sharing the most views allowed ({MAX_CONNECTION_VIEWS}).</p>
      )}
    </section>
  );
};

const ConnectionsPage: FC<PageProps> = (p) => {
  const having = (status: ConnectionStatus) => p.connections.filter((row) => row.status === status);
  const active = having('active');
  const awaitingUs = having('awaiting_us');
  const awaitingThem = having('awaiting_them');
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Connections</h1>
          <span class="sub">
            {active.length} CONNECTED · {awaitingUs.length + awaitingThem.length} WAITING
          </span>
        </div>
      </div>
      {p.error ? <p class="error">{p.error}</p> : null}
      {p.notice ? <article class="notice">{p.notice}</article> : null}

      <section class="fed-section">
        <p class="eyebrow">This library</p>
        {p.settings ? null : (
          <p class="muted">
            Name your library before connecting. Households you connect with see this name and this address.
          </p>
        )}
        <form method="post" action="/connections/settings" class="inline-form">
          <input
            name="householdName"
            value={p.settings?.householdName ?? ''}
            placeholder="e.g. The Hillside library"
            maxlength={MAX_HOUSEHOLD_NAME}
            aria-label="Library name"
            required
          />
          <button type="submit" class="btn">
            Save
          </button>
        </form>
        <p class="muted">
          Address: <span class="mono break-anywhere">{p.settings?.baseUrl ?? p.origin}</span>
          <br />
          Key fingerprint: <span class="mono">{p.identity.fingerprint}</span>
        </p>
        {p.settings && p.settings.baseUrl !== p.origin ? (
          <p class="muted">
            You're viewing this page at {p.origin}. Connected households know this library as {p.settings.baseUrl}.
          </p>
        ) : null}
      </section>

      {p.settings ? (
        <section class="fed-section" style="margin-top:1.5rem">
          <p class="eyebrow">Invite a household</p>
          {p.minted ? (
            <article class="notice">
              <strong>Invitation link — shown once.</strong>
              <br />
              <code class="break-anywhere">{p.minted}</code>
              <br />
              <small class="muted">
                Send it privately. It works once, within {INVITE_TTL_DAYS} days, and the connection still waits for you
                to confirm it here.
              </small>
            </article>
          ) : null}
          <form method="post" action="/connections/invites" class="inline-form">
            <button type="submit">Create an invitation</button>
          </form>
          {p.invites.length ? (
            <div class="data-table">
              <table>
                <thead>
                  <tr>
                    <th>Created</th>
                    <th>Expires</th>
                    <th>State</th>
                    <th class="actions-cell"></th>
                  </tr>
                </thead>
                <tbody>
                  {p.invites.map((invite) => {
                    const state = inviteState(invite);
                    return (
                      <tr>
                        <td class="date">{invite.createdAt.slice(0, 10)}</td>
                        <td class="date">{invite.expiresAt.slice(0, 10)}</td>
                        <td>{state}</td>
                        <td class="actions-cell">
                          {state === 'Unused' ? (
                            <form method="post" action={`/connections/invites/${invite.id}/revoke`} class="inline">
                              <button class="btn" type="submit">
                                Revoke
                              </button>
                            </form>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {p.settings ? (
        <section class="fed-section" style="margin-top:1.5rem">
          <p class="eyebrow">Accept an invitation</p>
          <form method="post" action="/connections/redeem" class="inline-form">
            <input name="link" placeholder="https://…/connect#…" aria-label="Invitation link" required />
            <button type="submit">Connect</button>
          </form>
          <p class="muted">Paste a link another household sent you. They confirm on their side before you're connected.</p>
        </section>
      ) : null}

      <ConnectionTable
        title="Waiting for your confirmation"
        hint="Check each address is a household you actually invited."
        rows={awaitingUs}
        since={(row) => row.createdAt}
        actions={(row) => (
          <>
            <form method="post" action={`/connections/${row.id}/confirm`} class="inline">
              <button type="submit">Confirm</button>
            </form>{' '}
            <form method="post" action={`/connections/${row.id}/decline`} class="inline">
              <button class="btn-danger" type="submit">
                Decline
              </button>
            </form>
          </>
        )}
      />
      <ConnectionTable
        title="Waiting for them"
        rows={awaitingThem}
        since={(row) => row.createdAt}
        actions={(row) => (
          <form method="post" action={`/connections/${row.id}/disconnect`} class="inline">
            <button class="btn" type="submit">
              Cancel
            </button>
          </form>
        )}
      />
      <ConnectionTable
        title="Connected"
        rows={active}
        since={(row) => row.confirmedAt ?? row.createdAt}
        actions={(row) => {
          const usage = p.storage.get(row.id);
          return (
            <>
              {usage && usage.entries > 0 ? (
                <small class="muted">
                  {usage.entries} stored · {formatBytes(usage.bytes)}{' '}
                </small>
              ) : null}
              <a class="btn" href={`/connections/${row.id}/feed`}>
                Feed
              </a>{' '}
              <form
                method="post"
                action={`/connections/${row.id}/disconnect`}
                class="inline"
                onsubmit="return confirm('Disconnect from this library? Everything stored from them is deleted, and you would need a new invitation to reconnect.')"
              >
                <button class="btn-danger" type="submit">
                  Disconnect
                </button>
              </form>
            </>
          );
        }}
      />
      {p.settings ? <SharedViews views={p.views} libraries={p.libraries} /> : null}
    </>
  );
};

async function render(c: Context<AppEnv>, flash: Flash = {}) {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return c.notFound(); // the gate already checked; kept for the type
  const [settings, invites, rows, views, libraries, storage] = await Promise.all([
    getFederationSettings(c.env.DB),
    listInvites(c.env.DB),
    listConnections(c.env.DB),
    listConnectionViews(c.env.DB),
    listLibraries(c.env.DB),
    storageByConnection(c.env.DB),
  ]);
  const counts = await Promise.all(views.map((v) => countItemsInView(c.env.DB, v)));
  return page(
    c,
    'Connections',
    <ConnectionsPage
      settings={settings}
      identity={identity}
      origin={new URL(c.req.url).origin}
      invites={invites.slice(0, 20)}
      connections={rows}
      views={views.map((v, i) => ({ ...v, itemCount: counts[i] ?? 0 }))}
      libraries={libraries}
      storage={storage}
      {...flash}
    />,
  );
}

/** Best-effort notice to a peer after we've already acted locally — sent after the response. */
function notifyPeer(c: Context<AppEnv>, identity: Identity, settings: FederationSettings, peer: Connection, type: InboxType) {
  c.executionCtx.waitUntil(
    postSigned(identity, settings.baseUrl, peer.baseUrl, '/federation/inbox', inboxMessage(type, settings.baseUrl)).then(
      () => undefined,
      () => undefined,
    ),
  );
}

connections.get('/connections', (c) => render(c));

connections.post('/connections/settings', async (c) => {
  const body = await c.req.parseBody();
  const householdName = String(body['householdName'] ?? '').trim();
  if (!isHouseholdName(householdName)) {
    return render(c, { error: `Give your library a name of up to ${MAX_HOUSEHOLD_NAME} characters.` });
  }
  const existing = await getFederationSettings(c.env.DB);
  // The address is part of this library's identity: it stays fixed once anyone is connected or waiting, and
  // while an unused invitation names it — changing it then would break every link already sent.
  const fixed =
    existing && ((await countConnections(c.env.DB)) > 0 || (await countOpenInvites(c.env.DB)) > 0);
  const baseUrl = fixed ? existing.baseUrl : normaliseBaseUrl(new URL(c.req.url).origin);
  if (!baseUrl) return render(c, { error: 'Connections need this library to be served over https.' });
  await saveFederationSettings(c.env.DB, { householdName, baseUrl });
  return c.redirect('/connections');
});

connections.post('/connections/invites', async (c) => {
  const settings = await getFederationSettings(c.env.DB);
  if (!settings) return render(c, { error: 'Name your library before inviting anyone.' });
  const token = newInviteToken();
  await createInvite(c.env.DB, {
    tokenHash: await hashToken(token),
    createdBy: c.get('user').id,
    ttlDays: INVITE_TTL_DAYS,
  });
  // Rendered, not redirected: the link is shown this once and never stored.
  return render(c, { minted: inviteLink(settings.baseUrl, token) });
});

connections.post('/connections/invites/:id/revoke', async (c) => {
  await revokeInvite(c.env.DB, Number(c.req.param('id')));
  return c.redirect('/connections');
});

function redeemFailure(status: number, name: string, ourAddress: string): string {
  switch (status) {
    case 404:
      return 'That invitation has already been used, has expired, or was revoked. Ask for a new one.';
    case 409:
      return `${name} already has a connection with this library, or has reached its connection limit.`;
    case 422:
      return `${name} couldn't confirm this library's address. Connections need it to be reachable at ${ourAddress}.`;
    default:
      return `${name} didn't accept the request (HTTP ${status}). Nothing was saved.`;
  }
}

connections.post('/connections/redeem', async (c) => {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  const settings = await getFederationSettings(c.env.DB);
  if (!identity || !settings) return render(c, { error: 'Name your library before connecting.' });
  const body = await c.req.parseBody();
  const invite = parseInviteLink(String(body['link'] ?? ''));
  if (!invite) {
    return render(c, { error: "That isn't a Nalanda invitation link. It should end in /connect# followed by a long code." });
  }
  if (invite.baseUrl === settings.baseUrl) {
    return render(c, { error: 'That invitation is from this library. Send it to the other household instead.' });
  }
  if (await getConnectionByBaseUrl(c.env.DB, invite.baseUrl)) {
    return render(c, { error: 'You already have a connection, or a request waiting, with that library.' });
  }
  if ((await countConnections(c.env.DB)) >= MAX_ACTIVE_CONNECTIONS) {
    return render(c, { error: `This library has reached its limit of ${MAX_ACTIVE_CONNECTIONS} connections.` });
  }

  const descriptor = await fetchDescriptor(invite.baseUrl);
  if (!descriptor) {
    return render(c, { error: `Couldn't reach a Nalanda library that accepts connections at ${invite.baseUrl}.` });
  }

  // Recorded before sending: their confirmation arrives signed with their key, so we must know it first.
  const pending = await createConnection(c.env.DB, {
    baseUrl: invite.baseUrl,
    householdName: descriptor.name,
    publicKey: JSON.stringify(descriptor.publicKey),
    status: 'awaiting_them',
  });
  const res = await postSigned(
    identity,
    settings.baseUrl,
    invite.baseUrl,
    '/federation/connect',
    connectRequest(settings.baseUrl, settings.householdName, identity.publicJwk, invite.token),
  );
  if (!res) {
    // No answer isn't a refusal: a slow reply may still have been recorded on their side, so keep ours.
    return render(c, {
      notice: `No answer from ${descriptor.name} yet. The request may still have reached them, so it’s listed under Waiting for them — cancel it there if they don’t confirm.`,
    });
  }
  if (res.status !== 202) {
    await deleteConnection(c.env.DB, pending.id);
    return render(c, { error: redeemFailure(res.status, descriptor.name, settings.baseUrl) });
  }
  return render(c, { notice: `Request sent. It becomes a connection once ${descriptor.name} confirms it.` });
});

connections.post('/connections/:id/confirm', async (c) => {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  const settings = await getFederationSettings(c.env.DB);
  const row = await getConnection(c.env.DB, Number(c.req.param('id')));
  if (!identity || !settings || !row || row.status !== 'awaiting_us') return c.redirect('/connections');
  const res = await postSigned(
    identity,
    settings.baseUrl,
    row.baseUrl,
    '/federation/inbox',
    inboxMessage('ConnectAccept', settings.baseUrl),
  );
  if (!res) {
    // Unknown outcome: the confirmation may have arrived. Confirming again is safe — they accept a repeat.
    return render(c, {
      error: `No answer from ${row.householdName}. Try Confirm again: if the first confirmation did reach them, the second completes it.`,
    });
  }
  if (res.status < 200 || res.status >= 300) {
    return render(c, { error: `${row.householdName} didn’t accept the confirmation (HTTP ${res.status}). Nothing changed.` });
  }
  await activateConnection(c.env.DB, row.id, 'awaiting_us');
  forgetPeer(row.baseUrl);
  return c.redirect('/connections');
});

connections.post('/connections/:id/decline', async (c) => {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  const settings = await getFederationSettings(c.env.DB);
  const row = await getConnection(c.env.DB, Number(c.req.param('id')));
  if (!row || row.status !== 'awaiting_us') return c.redirect('/connections');
  await deleteConnection(c.env.DB, row.id);
  forgetPeer(row.baseUrl);
  if (identity && settings) notifyPeer(c, identity, settings, row, 'ConnectDecline');
  return c.redirect('/connections');
});

// Also cancels a request we sent that they haven't confirmed yet.
connections.post('/connections/:id/disconnect', async (c) => {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  const settings = await getFederationSettings(c.env.DB);
  const row = await getConnection(c.env.DB, Number(c.req.param('id')));
  if (!row) return c.redirect('/connections');
  await deleteConnection(c.env.DB, row.id);
  forgetPeer(row.baseUrl);
  if (identity && settings) notifyPeer(c, identity, settings, row, 'Disconnect');
  return c.redirect('/connections');
});

// ---------- sharing views with connections (phase 2) ----------

connections.post('/connections/views', async (c) => {
  if (!(await getFederationSettings(c.env.DB))) return render(c, { error: 'Name your library before sharing anything.' });
  const body = await c.req.parseBody();
  const str = (k: string) => {
    const v = body[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const name = str('name');
  if (!name || name.length > MAX_VIEW_NAME) {
    return render(c, { error: `Give the view a name of up to ${MAX_VIEW_NAME} characters.` });
  }
  let libraryId: number | null = null;
  if (str('libraryId')) {
    const lib = /^\d+$/.test(str('libraryId')) ? await getLibrary(c.env.DB, Number(str('libraryId'))) : null;
    if (!lib) return render(c, { error: 'That shelf no longer exists.' });
    libraryId = lib.id;
  }
  if ((await countConnectionViews(c.env.DB)) >= MAX_CONNECTION_VIEWS) {
    return render(c, { error: `You can share up to ${MAX_CONNECTION_VIEWS} views.` });
  }
  await createConnectionView(c.env.DB, {
    name,
    libraryId,
    mediaType: (MEDIA_TYPES as readonly string[]).includes(str('mediaType')) ? (str('mediaType') as MediaType) : null,
    status: (ITEM_STATUSES as readonly string[]).includes(str('status')) ? (str('status') as ItemStatus) : null,
    owned: str('owned') === '1' ? true : str('owned') === '0' ? false : null,
  });
  clearSharedViewsCache();
  return c.redirect('/connections');
});

connections.post('/connections/views/:id/delete', async (c) => {
  await deleteConnectionView(c.env.DB, Number(c.req.param('id')));
  clearSharedViewsCache();
  return c.redirect('/connections');
});

// ---------- following a connection's views (phase 2) ----------

const INTERVAL_LABEL: Record<PullInterval, string> = { 15: 'every 15 minutes', 60: 'hourly', 1440: 'daily' };

const SettingsFields: FC<{ interval: number; days: number; entries: number }> = ({ interval, days, entries }) => (
  <>
    <label>
      Pull
      <select name="intervalMinutes" aria-label="Pull at most">
        {PULL_INTERVALS.map((m) => (
          <option value={String(m)} selected={m === interval}>
            {INTERVAL_LABEL[m]}
          </option>
        ))}
      </select>
    </label>
    <label>
      keep
      <input type="number" name="retentionDays" min="1" max={String(MAX_RETENTION_DAYS)} value={String(days)} aria-label="Days to keep" />
      days,
    </label>
    <label>
      up to
      <input
        type="number"
        name="maxEntries"
        min={String(MIN_MAX_ENTRIES)}
        max={String(MAX_STORED_ENTRIES_PER_CONNECTION)}
        value={String(entries)}
        aria-label="Entries to keep"
      />
      entries
    </label>
  </>
);

type FeedFlash = { error?: string; notice?: string };

const ConnectionFeedPage: FC<
  { connection: Connection; subscriptions: SubscriptionWithUsage[]; theirViews: SharedView[] | null } & FeedFlash
> = (p) => {
  const used = p.subscriptions.reduce((sum, sub) => ({ entries: sum.entries + sub.entries, bytes: sum.bytes + sub.bytes }), {
    entries: 0,
    bytes: 0,
  });
  // A withdrawn view doesn't count as followed: a new view under that id can be followed again.
  const followed = new Set(p.subscriptions.filter((sub) => !sub.goneAt).map((sub) => sub.viewId));
  const base = `/connections/${p.connection.id}`;
  return (
    <>
      <div class="page-head">
        <div>
          <h1>{p.connection.householdName}</h1>
          <span class="sub">
            FEED · {used.entries} {used.entries === 1 ? 'ENTRY' : 'ENTRIES'} · {formatBytes(used.bytes).toUpperCase()} STORED
          </span>
        </div>
      </div>
      {p.error ? <p class="error">{p.error}</p> : null}
      {p.notice ? <article class="notice">{p.notice}</article> : null}

      <section class="fed-section">
        <p class="eyebrow">Following</p>
        {p.subscriptions.length === 0 ? (
          <p class="muted">You don’t follow any of their views yet.</p>
        ) : (
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>View</th>
                  <th>Settings</th>
                  <th>Stored</th>
                  <th class="hide-sm">Last pulled</th>
                  <th class="actions-cell"></th>
                </tr>
              </thead>
              <tbody>
                {p.subscriptions.map((sub) => (
                  <tr>
                    <td>
                      <strong>{sub.viewName}</strong>
                      {sub.goneAt ? (
                        <>
                          <br />
                          <span class="pill ghost">No longer shared</span>
                        </>
                      ) : null}
                      {sub.lastError ? (
                        <>
                          <br />
                          <small class="muted">{sub.lastError}</small>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <form method="post" action={`${base}/subscriptions/${sub.id}`} class="sub-settings">
                        <SettingsFields interval={sub.intervalMinutes} days={sub.retentionDays} entries={sub.maxEntries} />
                        <button class="btn" type="submit">
                          Save
                        </button>
                      </form>
                    </td>
                    <td class="num">
                      {sub.entries}
                      <br />
                      <small class="muted">{formatBytes(sub.bytes)}</small>
                    </td>
                    <td class="date hide-sm">{sub.lastPulledAt ? sub.lastPulledAt.slice(0, 16) : 'Not yet'}</td>
                    <td class="actions-cell">
                      <form method="post" action={`${base}/subscriptions/${sub.id}/purge`} class="inline">
                        <button class="btn" type="submit">
                          Purge
                        </button>
                      </form>{' '}
                      <form method="post" action={`${base}/subscriptions/${sub.id}/unfollow`} class="inline">
                        <button class="btn-danger" type="submit">
                          Unfollow
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p class="muted">
          Each pull deletes entries older than the days you keep, and all but the newest entries you keep. Anything they stop
          sharing is deleted too, whatever these settings say. A connection never uses more than{' '}
          {MAX_STORED_ENTRIES_PER_CONNECTION.toLocaleString('en')} entries. The Feed page pulls when someone opens it.
        </p>
      </section>

      <section class="fed-section">
        <p class="eyebrow">Views they share</p>
        {p.theirViews === null ? (
          <p class="muted">Couldn’t reach {p.connection.householdName} just now. Try again later.</p>
        ) : p.theirViews.length === 0 ? (
          <p class="muted">{p.connection.householdName} isn’t sharing any views yet.</p>
        ) : (
          <div class="data-table">
            <table>
              <thead>
                <tr>
                  <th>View</th>
                  <th>Items</th>
                  <th class="hide-sm">A month</th>
                  <th>Follow</th>
                </tr>
              </thead>
              <tbody>
                {p.theirViews.map((v) => (
                  <tr>
                    <td>
                      <strong>{v.name}</strong>
                    </td>
                    <td class="num">{v.itemCount}</td>
                    <td class="num hide-sm">
                      ≈ {perMonth(v.recent, 'activities')} entries
                      <br />
                      <small class="muted">≈ {formatBytes(perMonth(v.recent, 'bytes'))}</small>
                    </td>
                    <td>
                      {followed.has(v.id) ? (
                        <span class="pill done">Following</span>
                      ) : (
                        <form method="post" action={`${base}/subscriptions`} class="sub-settings">
                          <input type="hidden" name="viewId" value={String(v.id)} />
                          <SettingsFields
                            interval={DEFAULT_PULL_INTERVAL}
                            days={DEFAULT_RETENTION_DAYS}
                            entries={DEFAULT_MAX_ENTRIES}
                          />
                          <button type="submit">Follow</button>
                          <small class="muted">
                            ≈ {formatBytes(estimateBytes(v.recent, DEFAULT_RETENTION_DAYS, DEFAULT_MAX_ENTRIES))} kept at{' '}
                            {DEFAULT_RETENTION_DAYS} days and {DEFAULT_MAX_ENTRIES} entries
                          </small>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p>
        <a href="/connections">← Connections</a>
      </p>
    </>
  );
};

type ActiveContext = { identity: Identity; settings: FederationSettings; row: Connection };

async function activeConnection(c: Context<AppEnv>): Promise<ActiveContext | null> {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  const settings = await getFederationSettings(c.env.DB);
  const row = await getConnection(c.env.DB, Number(c.req.param('id')));
  return identity && settings && row?.status === 'active' ? { identity, settings, row } : null;
}

/** `fetched` passes views already fetched in this request, so an error render doesn't fetch them twice. */
async function renderFeedSettings(c: Context<AppEnv>, ctx: ActiveContext, flash: FeedFlash = {}, fetched?: SharedView[] | null) {
  const [subscriptions, theirViews] = await Promise.all([
    listSubscriptions(c.env.DB, ctx.row.id),
    fetched !== undefined ? fetched : fetchSharedViews(ctx.identity, ctx.settings, ctx.row),
  ]);
  return page(
    c,
    `Feed · ${ctx.row.householdName}`,
    <ConnectionFeedPage connection={ctx.row} subscriptions={subscriptions} theirViews={theirViews} {...flash} />,
  );
}

const SETTINGS_ERROR = `Pull every 15 minutes, hourly or daily, and keep entries for 1–${MAX_RETENTION_DAYS} days and ${MIN_MAX_ENTRIES}–${MAX_STORED_ENTRIES_PER_CONNECTION.toLocaleString('en')} entries.`;

function parseSettings(body: Record<string, unknown>): SubscriptionSettings | null {
  const read = (k: string) => (typeof body[k] === 'string' && /^\d{1,6}$/.test(body[k] as string) ? Number(body[k]) : NaN);
  const intervalMinutes = read('intervalMinutes');
  const retentionDays = read('retentionDays');
  const maxEntries = read('maxEntries');
  if (!(PULL_INTERVALS as readonly number[]).includes(intervalMinutes)) return null;
  if (!(retentionDays >= 1 && retentionDays <= MAX_RETENTION_DAYS)) return null;
  if (!(maxEntries >= MIN_MAX_ENTRIES && maxEntries <= MAX_STORED_ENTRIES_PER_CONNECTION)) return null;
  return { intervalMinutes, retentionDays, maxEntries };
}

connections.get('/connections/:id/feed', async (c) => {
  const ctx = await activeConnection(c);
  return ctx ? renderFeedSettings(c, ctx) : c.redirect('/connections');
});

connections.post('/connections/:id/subscriptions', async (c) => {
  const ctx = await activeConnection(c);
  if (!ctx) return c.redirect('/connections');
  const body = await c.req.parseBody();
  const settings = parseSettings(body);
  const viewId = typeof body['viewId'] === 'string' && /^\d{1,15}$/.test(body['viewId']) ? Number(body['viewId']) : 0;
  if (!settings || !isId(viewId)) return renderFeedSettings(c, ctx, { error: SETTINGS_ERROR });
  // Their current list, not the form's word for it: the view must still exist, and its name comes from them.
  const theirViews = await fetchSharedViews(ctx.identity, ctx.settings, ctx.row);
  if (!theirViews) {
    return renderFeedSettings(c, ctx, { error: `Couldn’t reach ${ctx.row.householdName} to follow that view. Nothing changed.` }, null);
  }
  const view = theirViews.find((v) => v.id === viewId);
  if (!view) return renderFeedSettings(c, ctx, { error: 'They no longer share that view.' }, theirViews);
  const created = await createSubscription(c.env.DB, { connectionId: ctx.row.id, viewId, viewName: view.name, ...settings });
  if (!created) return renderFeedSettings(c, ctx, { error: 'You already follow that view.' }, theirViews);
  return c.redirect(`/connections/${ctx.row.id}/feed`);
});

connections.post('/connections/:id/subscriptions/:sid', async (c) => {
  const ctx = await activeConnection(c);
  if (!ctx) return c.redirect('/connections');
  const sub = await getSubscription(c.env.DB, ctx.row.id, Number(c.req.param('sid')));
  if (!sub) return c.redirect(`/connections/${ctx.row.id}/feed`);
  const settings = parseSettings(await c.req.parseBody());
  if (!settings) return renderFeedSettings(c, ctx, { error: SETTINGS_ERROR });
  await updateSubscription(c.env.DB, sub.id, settings);
  await applyLifecycle(c.env.DB, { ...sub, ...settings }); // tighter limits free the space now, not at the next pull
  return c.redirect(`/connections/${ctx.row.id}/feed`);
});

connections.post('/connections/:id/subscriptions/:sid/purge', async (c) => {
  const ctx = await activeConnection(c);
  if (!ctx) return c.redirect('/connections');
  const sub = await getSubscription(c.env.DB, ctx.row.id, Number(c.req.param('sid')));
  if (sub) {
    await purgeSubscription(c.env.DB, sub.id);
    await pruneOrphanThreads(c.env.DB);
  }
  return c.redirect(`/connections/${ctx.row.id}/feed`);
});

connections.post('/connections/:id/subscriptions/:sid/unfollow', async (c) => {
  const ctx = await activeConnection(c);
  if (!ctx) return c.redirect('/connections');
  const sub = await getSubscription(c.env.DB, ctx.row.id, Number(c.req.param('sid')));
  if (sub) {
    await deleteSubscription(c.env.DB, sub.id);
    await pruneOrphanThreads(c.env.DB);
  }
  return c.redirect(`/connections/${ctx.row.id}/feed`);
});

export default connections;
