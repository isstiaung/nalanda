import { Hono } from 'hono';
import { getUserById, setPassword } from '../db/queries';
import type { AppEnv } from '../env';
import { hashPassword, verifyPassword } from '../lib/auth';
import { page } from '../views/layout';

const account = new Hono<AppEnv>();

const Form = ({ mustChange, error, ok }: { mustChange: boolean; error?: string; ok?: boolean }) => (
  <>
    <div class="page-head">
      <h1>Account</h1>
    </div>
    <article class="panel form-card">
      {mustChange ? (
        <p class="notice">Set your own password to continue — you logged in with a temporary one.</p>
      ) : null}
      {error ? <p class="error">{error}</p> : null}
      {ok ? <p class="notice">Password changed.</p> : null}
      <form method="post" action="/account/password">
        <label>
          Current password
          <input type="password" name="current" required autocomplete="current-password" />
        </label>
        <label>
          New password <small>(at least 8 characters)</small>
          <input type="password" name="next" required minlength={8} autocomplete="new-password" />
        </label>
        <label>
          Confirm new password
          <input type="password" name="confirm" required autocomplete="new-password" />
        </label>
        <button type="submit">Change password</button>
      </form>
    </article>
  </>
);

account.get('/account', (c) => {
  const user = c.get('user');
  return page(c, 'Account', <Form mustChange={user.mustChangePassword} ok={c.req.query('ok') === '1'} />);
});

account.post('/account/password', async (c) => {
  const sessionUser = c.get('user');
  const user = await getUserById(c.env.DB, sessionUser.id);
  if (!user) return c.redirect('/login');
  const body = await c.req.parseBody();
  const current = String(body['current'] ?? '');
  const next = String(body['next'] ?? '');
  const confirm = String(body['confirm'] ?? '');

  if (!(await verifyPassword(current, user.passwordHash))) {
    return page(c, 'Account', <Form mustChange={user.mustChangePassword} error="Current password is wrong." />);
  }
  if (next.length < 8) {
    return page(c, 'Account', (
      <Form mustChange={user.mustChangePassword} error="New password must be at least 8 characters." />
    ));
  }
  if (next !== confirm) {
    return page(c, 'Account', <Form mustChange={user.mustChangePassword} error="New passwords do not match." />);
  }
  await setPassword(c.env.DB, user.id, await hashPassword(next), false);
  return c.redirect(user.mustChangePassword ? '/' : '/account?ok=1');
});

export default account;
