import { Hono } from 'hono';
import {
  createApiToken,
  forgetLoginAttempt,
  getUserById,
  LOGIN_ATTEMPT_WINDOW_MINUTES,
  MAX_API_TOKENS,
  MAX_TOKEN_NAME,
  recordLoginAttempt,
  revokeApiToken,
  setDisplayName,
  setPassword,
  setRecoveryCode,
  setUserLocale,
  signOutOtherDevices,
  userWithTokens,
  answerPairScan,
  createPairCode,
  pairScanFor,
  deleteSession,
  type DeviceRow,
} from '../db/queries';
import type { AppEnv } from '../env';
import { hashLinkToken, hasSessionSecret, hashApiToken, hashPassword, isLinkToken, newApiToken, verifyPassword } from '../lib/auth';
import { formatPairCode, matchChoices, newPairCode, PAIR_MINUTES } from '../lib/pairing';
import { newRecoveryCode } from '../lib/recovery';
import { QR_BLANK } from './shares';
import { ledgerDate } from '../lib/dates';
import { clientIp, newSessionFor, RecoveryCodeBox, setSessionCookie } from './auth';
import { MAX_DISPLAY_NAME, normalizeDisplayName } from '../lib/names';
import { DRAFT_LOCALES, isLocale, LOCALE_NAMES, locales, resolveLocale } from '../i18n';
import { VERSION } from '../version';
import { invalid } from '../views/components';
import { Fill, useI18n } from '../views/i18n';
import { page } from '../views/layout';

const account = new Hono<AppEnv>();

/**
 * The name you go by outside this library (§16 #45): shown on share pages and to connected households only where an
 * admin has switched names on. Your username signs you in and never leaves the app.
 */
const DisplayNameForm = ({ displayName, saved }: { displayName: string | null; saved?: boolean }) => {
  const { t } = useI18n();
  return (
    <article class="panel form-card account-card" id="display-name">
      <p class="eyebrow">{t('account.display_name')}</p>
      {saved ? <p class="notice">{t('account.display_name_saved')}</p> : null}
      <form method="post" action="/account/display-name">
        <label>
          {t('account.display_name')} <small>{t('account.display_name_hint', { max: MAX_DISPLAY_NAME })}</small>
          <input name="displayName" value={displayName ?? ''} maxlength={MAX_DISPLAY_NAME} autocomplete="nickname" />
        </label>
        <button type="submit">{t('account.save_display_name')}</button>
      </form>
      <p class="muted form-note">{t('account.display_name_note')}</p>
    </article>
  );
};

/**
 * The interface language (§16 #93): the household's default, or one of the shipped locales for this member alone.
 * The machine-drafted ones say so, with the strings to download and correct.
 */
const LanguageForm = ({ locale, household, saved }: { locale: string | null; household: string; saved?: boolean }) => {
  const { t } = useI18n();
  const current = locale && isLocale(locale) ? locale : '';
  const drafts = DRAFT_LOCALES.map((l) => LOCALE_NAMES[l]).join(', ');
  return (
    <article class="panel form-card account-card" id="language">
      <p class="eyebrow">{t('account.language')}</p>
      {saved ? <p class="notice">{t('account.language_saved')}</p> : null}
      <form method="post" action="/account/locale" class="switch-form">
        <div class="switch-field">
          <label for="account-locale">{t('account.language_label')}</label>
          <select id="account-locale" name="locale" aria-describedby="language-help">
            <option value="" selected={current === ''}>
              {t('account.language_default', { name: LOCALE_NAMES[resolveLocale(null, { language: household })] })}
            </option>
            {locales.map((l) => (
              <option value={l} selected={current === l}>
                {LOCALE_NAMES[l]}
                {DRAFT_LOCALES.includes(l) ? ` (${t('locale.draft')})` : ''}
              </option>
            ))}
          </select>
        </div>
        <p class="muted" id="language-help">
          <Fill
            text={t('account.language_note')}
            with={{
              drafts,
              download: (
                <>
                  {t('account.download_strings')}
                  {' ('}
                  {DRAFT_LOCALES.map((l, i) => (
                    <>
                      {i ? ', ' : ''}
                      <a href={`/strings/${l}.json`} download={`nalanda-strings-${l}.json`}>
                        {LOCALE_NAMES[l]}
                      </a>
                    </>
                  ))}
                  {')'}
                </>
              ),
            }}
          />
        </p>
        <button type="submit">{t('account.save_language')}</button>
      </form>
    </article>
  );
};

/**
 * Every other device signed out (§16 #70): the one place a member can answer a lost phone or a shared laptop left
 * signed in, without an admin. This device stays in — its cookie is re-issued in the new generation. A password
 * change does the same, and an admin's reset signs a member out everywhere, temporary password in hand.
 */
const DevicesForm = ({ done, devices, current, pair }: { done?: 'out' | 'one'; devices: DeviceRow[]; current: string | null; pair?: PairCode | null }) => {
  const { t } = useI18n();
  return (
    <article class="panel form-card account-card" id="devices">
      <p class="eyebrow">{t('account.devices')}</p>
      {/* a code for another device to sign in with (§16 #99), shown on the response that made it, with its QR */}
      {pair ? (
        <div class="notice pair-code">
          <p>{t('account.pair_code_intro', { url: pair.page })}</p>
          <p class="pair-digits mono">{pair.code}</p>
          <div class="share-qr">
            <img data-qr={pair.url} alt={t('account.pair_qr_alt')} width="512" height="512" src={QR_BLANK} />
          </div>
          <script src="/vendor/qrcode.js" defer></script>
          <script src="/qr.js" defer></script>
        </div>
      ) : null}
      <form method="post" action="/account/pair#devices" class="switch-form">
        <p class="muted">{t('account.pair_note')}</p>
        <button type="submit">{t('account.pair_button')}</button>
      </form>
      {done ? <p class="notice">{t(done === 'one' ? 'account.device_signed_out' : 'account.devices_done')}</p> : null}
      {/* each device signed in (§16 #98): what it is, when it signed in and was last used, and Sign out for any but this one */}
      {devices.length ? (
        <ul class="device-list">
          {devices.map((d) => (
            <li>
              <span>
                <strong>{d.device || t('account.device_unknown')}</strong>
                {d.id === current ? <small class="muted"> · {t('account.this_device')}</small> : null}
                <br />
                <small class="muted">{t('account.device_dates', { signedIn: ledgerDate(d.createdAt), used: ledgerDate(d.lastSeenAt) })}</small>
              </span>
              {d.id === current ? null : (
                <form method="post" action={`/account/devices/${d.id}/sign-out`} class="inline-form">
                  <button type="submit" class="btn" aria-label={t('account.sign_out_device', { device: d.device || t('account.device_unknown'), signedIn: ledgerDate(d.createdAt) })}>
                    {t('account.sign_out')}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {/* as every settings panel reads: the explanation, then the action (.switch-form) */}
      <form method="post" action="/account/sign-out-others" class="switch-form">
        <p class="muted">{t('account.devices_note')}</p>
        <button type="submit">{t('account.sign_out_others')}</button>
      </form>
    </article>
  );
};

/**
 * A member's read-only API tokens (§16 #88): made here, shown once — on this page, never in a URL — and revoked here.
 * Every path that moves the account's generation on deletes them, so each one listed works.
 */
const TokensForm = ({ tokens, fresh, error }: { tokens: Array<{ id: number; name: string; createdAt: string }>; fresh?: { name: string; token: string } | null; error?: string }) => {
  const { t } = useI18n();
  return (
    <article class="panel form-card account-card" id="tokens">
      <p class="eyebrow">{t('account.tokens')}</p>
      {fresh ? (
        <div class="notice token-fresh">
          <p>
            <Fill text={t('account.token_fresh')} with={{ name: <strong>{fresh.name}</strong> }} />
          </p>
          <p>
            <code class="mono break-anywhere token-secret">{fresh.token}</code>
          </p>
          <p class="muted">
            <Fill text={t('account.token_usage')} with={{ header: <code>Authorization: Bearer {'<token>'}</code>, path: <code>/api/v1/…</code> }} />
          </p>
        </div>
      ) : null}
      {error ? (
        <p class="error" role="alert">
          {error}
        </p>
      ) : null}
      {tokens.length ? (
        <ul class="token-list">
          {tokens.map((tk) => (
            <li>
              <span>
                <strong>{tk.name}</strong> <small class="muted">· {t('account.token_made', { date: ledgerDate(tk.createdAt) })}</small>
              </span>
              <form method="post" action={`/account/tokens/${tk.id}/revoke`} class="inline-form">
                <button type="submit" class="btn-danger">
                  {t('account.revoke')}
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">
          <Fill text={t('account.no_tokens')} with={{ runbook: <a href="https://github.com/isstiaung/nalanda/blob/main/runbooks/api.md">runbooks/api.md</a> }} />
        </p>
      )}
      {tokens.length < MAX_API_TOKENS ? (
        <form method="post" action="/account/tokens" class="inline-form">
          <input name="name" placeholder={t('account.token_name_placeholder')} aria-label={t('account.token_name')} required maxlength={MAX_TOKEN_NAME} />
          <button type="submit">{t('account.make_token')}</button>
        </form>
      ) : (
        <p class="muted">{t('account.tokens_full', { max: MAX_API_TOKENS })}</p>
      )}
      <p class="muted form-note">{t('account.tokens_note')}</p>
    </article>
  );
};

/**
 * An admin's recovery code (§16 #100): when it was made, never the code — that is shown once, on the response that made
 * it — and a new one in its place, for the account's password: whoever holds only a session can't make one, since a code
 * outlives a password change and "Sign out other devices".
 */
type RecoveryPanel = { made: string | null; fresh?: string | null; error?: string };
const RecoveryForm = ({ made, fresh, error }: RecoveryPanel) => {
  const { t } = useI18n();
  return (
    <article class="panel form-card account-card" id="recovery">
      <p class="eyebrow">{t('recovery.title')}</p>
      {fresh ? <RecoveryCodeBox code={fresh} /> : null}
      <p class="muted">{made ? t('recovery.made', { date: ledgerDate(made) }) : t('recovery.none')}</p>
      {error ? (
        <p class="error" role="alert" id="recovery-error">
          {error}
        </p>
      ) : null}
      <form method="post" action="/account/recovery#recovery">
        <label>
          {t('recovery.password')}
          <input type="password" name="current" required autocomplete="current-password" {...invalid(error, 'recovery-error')} />
        </label>
        <button type="submit">{t(made ? 'recovery.make_new' : 'recovery.make')}</button>
      </form>
    </article>
  );
};

/** Which field a refused password change is about, so its message is tied to that field. */
type PasswordField = 'current' | 'next' | 'confirm';

const Form = ({
  mustChange,
  error,
  errorField,
  ok,
  displayName,
  nameSaved,
  locale,
  household,
  languageSaved,
  devicesDone,
  devices,
  current,
  pair,
  recovery,
  tokens,
  freshToken,
  tokenError,
}: {
  mustChange: boolean;
  error?: string;
  errorField?: PasswordField;
  ok?: boolean;
  displayName?: string | null;
  nameSaved?: boolean;
  locale?: string | null;
  household?: string;
  languageSaved?: boolean;
  devicesDone?: 'out' | 'one';
  devices?: DeviceRow[];
  current?: string | null;
  pair?: PairCode | null;
  recovery?: RecoveryPanel | null; // admins only
  tokens?: Array<{ id: number; name: string; createdAt: string }>; // none on a refused password change: the section is below it
  freshToken?: { name: string; token: string } | null;
  tokenError?: string;
}) => {
  const { t } = useI18n();
  return (
    <>
      <div class="page-head">
        <h1>{t('account.title')}</h1>
      </div>
      <article class="panel form-card account-card">
        <p class="eyebrow">{t('account.password')}</p>
        {mustChange ? <p class="notice">{t('account.must_change')}</p> : null}
        {error ? (
          <p class="error" role="alert" id="password-error">
            {error}
          </p>
        ) : null}
        {ok ? <p class="notice">{t('account.changed')}</p> : null}
        <form method="post" action="/account/password">
          <label>
            {t('account.current')}
            <input type="password" name="current" required autocomplete="current-password" {...invalid(errorField === 'current' && error, 'password-error')} />
          </label>
          <label>
            {t('account.new')} <small>{t('account.new_hint')}</small>
            <input type="password" name="next" required minlength={8} autocomplete="new-password" {...invalid(errorField === 'next' && error, 'password-error')} />
          </label>
          <label>
            {t('account.confirm')}
            <input type="password" name="confirm" required autocomplete="new-password" {...invalid(errorField === 'confirm' && error, 'password-error')} />
          </label>
          <button type="submit">{t('account.change')}</button>
        </form>
      </article>
      {mustChange ? null : <DisplayNameForm displayName={displayName ?? null} saved={nameSaved} />}
      {mustChange ? null : <LanguageForm locale={locale ?? null} household={household ?? 'en'} saved={languageSaved} />}
      {mustChange ? null : <DevicesForm done={devicesDone} devices={devices ?? []} current={current ?? null} pair={pair} />}
      {mustChange || !recovery ? null : <RecoveryForm {...recovery} />}
      {mustChange ? null : <TokensForm tokens={tokens ?? []} fresh={freshToken} error={tokenError} />}
      <p class="muted version-line">
        Nalanda <span class="mono">v{VERSION}</span> ·{' '}
        <a href={`https://github.com/isstiaung/nalanda/releases/tag/v${VERSION}`}>{t('account.release_notes')}</a>
      </p>
    </>
  );
};

/** The Account page, with the member's tokens — and, right after one is made, the token itself, this once (§16 #88). */
async function accountPage(
  c: Parameters<typeof page>[0],
  extras: { freshToken?: { name: string; token: string } | null; tokenError?: string; pair?: PairCode; recovery?: string; recoveryError?: string } = {},
) {
  const user = c.get('user');
  const { displayName, locale, tokens, devices, recoveryMade } = await userWithTokens(c.env.DB, user.id); // one call, as getUserById was
  const devicesQuery = c.req.query('devices');
  return page(
    c,
    c.get('i18n').t('account.title'),
    <Form
      mustChange={user.mustChangePassword}
      ok={c.req.query('ok') === '1'}
      displayName={displayName}
      nameSaved={c.req.query('name') === 'saved'}
      locale={locale}
      household={c.get('householdLanguage')}
      languageSaved={c.req.query('language') === 'saved'}
      devicesDone={devicesQuery === 'out' || devicesQuery === 'one' ? devicesQuery : undefined}
      devices={devices}
      current={c.get('sessionId')}
      pair={extras.pair ?? null}
      recovery={user.role === 'admin' ? { made: recoveryMade, fresh: extras.recovery ?? null, error: extras.recoveryError } : null}
      tokens={tokens}
      freshToken={extras.freshToken ?? null}
      tokenError={extras.tokenError}
    />,
  );
}

account.get('/account', (c) => accountPage(c));

/** Makes a token (§16 #88): the secret is shown on the page this once, and only its hash is kept. */
account.post('/account/tokens', async (c) => {
  const user = c.get('user');
  if (user.mustChangePassword) return c.redirect('/account');
  const body = await c.req.parseBody();
  const name = String(body['name'] ?? '').trim().slice(0, MAX_TOKEN_NAME);
  const { t } = c.get('i18n');
  if (!name) return accountPage(c, { tokenError: t('account.token_name_required') });
  const token = newApiToken();
  const id = await createApiToken(c.env.DB, user, name, await hashApiToken(token));
  if (id === null) return accountPage(c, { tokenError: t('account.tokens_full', { max: MAX_API_TOKENS }) });
  c.header('cache-control', 'no-store'); // shown this once: never from the back button's cache either
  return accountPage(c, { freshToken: { name, token } });
});

account.post('/account/tokens/:id/revoke', async (c) => {
  const id = c.req.param('id');
  if (/^\d{1,15}$/.test(id)) await revokeApiToken(c.env.DB, c.get('user').id, Number(id));
  return c.redirect('/account#tokens');
});

account.post('/account/display-name', async (c) => {
  const body = await c.req.parseBody();
  await setDisplayName(c.env.DB, c.get('user').id, normalizeDisplayName(body['displayName']));
  return c.redirect('/account?name=saved#display-name');
});

/** The member's own interface language (§16 #93): a shipped locale, or empty to follow the household's. */
account.post('/account/locale', async (c) => {
  const body = await c.req.parseBody();
  const raw = typeof body['locale'] === 'string' ? body['locale'].trim() : '';
  if (raw !== '' && !isLocale(raw)) return c.text('Choose a language from the list.', 400);
  await setUserLocale(c.env.DB, c.get('user').id, raw === '' ? null : raw);
  return c.redirect('/account?language=saved#language');
});

account.post('/account/password', async (c) => {
  const sessionUser = c.get('user');
  const user = await getUserById(c.env.DB, sessionUser.id);
  if (!user) return c.redirect('/login');
  const body = await c.req.parseBody();
  const current = String(body['current'] ?? '');
  const next = String(body['next'] ?? '');
  const confirm = String(body['confirm'] ?? '');
  const { t } = c.get('i18n');
  const title = t('account.title');

  // The current password is checked under login's throttle (ARCH.md §8), by address and by this account: whoever
  // holds a session cookie could otherwise guess at the password itself without limit, and a right guess would sign
  // the owner out everywhere. Counted before the check, as at login; a right password takes its row back.
  const attempt = await recordLoginAttempt(c.env.DB, clientIp(c), user.username);
  if (!attempt) {
    c.status(429);
    return page(c, title, <Form mustChange={user.mustChangePassword} error={t('login.too_many', { minutes: LOGIN_ATTEMPT_WINDOW_MINUTES })} />);
  }
  if (!(await verifyPassword(current, user.passwordHash))) {
    return page(c, title, <Form mustChange={user.mustChangePassword} error={t('account.wrong_current')} errorField="current" />);
  }
  await forgetLoginAttempt(c.env.DB, attempt);
  if (next.length < 8) {
    return page(c, title, <Form mustChange={user.mustChangePassword} error={t('account.too_short')} errorField="next" />);
  }
  if (next !== confirm) {
    return page(c, title, <Form mustChange={user.mustChangePassword} error={t('account.mismatch')} errorField="confirm" />);
  }
  // the new password signs every other device out (§16 #70); this one carries on, in the generation the row is in now
  const ns = await newSessionFor(c);
  const account = await setPassword(c.env.DB, user.id, await hashPassword(next), false, ns);
  if (!account || !hasSessionSecret(c.env.SESSION_SECRET)) return c.redirect('/login');
  await setSessionCookie(c, c.env.SESSION_SECRET, account, ns.sid);
  return c.redirect(user.mustChangePassword ? '/' : '/account?ok=1');
});

/**
 * A new recovery code (§16 #100), admins only, for the account's password — checked under login's throttle, as a password
 * change is — and shown on the page this once; the old one stops working.
 */
account.post('/account/recovery', async (c) => {
  const sessionUser = c.get('user');
  const { t } = c.get('i18n');
  if (sessionUser.role !== 'admin') return c.text(t('recovery.admins_only'), 403);
  const user = await getUserById(c.env.DB, sessionUser.id);
  if (!user) return c.redirect('/login');
  const current = String((await c.req.parseBody())['current'] ?? '');
  const attempt = await recordLoginAttempt(c.env.DB, clientIp(c), user.username);
  if (!attempt) {
    c.status(429);
    return accountPage(c, { recoveryError: t('login.too_many', { minutes: LOGIN_ATTEMPT_WINDOW_MINUTES }) });
  }
  if (!(await verifyPassword(current, user.passwordHash))) return accountPage(c, { recoveryError: t('account.wrong_current') });
  await forgetLoginAttempt(c.env.DB, attempt);
  const code = newRecoveryCode();
  if (!(await setRecoveryCode(c.env.DB, user.id, await hashLinkToken(code)))) return c.redirect('/login');
  return accountPage(c, { recovery: code });
});

/** Signs the account out everywhere but this device (§16 #70): the generation moves on, and this cookie moves with it. */
account.post('/account/sign-out-others', async (c) => {
  const ns = await newSessionFor(c);
  const account = await signOutOtherDevices(c.env.DB, c.get('user').id, ns);
  if (!account || !hasSessionSecret(c.env.SESSION_SECRET)) return c.redirect('/login');
  await setSessionCookie(c, c.env.SESSION_SECRET, account, ns.sid);
  return c.redirect('/account?devices=out#devices');
});

/** A code just made for another device (§16 #99): as shown, the page to type it on, and the address its QR opens. */
type PairCode = { code: string; page: string; url: string };

/** A code for another device to sign in with (§16 #99): shown here once, its hash kept, for PAIR_MINUTES. */
account.post('/account/pair', async (c) => {
  const user = c.get('user');
  const code = newPairCode();
  await createPairCode(c.env.DB, user, await hashLinkToken(code), PAIR_MINUTES);
  const origin = new URL(c.req.url).origin;
  c.header('cache-control', 'no-store');
  return accountPage(c, { pair: { code: formatPairCode(code), page: `${origin}/pair`, url: `${origin}/pair?code=${code}` } });
});

/** What a phone shows when it scans a new device's QR (§16 #99): which device is asking, and the three numbers to pick from. */
const ApprovePage = ({ token, device, choices, name }: { token: string; device: string; choices: string[]; name: string }) => {
  const { t } = useI18n();
  return (
    <article class="panel form-card account-card">
      <h1>{t('pair.approve_title')}</h1>
      <p>{t('pair.approve_intro', { device: device || t('account.device_unknown'), name })}</p>
      <form method="post" action={`/pair/approve/${token}`}>
        <fieldset>
          <legend>{t('pair.pick')}</legend>
          <div class="pair-choices">
            {choices.map((n) => (
              <button type="submit" name="pick" value={n} class="btn mono" aria-label={t('pair.pick_one', { digits: n })}>
                {n}
              </button>
            ))}
          </div>
        </fieldset>
        <button type="submit" name="pick" value="" class="btn-danger">
          {t('pair.cancel')}
        </button>
      </form>
    </article>
  );
};

/** Where an answered or lapsed request leaves the phone. */
const ApproveResult = ({ outcome }: { outcome: 'approved' | 'wrong' | 'cancelled' | 'gone' }) => {
  const { t } = useI18n();
  const text = { approved: 'pair.approved', wrong: 'pair.wrong', cancelled: 'pair.cancelled', gone: 'pair.gone' } as const;
  return (
    <article class="panel form-card account-card">
      <h1>{t(outcome === 'gone' ? 'pair.gone_title' : 'pair.approve_title')}</h1>
      {outcome === 'approved' ? (
        <p>
          <output aria-live="polite">{t(text[outcome])}</output>
        </p>
      ) : (
        <p role="alert">{t(text[outcome])}</p>
      )}
      <p>
        <a href="/account#devices">{t('pair.to_devices')}</a>
      </p>
    </article>
  );
};

account.get('/pair/approve/:token', async (c) => {
  c.header('cache-control', 'no-store');
  const token = c.req.param('token');
  const hash = isLinkToken(token) ? await hashLinkToken(token) : '';
  const found = hash ? await pairScanFor(c.env.DB, hash) : null;
  const { t } = c.get('i18n');
  if (!found) {
    c.status(410);
    return page(c, t('pair.gone_title'), <ApproveResult outcome="gone" />);
  }
  return page(c, t('pair.approve_title'), <ApprovePage token={token} device={found.device} choices={matchChoices(found.matchDigits, hash)} name={c.get('user').username} />);
});

account.post('/pair/approve/:token', async (c) => {
  const token = c.req.param('token');
  const { t } = c.get('i18n');
  if (!isLinkToken(token)) {
    c.status(410);
    return page(c, t('pair.gone_title'), <ApproveResult outcome="gone" />);
  }
  const pick = String((await c.req.parseBody())['pick'] ?? '');
  const hash = await hashLinkToken(token);
  const open = await pairScanFor(c.env.DB, hash);
  if (!open) {
    c.status(410);
    return page(c, t('pair.gone_title'), <ApproveResult outcome="gone" />);
  }
  // the right digits approve it for this account; the wrong ones, or Cancel, end the request — nothing is signed in
  const approved = await answerPairScan(c.env.DB, hash, c.get('user'), /^\d{2}$/.test(pick) ? pick : null);
  return page(c, t('pair.approve_title'), <ApproveResult outcome={approved ? 'approved' : pick ? 'wrong' : 'cancelled'} />);
});

/** Signs one other device out (§16 #98): the member's own session, by its id; that device's cookie signs nobody in after. */
account.post('/account/devices/:sid/sign-out', async (c) => {
  const sid = c.req.param('sid');
  // this device signs out with Log out, which also clears its cookie and cache: not here; and only the member's own,
  // and only one that was there, says so
  const ended = sid !== c.get('sessionId') && (await deleteSession(c.env.DB, c.get('user').id, sid));
  return c.redirect(ended ? '/account?devices=one#devices' : '/account#devices');
});

export default account;
