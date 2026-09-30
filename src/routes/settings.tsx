import { Hono } from 'hono';
import type { User } from '../db/schema';
import { createUser, deleteUser, getSiteSettings, getUserById, listUsers, setDisplayName, setPassword, updateSiteSettings } from '../db/queries';
import type { AppEnv } from '../env';
import { hashPassword, tempPassword } from '../lib/auth';
import { currencyCodes, currencyName, isCurrencyCode } from '../lib/money';
import { MAX_DISPLAY_NAME, normalizeDisplayName } from '../lib/names';
import { page } from '../views/layout';

const settings = new Hono<AppEnv>();

settings.use('/settings/*', async (c, next) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  await next();
});

/**
 * The household's currency (§16 #61): one select of every code the runtime knows, named. Once set it can be changed,
 * never cleared; prices already entered keep the currency they were entered in.
 */
const CurrencySection = ({ currency, error }: { currency: string | null; error?: string }) => (
  <section class="settings-section" id="currency" aria-labelledby="currency-head">
    <p class="eyebrow" id="currency-head">
      Household currency
    </p>
    <form method="post" action="/settings/currency" class="inline-form">
      <label for="household-currency">Purchase prices are entered in</label>
      <select
        id="household-currency"
        name="currency"
        required
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? 'currency-error currency-help' : 'currency-help'}
      >
        {currency ? null : (
          <option value="" selected>
            Choose a currency…
          </option>
        )}
        {currencyCodes().map((code) => (
          <option value={code} selected={code === currency}>
            {code} — {currencyName(code)}
          </option>
        ))}
      </select>
      <button type="submit">Save</button>
    </form>
    {error ? (
      <p class="field-error" id="currency-error">
        {error}
      </p>
    ) : null}
    <p class="muted" id="currency-help">
      {currency ? (
        <>
          Now <strong class="mono">{currency}</strong>.{' '}
        </>
      ) : (
        'Not set yet: members can’t record what they paid until it is. '
      )}
      One currency for the household, for what everyone paid for books, games and records. Changing it later leaves
      prices already entered in the currency they were entered in, and shelf totals add up each currency separately —
      nothing is converted. Prices stay in the app: never on share pages or to connected households.
    </p>
  </section>
);

const UsersPage = ({
  users,
  self,
  minted,
  error,
  currency,
  currencyError,
}: {
  users: User[];
  self: number;
  minted?: { username: string; password: string };
  error?: string;
  currency: string | null;
  currencyError?: string;
}) => (
  <>
    <div class="page-head">
      <div>
        <h1>Members</h1>
        <span class="sub">
          {users.length} {users.length === 1 ? 'ACCOUNT' : 'ACCOUNTS'}
        </span>
      </div>
    </div>
    {error ? <p class="error" role="alert">{error}</p> : null}
    {minted ? (
      <article class="notice">
        <strong>Temporary password for “{minted.username}”:</strong> <code>{minted.password}</code>
        <br />
        <small class="muted">
          Shown once — share it now. They'll set their own password at first login.
        </small>
      </article>
    ) : null}
    <div class="data-table">
      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Display name</th>
            <th>Role</th>
            <th class="hide-sm">Since</th>
            <th class="actions-cell"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr>
              <td>
                <strong>{u.username}</strong>
                {u.id === self ? <small class="muted"> (you)</small> : null}
                {u.mustChangePassword ? (
                  <>
                    {' '}
                    <span class="pill progress">Temp password</span>
                  </>
                ) : null}
              </td>
              <td>
                {/* shown outside the app only where names are switched on (§16 #45); an admin can set anyone's */}
                <form method="post" action={`/settings/users/${u.id}/display-name`} class="inline-form display-name-form">
                  <input
                    name="displayName"
                    value={u.displayName ?? ''}
                    maxlength={MAX_DISPLAY_NAME}
                    placeholder="none"
                    aria-label={`Display name for ${u.username}`}
                  />
                  <button type="submit" class="btn">
                    Save
                  </button>
                </form>
              </td>
              <td class="num">{u.role}</td>
              <td class="date hide-sm">{u.createdAt.slice(0, 10)}</td>
              <td class="actions-cell">
                <form method="post" action={`/settings/users/${u.id}/reset`} class="inline">
                  <button class="btn" type="submit">
                    Reset password
                  </button>
                </form>{' '}
                {u.id !== self ? (
                  <form
                    method="post"
                    action={`/settings/users/${u.id}/delete`}
                    class="inline"
                    data-confirm={`Remove ${u.username}? They will be logged out immediately. Their reads and reviews stay, credited to a former member. Their want list goes, with any gift list published of it.`}
                  >
                    <button class="btn-danger" type="submit">
                      Remove
                    </button>
                  </form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <section class="settings-section">
      <p class="eyebrow">Add a member</p>
      <form method="post" action="/settings/users" class="inline-form">
        <input name="username" placeholder="username" aria-label="Username" required />
        <select name="role" aria-label="Role">
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit">Create account</button>
      </form>
      <p class="muted">
        No email needed: you get a one-time temporary password to hand over; they set their own at first login.
      </p>
      <p class="muted">
        A <strong>display name</strong> is how a member is signed outside this library — on share pages and to connected
        households — and only once names are switched on under Shared links or Connections. Empty means unnamed.
        Usernames never leave the app.
      </p>
    </section>

    <CurrencySection currency={currency} error={currencyError} />
  </>
);

settings.get('/settings/users', async (c) => {
  const [users, site] = await Promise.all([listUsers(c.env.DB), getSiteSettings(c.env.DB)]);
  return page(c, 'Members', <UsersPage users={users} self={c.get('user').id} currency={site.currency} />);
});

/** Sets the household's currency (§16 #61). Admins only, like everything under /settings. */
settings.post('/settings/currency', async (c) => {
  const body = await c.req.parseBody();
  const code = typeof body['currency'] === 'string' ? body['currency'].trim() : '';
  if (!isCurrencyCode(code)) {
    const [users, site] = await Promise.all([listUsers(c.env.DB), getSiteSettings(c.env.DB)]);
    c.status(400);
    // a fixed message: never the value sent, which a crafted form could fill with anything
    return page(c, 'Members', (
      <UsersPage users={users} self={c.get('user').id} currency={site.currency} currencyError="Choose a currency from the list." />
    ));
  }
  await updateSiteSettings(c.env.DB, { currency: code });
  return c.redirect('/settings/users#currency');
});

settings.post('/settings/users', async (c) => {
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const role = body['role'] === 'admin' ? 'admin' : 'member';
  const render = async (opts: { minted?: { username: string; password: string }; error?: string }) => {
    const [users, site] = await Promise.all([listUsers(c.env.DB), getSiteSettings(c.env.DB)]);
    return page(c, 'Members', (
      <UsersPage users={users} self={c.get('user').id} minted={opts.minted} error={opts.error} currency={site.currency} />
    ));
  };

  if (!username) return render({ error: 'Username is required.' });
  const temp = tempPassword();
  try {
    await createUser(c.env.DB, {
      username,
      passwordHash: await hashPassword(temp),
      role,
      mustChangePassword: true,
    });
  } catch {
    return render({ error: `Username “${username}” is already taken.` });
  }
  return render({ minted: { username, password: temp } });
});

settings.post('/settings/users/:id/reset', async (c) => {
  const id = Number(c.req.param('id'));
  const user = await getUserById(c.env.DB, id);
  if (!user) return c.notFound();
  const temp = tempPassword();
  await setPassword(c.env.DB, id, await hashPassword(temp), true);
  const [users, site] = await Promise.all([listUsers(c.env.DB), getSiteSettings(c.env.DB)]);
  return page(c, 'Members', (
    <UsersPage users={users} self={c.get('user').id} minted={{ username: user.username, password: temp }} currency={site.currency} />
  ));
});

settings.post('/settings/users/:id/display-name', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getUserById(c.env.DB, id))) return c.notFound();
  const body = await c.req.parseBody();
  await setDisplayName(c.env.DB, id, normalizeDisplayName(body['displayName']));
  return c.redirect('/settings/users');
});

settings.post('/settings/users/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  if (id === c.get('user').id) return c.text('You cannot remove yourself.', 400);
  await deleteUser(c.env.DB, id);
  return c.redirect('/settings/users');
});

export default settings;
