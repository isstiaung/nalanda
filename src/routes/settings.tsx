import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { CustomField, User } from '../db/schema';
import type { PendingLink } from '../db/queries';
import { CUSTOM_KINDS } from '../db/schema';
import {
  createCustomField,
  createInvitedUser,
  deleteCustomField,
  deleteDisplayFont,
  deleteTranslation,
  deleteUser,
  getUserById,
  listUsers,
  membersSettings,
  setDisplayFont,
  setDisplayName,
  resetWithLink,
  setTranslation,
  updateCustomField,
  updateSiteSettings,
  type DisplayFontRow,
} from '../db/queries';
import type { AppEnv } from '../env';
import { hashLinkToken, LINK_DAYS, newLinkToken, unusablePasswordHash } from '../lib/auth';
import { cleanCustomName, CUSTOM_FIELD_LIMIT, isCustomKind, MAX_CUSTOM_NAME } from '../lib/custom';
import { cleanFontName, deleteFont, FONT_MAX_BYTES, FONT_MIN_BYTES, sniffFontType, storeFont } from '../lib/fonts';
import { currencyCodes, currencyName, isCurrencyCode } from '../lib/money';
import { MAX_DISPLAY_NAME, normalizeDisplayName } from '../lib/names';
import { invalid } from '../views/components';
import { page } from '../views/layout';
import { isLanguageCode, LANGUAGES, languageName } from '../lib/language';
import { ledgerDate } from '../lib/dates';
import { isLocale, LOCALE_NAMES, locales, MAX_TRANSLATION_BYTES, parseTranslation, resolveLocale } from '../i18n';
import { Fill, useI18n } from '../views/i18n';
import { writerOf } from './items';
import { QR_BLANK } from './shares';

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

/**
 * The household's custom fields (ARCH.md §16 #95), admins only: each one renamed or switched on for share pages in
 * place, deleted with its values, and a new one added below until the cap. Values are typed on every item's form and
 * shown on its page; a field's values reach a share page only while its own switch is on, and never a connection.
 */
const CustomFieldsSection = ({ fields, error, errorField }: { fields: CustomField[]; error?: string; errorField?: number | null }) => {
  const { t } = useI18n();
  return (
    <section class="settings-section" id="custom-fields" aria-labelledby="custom-fields-head">
      <p class="eyebrow" id="custom-fields-head">
        {t('members.fields')}
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
                <th>{t('members.fields_field')}</th>
                <th>{t('members.fields_kind')}</th>
                <th class="actions-cell">
                  <span class="sr-only">{t('members.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr>
                  <td data-label={t('members.fields_field')}>
                    {/* the name and the share switch save together; the kind is fixed, since the values already hold it */}
                    <form method="post" action={`/settings/custom-fields/${f.id}`} class="inline-form custom-field-form">
                      <input
                        name="name"
                        value={f.name}
                        maxlength={MAX_CUSTOM_NAME}
                        required
                        aria-label={t('members.fields_name_of', { name: f.name })}
                        {...invalid(errorField === f.id && error, 'custom-fields-error')}
                      />
                      <label>
                        <input type="checkbox" name="onShares" value="1" checked={f.onShares} /> {t('members.fields_on_shares')}
                      </label>
                      <button type="submit" class="btn">
                        {t('members.save')}
                      </button>
                    </form>
                  </td>
                  <td data-label={t('members.fields_kind')}>
                    <span class="pill">{t(`custom.kind.${f.kind}`)}</span>
                  </td>
                  <td class="actions-cell">
                    <form
                      method="post"
                      action={`/settings/custom-fields/${f.id}/delete`}
                      class="inline"
                      data-confirm={t('members.fields_delete_confirm', { name: f.name })}
                    >
                      <button class="btn-danger" type="submit">
                        {t('members.fields_delete')}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">{t('members.fields_none')}</p>
      )}
      {fields.length < CUSTOM_FIELD_LIMIT ? (
        <form method="post" action="/settings/custom-fields" class="inline-form custom-field-form">
          <input
            name="name"
            placeholder={t('members.fields_new_placeholder')}
            maxlength={MAX_CUSTOM_NAME}
            required
            aria-label={t('members.fields_new_name')}
            {...invalid(errorField === null && error, 'custom-fields-error')}
          />
          <select name="kind" aria-label={t('members.fields_new_kind')}>
            {CUSTOM_KINDS.map((k) => (
              <option value={k}>{t(`custom.kind.${k}`)}</option>
            ))}
          </select>
          <label>
            <input type="checkbox" name="onShares" value="1" /> {t('members.fields_on_shares')}
          </label>
          <button type="submit">{t('members.fields_add')}</button>
        </form>
      ) : (
        <p class="muted">{t('members.fields_limit', { limit: CUSTOM_FIELD_LIMIT })}</p>
      )}
      <p class="muted">
        <Fill
          text={t('members.fields_note', { limit: CUSTOM_FIELD_LIMIT })}
          with={{ private: <strong>{t('members.fields_private')}</strong>, column: <code>custom</code> }}
        />
      </p>
    </section>
  );
};

type TranslationRow = { locale: string; count: number; updatedAt: string };

/**
 * A link just made (§16 #97), shown on this response alone: its address to copy or send, and its QR code — drawn in the
 * browser by /qr.js, as Shared links draws a share's — so a member can scan it from the admin's screen.
 */
const MintedLink = ({ minted, expiresAt }: { minted: { username: string; link: string; purpose: 'invite' | 'reset' }; expiresAt: string | null }) => {
  const { t } = useI18n();
  const date = expiresAt ? ledgerDate(expiresAt) : '';
  return (
    <article class="notice minted-link">
      <p>
        <strong>{t(minted.purpose === 'invite' ? 'members.invite_link_for' : 'members.reset_link_for', { name: minted.username, date })}</strong>
      </p>
      <p>
        <a href={minted.link} class="mono break-anywhere">
          {minted.link}
        </a>
      </p>
      <div class="share-qr">
        <img data-qr={minted.link} alt={t('members.link_qr', { name: minted.username })} width="512" height="512" src={QR_BLANK} />
      </div>
      <p class="muted">
        <small>
          {minted.purpose === 'reset' ? `${t('members.reset_signed_out')} ` : ''}
          {t('members.link_shown_once')}
        </small>
      </p>
      <script src="/qr.js" defer></script>
    </article>
  );
};

const UsersPage = ({
  users,
  self,
  links,
  minted,
  error,
  currency,
  currencyError,
  language,
  fields,
  fieldsError,
  fieldsErrorField,
  translations,
  fonts,
  fontError,
  fontErrorField,
  fontNotice,
}: {
  users: User[];
  self: number;
  links: PendingLink[];
  minted?: { username: string; link: string; purpose: 'invite' | 'reset' };
  error?: string;
  currency: string | null;
  currencyError?: string;
  language: string;
  fields: CustomField[];
  fieldsError?: string;
  fieldsErrorField?: number | null; // which field a refusal names; null is the add form
  translations: TranslationRow[];
  fonts: DisplayFontRow[];
  fontError?: string;
  fontErrorField?: 'locale' | 'file'; // which of the upload's fields a refusal names
  fontNotice?: 'saved' | 'removed';
}) => {
  const { t, n } = useI18n();
  const linkOf = new Map(links.map((l) => [l.userId, l]));
  return (
    <>
      <div class="page-head">
        <div>
          <h1>{t('members.title')}</h1>
          <span class="sub">{n('members.accounts', users.length)}</span>
        </div>
      </div>
      {error ? <p class="error" role="alert">{error}</p> : null}
      {minted ? <MintedLink minted={minted} expiresAt={linkOf.get(users.find((u) => u.username === minted.username)?.id ?? -1)?.expiresAt ?? null} /> : null}
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
                  {/* a link out (§16 #97), or — from before links — a temporary password still to change */}
                  {linkOf.has(u.id) ? (
                    <>
                      {' '}
                      <span class="pill progress">
                        {t(linkOf.get(u.id)!.purpose === 'invite' ? 'members.invited_until' : 'members.reset_until', { date: ledgerDate(linkOf.get(u.id)!.expiresAt) })}
                      </span>
                    </>
                  ) : u.mustChangePassword ? (
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
                        {t(linkOf.get(u.id)?.purpose === 'invite' ? 'members.new_invite_link' : 'members.reset_password')}
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

      <CustomFieldsSection fields={fields} error={fieldsError} errorField={fieldsErrorField} />
      <CurrencySection currency={currency} error={currencyError} />
      <LanguageSection language={language} />
      <TranslationsSection translations={translations} />
      <DisplayFontSection fonts={fonts} language={language} error={fontError} errorField={fontErrorField} notice={fontNotice} />
    </>
  );
};

type UsersPageExtras = Partial<
  Pick<Parameters<typeof UsersPage>[0], 'minted' | 'error' | 'currencyError' | 'fieldsError' | 'fieldsErrorField' | 'fontError' | 'fontErrorField' | 'fontNotice'>
>;

/**
 * The Members page with everything it lists — the members, and in one call the household's settings, its custom
 * fields (§16 #95), its own translations (§16 #93) and its display fonts (§16 #96) — read in parallel; `status` for a
 * refusal shown on it.
 */
async function membersPage(c: Context<AppEnv>, extras: UsersPageExtras = {}, status?: ContentfulStatusCode) {
  const [users, { settings: site, customFields: fields, translations, fonts, links }] = await Promise.all([listUsers(c.env.DB), membersSettings(c.env.DB)]);
  if (status) c.status(status);
  return page(c, c.get('i18n').t('members.title'), (
    <UsersPage
      users={users}
      self={c.get('user').id}
      links={links}
      currency={site.currency}
      language={site.language}
      fields={fields}
      translations={translations}
      fonts={fonts}
      {...extras}
    />
  ));
}

settings.get('/settings/users', (c) => {
  // the display font's upload and Remove land back here and say so (§16 #96): a fixed word in the query, nothing more
  const font = c.req.query('font');
  return membersPage(c, { fontNotice: font === 'saved' || font === 'removed' ? font : undefined });
});

// ---------- custom fields (ARCH.md §16 #95) ----------

/** The add form's name and share switch, or the edit form's: the name cleaned, or why not. */
const fieldDraft = (body: Record<string, unknown>) => ({ name: cleanCustomName(body['name']), onShares: body['onShares'] === '1' });

settings.post('/settings/custom-fields', async (c) => {
  const body = await c.req.parseBody();
  const { name, onShares } = fieldDraft(body);
  const { t } = c.get('i18n');
  if (!name) return membersPage(c, { fieldsError: t('members.fields_name_required', { max: MAX_CUSTOM_NAME }), fieldsErrorField: null }, 400);
  const kind = body['kind'];
  if (!isCustomKind(kind)) return membersPage(c, { fieldsError: t('members.fields_kind_required'), fieldsErrorField: null }, 400);
  const made = await createCustomField(c.env.DB, { name, kind, onShares });
  if (made === 'full') return membersPage(c, { fieldsError: t('members.fields_limit', { limit: CUSTOM_FIELD_LIMIT }), fieldsErrorField: null }, 400);
  if (made === 'taken') return membersPage(c, { fieldsError: t('members.fields_taken', { name }), fieldsErrorField: null }, 400);
  return c.redirect('/settings/users#custom-fields');
});

settings.post('/settings/custom-fields/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const { name, onShares } = fieldDraft(body);
  const { t } = c.get('i18n');
  if (!name) return membersPage(c, { fieldsError: t('members.fields_name_required', { max: MAX_CUSTOM_NAME }), fieldsErrorField: id }, 400);
  const saved = await updateCustomField(c.env.DB, id, { name, onShares });
  if (saved === 'gone') return c.notFound();
  if (saved === 'taken') return membersPage(c, { fieldsError: t('members.fields_taken', { name }), fieldsErrorField: id }, 400);
  return c.redirect('/settings/users#custom-fields');
});

/** Deletes a field and every item's value for it, in one batch; the admin is named in each item's history (§16 #84). */
settings.post('/settings/custom-fields/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await deleteCustomField(c.env.DB, id, writerOf(c)))) return c.notFound();
  return c.redirect('/settings/users#custom-fields');
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

/** A font's size on Members: whole kilobytes, never 0. */
const kilobytes = (bytes: number) => Math.max(1, Math.round(bytes / 1024));
const FONT_MAX_MB = FONT_MAX_BYTES / (1024 * 1024);

/**
 * The household's display fonts (§16 #96): per shipped locale, the face its titles take — the household's own file,
 * named with its size and a Remove, or the shipped faces — and one upload form, a language and a file. The file's
 * name is shown here alone; a page in that language reads only the font's key and format.
 */
const DisplayFontSection = ({
  fonts,
  language,
  error,
  errorField,
  notice,
}: {
  fonts: DisplayFontRow[];
  language: string;
  error?: string;
  errorField?: 'locale' | 'file';
  notice?: 'saved' | 'removed';
}) => {
  const { t } = useI18n();
  const household = resolveLocale(null, { language });
  const described = (field: 'locale' | 'file', help?: string) =>
    [error && errorField === field ? 'display-font-error' : null, help].filter(Boolean).join(' ') || undefined;
  return (
    <section class="settings-section" id="display-font" aria-labelledby="display-font-head">
      <p class="eyebrow" id="display-font-head">
        {t('members.font')}
      </p>
      <p class="muted">{t('members.font_intro')}</p>
      {notice ? <p class="notice">{t(notice === 'saved' ? 'members.font_saved' : 'members.font_removed')}</p> : null}
      {error ? (
        <p class="error" role="alert" id="display-font-error">
          {error}
        </p>
      ) : null}
      <ul class="token-list">
        {locales.map((l) => {
          const font = fonts.find((f) => f.locale === l);
          return (
            <li>
              <span>
                {font
                  ? t('members.font_present', { language: LOCALE_NAMES[l], name: font.name, kb: kilobytes(font.bytes), date: ledgerDate(font.uploadedAt) })
                  : t('members.font_shipped', { language: LOCALE_NAMES[l] })}
              </span>
              {font ? (
                <form method="post" action={`/settings/display-fonts/${l}/delete`} class="inline-form">
                  <button type="submit" class="btn-danger">
                    {t('members.remove')}
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
      <form method="post" action="/settings/display-fonts" enctype="multipart/form-data" class="inline-form">
        <label for="display-font-locale">{t('members.font_for')}</label>
        <select
          id="display-font-locale"
          name="locale"
          aria-invalid={error && errorField === 'locale' ? 'true' : undefined}
          aria-describedby={described('locale')}
        >
          {locales.map((l) => (
            <option value={l} selected={l === household}>
              {LOCALE_NAMES[l]}
            </option>
          ))}
        </select>
        <label for="display-font-file">{t('members.font_file')}</label>
        <input
          id="display-font-file"
          name="file"
          type="file"
          accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
          required
          aria-invalid={error && errorField === 'file' ? 'true' : undefined}
          aria-describedby={described('file', 'display-font-help')}
        />
        <button type="submit">{t('members.font_upload')}</button>
      </form>
      <p class="muted" id="display-font-help">
        {t('members.font_formats', { mb: FONT_MAX_MB })} {t('members.font_note')}
      </p>
    </section>
  );
};

/** The framing around an upload — the boundaries, the locale field, the file part's headers: a few hundred bytes. */
const MULTIPART_SLACK = 16 * 1024;

/**
 * Uploads a display font for a shipped locale (§16 #96), admins only like everything under /settings. Refused back to
 * Members with the reason: past FONT_MAX_BYTES 413 (unread, when the request says so — parsing a multipart body is CPU
 * in proportion to its size), a locale that isn't shipped or a file that isn't a font by its first bytes 400. Kept as
 * it came, under a new key; the name is cleaned and shown on Members alone.
 *
 * The object first, then the row: R2 isn't in the D1 batch, so the order decides what a failure leaves. Stored first,
 * a page never names a key whose object isn't there yet. Replacing, the row names the new key before the old object
 * goes, so no page is ever pointed at a deleted font (a share page cached on another isolate may for up to an hour —
 * its titles fall back to Eczar). What a failure between the two leaves is an orphaned object no row names: public
 * bytes, a few hundred KB of storage, never a broken page.
 */
settings.post('/settings/display-fonts', async (c) => {
  const { t } = c.get('i18n');
  const refuse = (key: `members.font_error_${'locale' | 'file' | 'type' | 'size' | 'store'}`, status: ContentfulStatusCode, field: 'locale' | 'file') =>
    membersPage(c, { fontError: t(key, { mb: FONT_MAX_MB }), fontErrorField: field }, status);
  if (Number(c.req.header('content-length') ?? '0') > FONT_MAX_BYTES + MULTIPART_SLACK) return refuse('members.font_error_size', 413, 'file');
  const body = await c.req.parseBody();
  const locale = body['locale'];
  if (!isLocale(locale)) return refuse('members.font_error_locale', 400, 'locale');
  const file = body['file'] instanceof File && body['file'].size > 0 ? body['file'] : null;
  if (!file) return refuse('members.font_error_file', 400, 'file');
  if (file.size > FONT_MAX_BYTES) return refuse('members.font_error_size', 413, 'file');
  const bytes = await file.arrayBuffer();
  // under FONT_MIN_BYTES is no font, whatever it opens with; the type is the bytes', never the name's or the browser's
  const format = bytes.byteLength >= FONT_MIN_BYTES ? sniffFontType(new Uint8Array(bytes, 0, 4)) : null;
  if (!format) return refuse('members.font_error_type', 400, 'file');
  const key = await storeFont(c.env.COVERS, bytes, format);
  if (!key) return refuse('members.font_error_store', 500, 'file');
  let before: string | null;
  try {
    ({ before } = await setDisplayFont(c.env.DB, { locale, key, format, name: cleanFontName(file.name, format), bytes: bytes.byteLength }));
  } catch (err) {
    c.executionCtx.waitUntil(deleteFont(c.env.COVERS, key)); // no row names it, and none ever will
    throw err;
  }
  if (before && before !== key) c.executionCtx.waitUntil(deleteFont(c.env.COVERS, before));
  return c.redirect('/settings/users?font=saved#display-font');
});

/**
 * Removes a locale's display font (§16 #96): the row first, then the object — R2 isn't in the D1 batch, and in this
 * order no page is pointed at a font already gone. A failure between leaves the object orphaned, named by no row:
 * public bytes nobody loads, never a broken page.
 */
settings.post('/settings/display-fonts/:locale/delete', async (c) => {
  const locale = c.req.param('locale');
  if (isLocale(locale)) {
    const key = await deleteDisplayFont(c.env.DB, locale);
    if (key) c.executionCtx.waitUntil(deleteFont(c.env.COVERS, key));
  }
  return c.redirect('/settings/users?font=removed#display-font');
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
  // a fixed message: never the value sent, which a crafted form could fill with anything
  if (!isCurrencyCode(code)) return membersPage(c, { currencyError: c.get('i18n').t('members.currency_error') }, 400);
  await updateSiteSettings(c.env.DB, { currency: code });
  return c.redirect('/settings/users#currency');
});

settings.post('/settings/users', async (c) => {
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const role = body['role'] === 'admin' ? 'admin' : 'member';
  const { t } = c.get('i18n');
  const render = (opts: UsersPageExtras) => membersPage(c, opts);

  if (!username) return render({ error: t('members.username_required') });
  // the account and its invite in one batch (§16 #97): a password nobody knows until the link is used, and only the
  // link's hash kept — the link itself is shown on this response, once
  const token = newLinkToken();
  if (!(await createInvitedUser(c.env.DB, { username, role, passwordHash: await unusablePasswordHash() }, await hashLinkToken(token), LINK_DAYS))) {
    return render({ error: t('members.username_taken', { name: username }) });
  }
  return render({ minted: { username, link: linkUrl(c, token), purpose: 'invite' } });
});

/** A one-time link's full address, on this instance's own origin (§16 #97). */
const linkUrl = (c: Context<AppEnv>, token: string) => `${new URL(c.req.url).origin}/join/${token}`;

settings.post('/settings/users/:id/reset', async (c) => {
  const id = Number(c.req.param('id'));
  // a reset moves the account's sessions on without re-issuing this device's cookie: on the admin's own account it
  // would sign out the device that asked, with the temporary password shown once to a page about to be lost
  if (id === c.get('user').id) return c.text('Change your own password under Account — a reset would sign this device out.', 400);
  const user = await getUserById(c.env.DB, id);
  if (!user) return c.notFound();
  // their password stops working and they are signed out everywhere, in the batch that makes the link (§16 #97)
  const token = newLinkToken();
  const purpose = await resetWithLink(c.env.DB, id, await unusablePasswordHash(), await hashLinkToken(token), LINK_DAYS);
  if (!purpose) return c.notFound();
  return membersPage(c, { minted: { username: user.username, link: linkUrl(c, token), purpose } });
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
