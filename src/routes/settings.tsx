import { Hono } from 'hono';
import type { User } from '../db/schema';
import { createUser, deleteUser, getUserById, listUsers, setDisplayName, setPassword } from '../db/queries';
import type { AppEnv } from '../env';
import { hashPassword, tempPassword } from '../lib/auth';
import { MAX_DISPLAY_NAME, normalizeDisplayName } from '../lib/names';
import { page } from '../views/layout';

const settings = new Hono<AppEnv>();

settings.use('/settings/*', async (c, next) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  await next();
});

const UsersPage = ({
  users,
  self,
  minted,
  error,
}: {
  users: User[];
  self: number;
  minted?: { username: string; password: string };
  error?: string;
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
    {error ? <p class="error">{error}</p> : null}
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
            <th class="actions-cell"></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr>
              <td>
                <strong>{u.username}</strong>
                {u.id === self ? <small class="muted"> (you)</small> : null}
                {u.mustChangePassword ? <span class="pill progress"> Temp password</span> : null}
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
                    data-confirm={`Remove ${u.username}? They will be logged out immediately. Their reads and reviews stay, credited to a former member.`}
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

    <section style="margin-top:1.5rem">
      <p class="eyebrow">Add a member</p>
      <form method="post" action="/settings/users" class="inline-form">
        <input name="username" placeholder="username" required />
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
  </>
);

settings.get('/settings/users', async (c) => {
  const users = await listUsers(c.env.DB);
  return page(c, 'Members', <UsersPage users={users} self={c.get('user').id} />);
});

settings.post('/settings/users', async (c) => {
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const role = body['role'] === 'admin' ? 'admin' : 'member';
  const render = async (opts: { minted?: { username: string; password: string }; error?: string }) =>
    page(c, 'Members', (
      <UsersPage users={await listUsers(c.env.DB)} self={c.get('user').id} minted={opts.minted} error={opts.error} />
    ));

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
  return page(c, 'Members', (
    <UsersPage
      users={await listUsers(c.env.DB)}
      self={c.get('user').id}
      minted={{ username: user.username, password: temp }}
    />
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
