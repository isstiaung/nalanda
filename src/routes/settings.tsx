import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { CustomField, User } from '../db/schema';
import { CUSTOM_KINDS } from '../db/schema';
import {
  createCustomField,
  createUser,
  deleteCustomField,
  deleteUser,
  getSiteSettings,
  getUserById,
  listCustomFields,
  listUsers,
  setDisplayName,
  setPassword,
  updateCustomField,
  updateSiteSettings,
} from '../db/queries';
import type { AppEnv } from '../env';
import { hashPassword, tempPassword } from '../lib/auth';
import { cleanCustomName, CUSTOM_FIELD_LIMIT, isCustomKind, KIND_LABEL, MAX_CUSTOM_NAME } from '../lib/custom';
import { currencyCodes, currencyName, isCurrencyCode } from '../lib/money';
import { MAX_DISPLAY_NAME, normalizeDisplayName } from '../lib/names';
import { invalid } from '../views/components';
import { page } from '../views/layout';
import { isLanguageCode, LANGUAGES, languageName } from '../lib/language';
import { ledgerDate } from '../lib/dates';
import { writerOf } from './items';

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
    <form method="post" action="/settings/currency" class="switch-form">
      <div class="switch-field">
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
      </div>
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
      <button type="submit">Save</button>
    </form>
  </section>
);

/**
 * The household's custom fields (ARCH.md §16 #95), admins only: each one renamed or switched on for share pages in
 * place, deleted with its values, and a new one added below until the cap. Values are typed on every item's form and
 * shown on its page; a field's values reach a share page only while its own switch is on, and never a connection.
 */
const CustomFieldsSection = ({ fields, error, errorField }: { fields: CustomField[]; error?: string; errorField?: number | null }) => (
  <section class="settings-section" id="custom-fields" aria-labelledby="custom-fields-head">
    <p class="eyebrow" id="custom-fields-head">
      Custom fields
    </p>
    {error ? (
      <p class="error" role="alert" id="custom-fields-error">
        {error}
      </p>
    ) : null}
    {fields.length ? (
      <div class="data-table cards">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Kind</th>
              <th class="actions-cell">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr>
                <td data-label="Field">
                  {/* the name and the share switch save together; the kind is fixed, since the values already hold it */}
                  <form method="post" action={`/settings/custom-fields/${f.id}`} class="inline-form custom-field-form">
                    <input
                      name="name"
                      value={f.name}
                      maxlength={MAX_CUSTOM_NAME}
                      required
                      aria-label={`Name of the field “${f.name}”`}
                      {...invalid(errorField === f.id && error, 'custom-fields-error')}
                    />
                    <label>
                      <input type="checkbox" name="onShares" value="1" checked={f.onShares} /> Show on share pages
                    </label>
                    <button type="submit" class="btn">
                      Save
                    </button>
                  </form>
                </td>
                <td data-label="Kind">
                  <span class="pill">{KIND_LABEL[f.kind]}</span>
                </td>
                <td class="actions-cell">
                  <form
                    method="post"
                    action={`/settings/custom-fields/${f.id}/delete`}
                    class="inline"
                    data-confirm={`Delete the field “${f.name}”? Every item's value for it is lost — there is no undo.`}
                  >
                    <button class="btn-danger" type="submit">
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <p class="muted">None yet.</p>
    )}
    {fields.length < CUSTOM_FIELD_LIMIT ? (
      <form method="post" action="/settings/custom-fields" class="inline-form custom-field-form">
        <input
          name="name"
          placeholder="e.g. Signed"
          maxlength={MAX_CUSTOM_NAME}
          required
          aria-label="Name of the new field"
          {...invalid(errorField === null && error, 'custom-fields-error')}
        />
        <select name="kind" aria-label="Kind of the new field">
          {CUSTOM_KINDS.map((k) => (
            <option value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
        <label>
          <input type="checkbox" name="onShares" value="1" /> Show on share pages
        </label>
        <button type="submit">Add field</button>
      </form>
    ) : (
      <p class="muted">
        {CUSTOM_FIELD_LIMIT} fields is the limit — delete one to add another.
      </p>
    )}
    <p class="muted">
      Up to {CUSTOM_FIELD_LIMIT} fields of the household's own — a line of text, a yes/no or a date — on every item's form,
      shown on its page when set. <strong>Private by default:</strong> a field's values appear on share pages only while its
      own switch is on, and never go to connected households. They leave with the export, by the field's name, in its{' '}
      <code>custom</code> column. Deleting a field deletes every item's value for it.
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
  language,
  fields,
  fieldsError,
  fieldsErrorField,
}: {
  users: User[];
  self: number;
  minted?: { username: string; password: string };
  error?: string;
  currency: string | null;
  currencyError?: string;
  language: string;
  fields: CustomField[];
  fieldsError?: string;
  fieldsErrorField?: number | null; // which field a refusal names; null is the add form
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
          Shown once — share it now. They're signed out everywhere, and set their own password at first login.
        </small>
      </article>
    ) : null}
    <div class="data-table cards">
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
              <td data-label="Display name">
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
              <td class="num" data-label="Role">
                {u.role}
              </td>
              <td class="date hide-sm" data-label="Since">
                {ledgerDate(u.createdAt)}
              </td>
              <td class="actions-cell">
                {/* a reset signs its account out everywhere, this device included: an admin's own password changes under Account */}
                {u.id === self ? (
                  <a class="btn" href="/account">
                    Change your password
                  </a>
                ) : (
                  <form method="post" action={`/settings/users/${u.id}/reset`} class="inline">
                    <button class="btn" type="submit">
                      Reset password
                    </button>
                  </form>
                )}{' '}
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

    <CustomFieldsSection fields={fields} error={fieldsError} errorField={fieldsErrorField} />
    <CurrencySection currency={currency} error={currencyError} />
    <LanguageSection language={language} />
  </>
);

type UsersPageExtras = Partial<Pick<Parameters<typeof UsersPage>[0], 'minted' | 'error' | 'currencyError' | 'fieldsError' | 'fieldsErrorField'>>;

/** The Members page with everything it lists — the members, the household's settings and its custom fields — read in parallel; `status` for a refusal shown on it. */
async function membersPage(c: Context<AppEnv>, extras: UsersPageExtras = {}, status?: ContentfulStatusCode) {
  const [users, site, fields] = await Promise.all([listUsers(c.env.DB), getSiteSettings(c.env.DB), listCustomFields(c.env.DB)]);
  if (status) c.status(status);
  return page(c, 'Members', <UsersPage users={users} self={c.get('user').id} currency={site.currency} language={site.language} fields={fields} {...extras} />);
}

settings.get('/settings/users', (c) => membersPage(c));

// ---------- custom fields (ARCH.md §16 #95) ----------

/** The add form's name and share switch, or the edit form's: the name cleaned, or why not. */
const fieldDraft = (body: Record<string, unknown>) => ({ name: cleanCustomName(body['name']), onShares: body['onShares'] === '1' });

settings.post('/settings/custom-fields', async (c) => {
  const body = await c.req.parseBody();
  const { name, onShares } = fieldDraft(body);
  if (!name) return membersPage(c, { fieldsError: `A field needs a name of up to ${MAX_CUSTOM_NAME} characters.`, fieldsErrorField: null }, 400);
  const kind = body['kind'];
  if (!isCustomKind(kind)) return membersPage(c, { fieldsError: 'Choose a kind: text, yes / no or date.', fieldsErrorField: null }, 400);
  const made = await createCustomField(c.env.DB, { name, kind, onShares });
  if (made === 'full') return membersPage(c, { fieldsError: `${CUSTOM_FIELD_LIMIT} fields is the limit — delete one to add another.`, fieldsErrorField: null }, 400);
  if (made === 'taken') return membersPage(c, { fieldsError: `There is already a field named “${name}”.`, fieldsErrorField: null }, 400);
  return c.redirect('/settings/users#custom-fields');
});

settings.post('/settings/custom-fields/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const { name, onShares } = fieldDraft(body);
  if (!name) return membersPage(c, { fieldsError: `A field needs a name of up to ${MAX_CUSTOM_NAME} characters.`, fieldsErrorField: id }, 400);
  const saved = await updateCustomField(c.env.DB, id, { name, onShares });
  if (saved === 'gone') return c.notFound();
  if (saved === 'taken') return membersPage(c, { fieldsError: `There is already a field named “${name}”.`, fieldsErrorField: id }, 400);
  return c.redirect('/settings/users#custom-fields');
});

/** Deletes a field and every item's value for it, in one batch; the admin is named in each item's history (§16 #84). */
settings.post('/settings/custom-fields/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await deleteCustomField(c.env.DB, id, writerOf(c)))) return c.notFound();
  return c.redirect('/settings/users#custom-fields');
});

/** Sets the household's currency (§16 #61). Admins only, like everything under /settings. */
/**
 * The household's default language (§16 #76): what every added item takes unless the provider or the file says
 * otherwise, and what the interface will follow. English until an admin picks another; changing it later changes no
 * item already added.
 */
const LanguageSection = ({ language }: { language: string }) => (
  <section class="settings-section" id="language" aria-labelledby="language-head">
    <p class="eyebrow" id="language-head">
      Household language
    </p>
    <form method="post" action="/settings/language" class="switch-form">
      <div class="switch-field">
        <label for="household-language">Books, games and records are added in</label>
        <select id="household-language" name="language" aria-describedby="language-help">
          {LANGUAGES.map((l) => (
            <option value={l.code} selected={l.code === language}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <p class="muted" id="language-help">
        Now <strong>{languageName(language)}</strong>. Every item added takes it unless its source says otherwise, and any
        item's language can be changed on its form. Changing this later leaves items already added as they are.
      </p>
      <button type="submit">Save</button>
    </form>
  </section>
);

settings.post('/settings/language', async (c) => {
  const body = await c.req.parseBody();
  const code = typeof body['language'] === 'string' ? body['language'].trim() : '';
  if (!isLanguageCode(code)) return c.text('Choose a language from the list.', 400);
  await updateSiteSettings(c.env.DB, { language: code });
  return c.redirect('/settings/users#language');
});

settings.post('/settings/currency', async (c) => {
  const body = await c.req.parseBody();
  const code = typeof body['currency'] === 'string' ? body['currency'].trim() : '';
  // a fixed message: never the value sent, which a crafted form could fill with anything
  if (!isCurrencyCode(code)) return membersPage(c, { currencyError: 'Choose a currency from the list.' }, 400);
  await updateSiteSettings(c.env.DB, { currency: code });
  return c.redirect('/settings/users#currency');
});

settings.post('/settings/users', async (c) => {
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const role = body['role'] === 'admin' ? 'admin' : 'member';
  const render = (opts: { minted?: { username: string; password: string }; error?: string }) => membersPage(c, opts);

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
  // a reset moves the account's sessions on without re-issuing this device's cookie: on the admin's own account it
  // would sign out the device that asked, with the temporary password shown once to a page about to be lost
  if (id === c.get('user').id) return c.text('Change your own password under Account — a reset would sign this device out.', 400);
  const user = await getUserById(c.env.DB, id);
  if (!user) return c.notFound();
  const temp = tempPassword();
  await setPassword(c.env.DB, id, await hashPassword(temp), true);
  return membersPage(c, { minted: { username: user.username, password: temp } });
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
  const me = c.get('user');
  if (id === me.id) return c.text('You cannot remove yourself.', 400);
  // refused in the batch itself when no admin would remain, or the remover is no longer one: two admins removing each
  // other at once would otherwise leave nobody, and /setup open to the next visitor
  if (!(await deleteUser(c.env.DB, id, me.id))) return c.text('Not removed: a household keeps at least one admin, and only an admin still here can remove a member.', 409);
  return c.redirect('/settings/users');
});

export default settings;
