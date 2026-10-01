import { Hono } from 'hono';
import type { User } from '../db/schema';
import {
  createUser,
  deleteTranslation,
  deleteUser,
  getUserById,
  listUsers,
  setDisplayName,
  setPassword,
  setTranslation,
  siteSettingsWithTranslations,
  updateSiteSettings,
} from '../db/queries';
import type { AppEnv } from '../env';
import { hashPassword, tempPassword } from '../lib/auth';
import { currencyCodes, currencyName, isCurrencyCode } from '../lib/money';
import { MAX_DISPLAY_NAME, normalizeDisplayName } from '../lib/names';
import { page } from '../views/layout';
import { isLanguageCode, LANGUAGES, languageName } from '../lib/language';
import { ledgerDate } from '../lib/dates';
import { isLocale, LOCALE_NAMES, locales, MAX_TRANSLATION_BYTES, parseTranslation, resolveLocale } from '../i18n';
import { Fill, useI18n } from '../views/i18n';

const settings = new Hono<AppEnv>();

settings.use('/settings/*', async (c, next) => {
  if (c.get('user').role !== 'admin') return c.text('Admins only', 403);
  await next();
});

/**
 * The household's currency (§16 #61): one select of every code the runtime knows, named. Once set it can be changed,
 * never cleared; prices already entered keep the currency they were entered in.
 */
const CurrencySection = ({ currency, error }: { currency: string | null; error?: string }) => {
  const { t } = useI18n();
  return (
    <section class="settings-section" id="currency" aria-labelledby="currency-head">
      <p class="eyebrow" id="currency-head">
        {t('members.currency')}
      </p>
      <form method="post" action="/settings/currency" class="switch-form">
        <div class="switch-field">
          <label for="household-currency">{t('members.currency_label')}</label>
          <select
            id="household-currency"
            name="currency"
            required
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? 'currency-error currency-help' : 'currency-help'}
          >
            {currency ? null : (
              <option value="" selected>
                {t('members.choose_currency')}
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
              <Fill text={t('members.currency_now')} with={{ code: <strong class="mono">{currency}</strong> }} />{' '}
            </>
          ) : (
            <>{t('members.currency_unset')} </>
          )}
          {t('members.currency_note')}
        </p>
        <button type="submit">{t('members.save')}</button>
      </form>
    </section>
  );
};

type TranslationRow = { locale: string; count: number; updatedAt: string };

const UsersPage = ({
  users,
  self,
  minted,
  error,
  currency,
  currencyError,
  language,
  translations,
}: {
  users: User[];
  self: number;
  minted?: { username: string; password: string };
  error?: string;
  currency: string | null;
  currencyError?: string;
  language: string;
  translations: TranslationRow[];
}) => {
  const { t, n } = useI18n();
  return (
    <>
      <div class="page-head">
        <div>
          <h1>{t('members.title')}</h1>
          <span class="sub">{n('members.accounts', users.length)}</span>
        </div>
      </div>
      {error ? <p class="error" role="alert">{error}</p> : null}
      {minted ? (
        <article class="notice">
          <strong>{t('members.temp_password_for', { name: minted.username })}</strong> <code>{minted.password}</code>
          <br />
          <small class="muted">{t('members.shown_once')}</small>
        </article>
      ) : null}
      <div class="data-table cards">
        <table>
          <thead>
            <tr>
              <th>{t('members.username')}</th>
              <th>{t('members.display_name')}</th>
              <th>{t('members.role')}</th>
              <th class="hide-sm">{t('members.since')}</th>
              <th class="actions-cell"><span class="sr-only">{t('members.actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr>
                <td>
                  <strong>{u.username}</strong>
                  {u.id === self ? <small class="muted"> {t('members.you')}</small> : null}
                  {u.mustChangePassword ? (
                    <>
                      {' '}
                      <span class="pill progress">{t('members.temp_password')}</span>
                    </>
                  ) : null}
                </td>
                <td data-label={t('members.display_name')}>
                  {/* shown outside the app only where names are switched on (§16 #45); an admin can set anyone's */}
                  <form method="post" action={`/settings/users/${u.id}/display-name`} class="inline-form display-name-form">
                    <input
                      name="displayName"
                      value={u.displayName ?? ''}
                      maxlength={MAX_DISPLAY_NAME}
                      placeholder={t('members.none')}
                      aria-label={t('members.display_name_for', { name: u.username })}
                    />
                    <button type="submit" class="btn">
                      {t('members.save')}
                    </button>
                  </form>
                </td>
                <td class="num" data-label={t('members.role')}>
                  {t(u.role === 'admin' ? 'role.admin' : 'role.member')}
                </td>
                <td class="date hide-sm" data-label={t('members.since')}>
                  {ledgerDate(u.createdAt)}
                </td>
                <td class="actions-cell">
                  {/* a reset signs its account out everywhere, this device included: an admin's own password changes under Account */}
                  {u.id === self ? (
                    <a class="btn" href="/account">
                      {t('members.change_your_password')}
                    </a>
                  ) : (
                    <form method="post" action={`/settings/users/${u.id}/reset`} class="inline">
                      <button class="btn" type="submit">
                        {t('members.reset_password')}
                      </button>
                    </form>
                  )}{' '}
                  {u.id !== self ? (
                    <form
                      method="post"
                      action={`/settings/users/${u.id}/delete`}
                      class="inline"
                      data-confirm={t('members.remove_confirm', { name: u.username })}
                    >
                      <button class="btn-danger" type="submit">
                        {t('members.remove')}
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
        <p class="eyebrow">{t('members.add')}</p>
        <form method="post" action="/settings/users" class="inline-form">
          <input name="username" placeholder={t('members.username_placeholder')} aria-label={t('members.username')} required />
          <select name="role" aria-label={t('members.role')}>
            <option value="member">{t('role.member')}</option>
            <option value="admin">{t('role.admin')}</option>
          </select>
          <button type="submit">{t('members.create')}</button>
        </form>
        <p class="muted">{t('members.no_email')}</p>
        <p class="muted">
          <Fill text={t('members.display_name_note')} with={{ displayName: <strong>{t('members.display_name_word')}</strong> }} />
        </p>
      </section>

      <CurrencySection currency={currency} error={currencyError} />
      <LanguageSection language={language} />
      <TranslationsSection translations={translations} />
    </>
  );
};

/** Everything the Members page shows: the members, and the settings with the household's translations in one call. */
async function membersFacts(c: Parameters<typeof page>[0]) {
  const [users, { settings: site, translations }] = await Promise.all([listUsers(c.env.DB), siteSettingsWithTranslations(c.env.DB)]);
  return { users, site, translations };
}

settings.get('/settings/users', async (c) => {
  const { users, site, translations } = await membersFacts(c);
  return page(c, c.get('i18n').t('members.title'), (
    <UsersPage users={users} self={c.get('user').id} currency={site.currency} language={site.language} translations={translations} />
  ));
});

/**
 * The household's default language (§16 #76): what every added item takes unless the provider or the file says
 * otherwise, and what the interface follows where a translation exists (§16 #93). English until an admin picks
 * another; changing it later changes no item already added.
 */
const LanguageSection = ({ language }: { language: string }) => {
  const { t } = useI18n();
  const follows = resolveLocale(null, { language });
  return (
    <section class="settings-section" id="language" aria-labelledby="language-head">
      <p class="eyebrow" id="language-head">
        {t('members.language')}
      </p>
      <form method="post" action="/settings/language" class="switch-form">
        <div class="switch-field">
          <label for="household-language">{t('members.language_label')}</label>
          <select id="household-language" name="language" aria-describedby="language-help">
            {LANGUAGES.map((l) => (
              <option value={l.code} selected={l.code === language}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <p class="muted" id="language-help">
          <Fill text={t('members.language_now')} with={{ name: <strong>{languageName(language)}</strong> }} /> {t('members.language_note')}{' '}
          {/* which interface language the household's choice gives (§16 #93): its own, or English where none is shipped */}
          {isLocale(language)
            ? t('members.interface_follows', { name: LOCALE_NAMES[follows] })
            : t('members.interface_english', { name: languageName(language) })}
        </p>
        <button type="submit">{t('members.save')}</button>
      </form>
    </section>
  );
};

/**
 * The household's own interface translations (§16 #93): one file per shipped locale, read in the browser
 * (public/translations.js) and posted as JSON, overriding the shipped strings key by key for this household — on
 * share pages too. Listed with a download of the merged table and a Remove that clears it.
 */
const TranslationsSection = ({ translations }: { translations: TranslationRow[] }) => {
  const { t } = useI18n();
  return (
    <section class="settings-section" id="translations" aria-labelledby="translations-head">
      <p class="eyebrow" id="translations-head">
        {t('members.translations')}
      </p>
      <p class="muted">{t('members.translations_intro')}</p>
      {translations.length ? (
        <ul class="token-list">
          {translations.map((tr) => (
            <li>
              <span>
                {t('members.translation_present', { name: isLocale(tr.locale) ? LOCALE_NAMES[tr.locale] : tr.locale, count: tr.count, date: ledgerDate(tr.updatedAt) })}{' '}
                <a href={`/strings/${tr.locale}.json`} download={`nalanda-strings-${tr.locale}.json`}>
                  {t('members.download')}
                </a>
              </span>
              <form method="post" action={`/settings/translations/${tr.locale}/delete`} class="inline-form">
                <button type="submit" class="btn-danger">
                  {t('members.remove')}
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">{t('members.translations_none')}</p>
      )}
      {/* the page's fixed sentences for the script, as data: never the server's answer as text */}
      <form
        id="translation-form"
        class="inline-form"
        data-max-bytes={String(MAX_TRANSLATION_BYTES)}
        data-reading={t('members.import_status_reading')}
        data-done={t('members.import_status_done')}
        data-failed={t('members.import_status_failed')}
        data-too-big={t('members.import_too_big')}
        data-not-json={t('members.import_not_json')}
      >
        <label for="translation-locale">{t('members.translation_for')}</label>
        <select id="translation-locale" name="locale">
          {locales.map((l) => (
            <option value={l}>{LOCALE_NAMES[l]}</option>
          ))}
        </select>
        <label for="translation-file">{t('members.translation_file')}</label>
        <input id="translation-file" type="file" accept=".json,application/json" required />
        <button type="submit">{t('members.import')}</button>
      </form>
      <output id="translation-status" class="muted" aria-live="polite"></output>
      <script src="/translations.js" defer></script>
    </section>
  );
};

/**
 * Imports a household translation (§16 #93): `{ locale, strings }`, the file's object as the browser parsed it. At
 * most MAX_TRANSLATION_BYTES; only keys in the table are kept (the answer counts the rest as ignored); a locale that
 * isn't shipped, or a body that isn't an object, is refused. Admins only, like everything under /settings.
 */
settings.post('/settings/translations', async (c) => {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MAX_TRANSLATION_BYTES) return c.json({ error: 'Too large.' }, 413);
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_TRANSLATION_BYTES) return c.json({ error: 'Too large.' }, 413);
  let body: { locale?: unknown; strings?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }
  if (body === null || typeof body !== 'object' || !isLocale(body.locale)) return c.json({ error: 'Choose a language from the list.' }, 400);
  const parsed = parseTranslation(body.strings);
  if (!parsed) return c.json({ error: 'The file must be a JSON object of key → string.' }, 400);
  await setTranslation(c.env.DB, body.locale, parsed.strings);
  return c.json({ locale: body.locale, kept: parsed.kept, ignored: parsed.ignored });
});

settings.post('/settings/translations/:locale/delete', async (c) => {
  const locale = c.req.param('locale');
  if (isLocale(locale)) await deleteTranslation(c.env.DB, locale);
  return c.redirect('/settings/users#translations');
});

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
  if (!isCurrencyCode(code)) {
    const { users, site, translations } = await membersFacts(c);
    c.status(400);
    // a fixed message: never the value sent, which a crafted form could fill with anything
    return page(c, c.get('i18n').t('members.title'), (
      <UsersPage
        users={users}
        self={c.get('user').id}
        currency={site.currency}
        language={site.language}
        translations={translations}
        currencyError={c.get('i18n').t('members.currency_error')}
      />
    ));
  }
  await updateSiteSettings(c.env.DB, { currency: code });
  return c.redirect('/settings/users#currency');
});

settings.post('/settings/users', async (c) => {
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const role = body['role'] === 'admin' ? 'admin' : 'member';
  const { t } = c.get('i18n');
  const render = async (opts: { minted?: { username: string; password: string }; error?: string }) => {
    const { users, site, translations } = await membersFacts(c);
    return page(c, t('members.title'), (
      <UsersPage
        users={users}
        self={c.get('user').id}
        minted={opts.minted}
        error={opts.error}
        currency={site.currency}
        language={site.language}
        translations={translations}
      />
    ));
  };

  if (!username) return render({ error: t('members.username_required') });
  const temp = tempPassword();
  try {
    await createUser(c.env.DB, {
      username,
      passwordHash: await hashPassword(temp),
      role,
      mustChangePassword: true,
    });
  } catch {
    return render({ error: t('members.username_taken', { name: username }) });
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
  const { users, site, translations } = await membersFacts(c);
  return page(c, c.get('i18n').t('members.title'), (
    <UsersPage
      users={users}
      self={c.get('user').id}
      minted={{ username: user.username, password: temp }}
      currency={site.currency}
      language={site.language}
      translations={translations}
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
  const me = c.get('user');
  if (id === me.id) return c.text('You cannot remove yourself.', 400);
  // refused in the batch itself when no admin would remain, or the remover is no longer one: two admins removing each
  // other at once would otherwise leave nobody, and /setup open to the next visitor
  if (!(await deleteUser(c.env.DB, id, me.id))) return c.text('Not removed: a household keeps at least one admin, and only an admin still here can remove a member.', 409);
  return c.redirect('/settings/users');
});

export default settings;
