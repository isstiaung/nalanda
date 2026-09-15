// The Connections admin page (docs/proposals/connections.md §3, §5). Session-authenticated,
// admin-only, and 404 while connections are disabled — to a household without a federation key
// this route doesn't exist.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { FC } from 'hono/jsx';
import {
  activateConnection,
  countConnections,
  createConnection,
  createInvite,
  deleteConnection,
  getConnection,
  getConnectionByBaseUrl,
  getFederationSettings,
  listConnections,
  listInvites,
  revokeInvite,
  saveFederationSettings,
} from '../db/federation';
import type { Connection, ConnectionInvite, ConnectionStatus, FederationSettings } from '../db/schema';
import type { AppEnv } from '../env';
import { INVITE_TTL_DAYS, MAX_ACTIVE_CONNECTIONS, MAX_HOUSEHOLD_NAME } from '../federation/config';
import {
  fetchDescriptor,
  inviteLink,
  isHouseholdName,
  normaliseBaseUrl,
  parseInviteLink,
  postSigned,
} from '../federation/http';
import { loadIdentity, type Identity } from '../federation/keys';
import { connectRequest, inboxMessage, type InboxType } from '../federation/messages';
import { forgetPeer } from '../federation/peers';
import { hashToken, newInviteToken } from '../federation/tokens';
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
    <section style="margin-top:1.5rem">
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

      <section>
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
        <section style="margin-top:1.5rem">
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
        <section style="margin-top:1.5rem">
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
        actions={(row) => (
          <form
            method="post"
            action={`/connections/${row.id}/disconnect`}
            class="inline"
            onsubmit="return confirm('Disconnect from this library? You would need a new invitation to reconnect.')"
          >
            <button class="btn-danger" type="submit">
              Disconnect
            </button>
          </form>
        )}
      />
    </>
  );
};

async function render(c: Context<AppEnv>, flash: Flash = {}) {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return c.notFound(); // the gate already checked; kept for the type
  const [settings, invites, rows] = await Promise.all([
    getFederationSettings(c.env.DB),
    listInvites(c.env.DB),
    listConnections(c.env.DB),
  ]);
  return page(
    c,
    'Connections',
    <ConnectionsPage
      settings={settings}
      identity={identity}
      origin={new URL(c.req.url).origin}
      invites={invites.slice(0, 20)}
      connections={rows}
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
  // The address is part of this library's identity to its connections, so it stays fixed once anyone is connected.
  const baseUrl =
    existing && (await countConnections(c.env.DB)) > 0 ? existing.baseUrl : normaliseBaseUrl(new URL(c.req.url).origin);
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

function redeemFailure(status: number | undefined, name: string, ourAddress: string): string {
  switch (status) {
    case undefined:
      return `Couldn't reach ${name}. Nothing was saved — try again later.`;
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
  if (res?.status !== 202) {
    await deleteConnection(c.env.DB, pending.id);
    return render(c, { error: redeemFailure(res?.status, descriptor.name, settings.baseUrl) });
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
  if (!res || res.status < 200 || res.status >= 300) {
    return render(c, {
      error: `Couldn't reach ${row.householdName} to confirm. Nothing changed — try again when they're online.`,
    });
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

export default connections;
