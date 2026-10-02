import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  accountLinkFor,
  countUsers,
  createFirstAdmin,
  createSession,
  deleteSession,
  ensureSessionKey,
  forgetLoginAttempt,
  getUserByUsername,
  LOGIN_ATTEMPT_WINDOW_MINUTES,
  claimPairScan,
  createPairScan,
  pairScanStatus,
  recordLoginAttempt,
  recoverWithCode,
  recoveryCodeOpens,
  redeemPairCode,
  useAccountLink,
  type NewSession,
} from '../db/queries';
import type { AppEnv } from '../env';
import {
  createSessionToken,
  DUMMY_HASH,
  hasSessionSecret,
  hashLinkToken,
  hashPassword,
  isLinkToken,
  isSessionKey,
  newLinkToken,
  newSessionId,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifyPassword,
  verifySessionToken,
  type SessionRef,
} from '../lib/auth';
import { deviceName } from '../lib/devices';
import { formatPairCode, newMatchDigits, normalizePairCode, PAIR_MINUTES } from '../lib/pairing';
import { formatRecoveryCode, newRecoveryCode, normalizeRecoveryCode } from '../lib/recovery';
import { QR_BLANK } from './shares';
import { invalid } from '../views/components';
import { useI18n } from '../views/i18n';
import { Brand, i18nOf, page, partial } from '../views/layout';

const auth = new Hono<AppEnv>();

/**
 * Signs this account in on this device (§16 #98): a session row named after the browser, then a cookie naming its id,
 * the account's id, session key (§16 #56) and generation (§16 #70).
 */
export async function signIn(c: Context<AppEnv>, secret: string, account: SessionRef): Promise<void> {
  const ns = await newSessionFor(c);
  await createSession(c.env.DB, account, ns);
  await setSessionCookie(c, secret, account, ns.sid);
}

/**
 * The device session this request will start (§16 #98): a new id, this browser's name, and the session its cookie named
 * until now — which ends as this one starts, so signing in again on a browser never leaves the old session behind.
 * A batch that makes or moves the account takes it (startSession() in queries.ts), so the device that asked is signed
 * in by the same write; setSessionCookie() then sends the cookie.
 */
export async function newSessionFor(c: Context<AppEnv>): Promise<NewSession> {
  const held = await verifySessionToken(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), Math.floor(Date.now() / 1000));
  return { sid: newSessionId(), device: deviceName(c.req.header('user-agent')), replaces: held?.sid ?? null };
}

/** The session cookie on this response, good for SESSION_TTL_SECONDS from now: at sign-in, and as a used session slides. */
export async function setSessionCookie(c: Context<AppEnv>, secret: string, account: SessionRef, sid: string): Promise<void> {
  const token = await createSessionToken(secret, account, Math.floor(Date.now() / 1000), sid);
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:', // plain http only for local dev, where Secure would drop it
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** `fieldsWrong`: whether the error is about what was typed (a wrong password) rather than about waiting. */
const LoginForm = ({ error, note, fieldsWrong = true }: { error?: string; note?: string; fieldsWrong?: boolean }) => {
  const { t } = useI18n();
  return (
    <article class="auth-card">
      <Brand />
      <h1>{t('login.title')}</h1>
      {note ? <p class="notice">{note}</p> : null}
      {error ? (
        <p class="error" role="alert" id="login-error">
          {error}
        </p>
      ) : null}
      <form method="post" action="/auth/login">
        <label>
          {t('login.username')}
          {/* eslint-disable-next-line no-restricted-syntax -- the login page is one form: its first field is where everyone starts */}
          <input name="username" required autofocus autocomplete="username" {...invalid(fieldsWrong && error, 'login-error')} />
        </label>
        <label>
          {t('login.password')}
          <input type="password" name="password" required autocomplete="current-password" {...invalid(fieldsWrong && error, 'login-error')} />
        </label>
        <button type="submit">{t('login.submit')}</button>
      </form>
      <p class="form-note">
        <a href="/recover">{t('login.forgot')}</a>
      </p>
      {/* or from a device already signed in (§16 #99): a code it shows, or a QR this one shows for a phone to scan */}
      <div class="pair-ways">
        <a href="/pair">{t('login.with_code')}</a>
        <form method="post" action="/pair/scan" class="inline-form">
          <button type="submit" class="btn">
            {t('login.with_phone')}
          </button>
        </form>
      </div>
    </article>
  );
};

// Without a session secret nobody can be signed in: the cookie is signed with it. Setup and login say so before
// they write anything. (An empty one once let setup create the admin and then fail on signing — which closed
// setup, and login failed the same way.)
const NoSessionSecret = ({ note }: { note?: string }) => (
  <article class="auth-card">
    <Brand />
    <h1>Not ready yet</h1>
    <p class="error">
      This Nalanda has no <code>SESSION_SECRET</code>, so nobody can sign in.{note ? ` ${note}` : ''}
    </p>
    <p class="eyebrow">Whoever runs it sets one</p>
    <p>
      From the project folder, run <code>npx wrangler secret put SESSION_SECRET</code> and paste a long random value
      (<code>openssl rand -base64 32</code> makes one).
    </p>
    <p>
      Or in the Cloudflare dashboard: the Worker → <strong>Settings</strong> → <strong>Variables and Secrets</strong>{' '}
      → add a secret named <code>SESSION_SECRET</code>.
    </p>
    <p class="muted">
      Then reload this page. Running it locally? Put it in <code>.dev.vars</code> and restart <code>npm run dev</code>.
    </p>
  </article>
);

function noSessionSecret(c: Context<AppEnv>, note?: string) {
  c.status(503);
  return page(c, 'Not ready yet', <NoSessionSecret note={note} />);
}

// Setup's note says what to do once the secret is set. An account may already exist — the old failure above made
// it — and then setup will be gone: log in with the password chosen for it. A database that can't be read (never
// migrated) still gets the explanation, with the plain note.
async function setupWithoutSecret(c: Context<AppEnv>, posted: boolean) {
  const accountExists = await countUsers(c.env.DB).then((n) => n > 0, () => false);
  if (accountExists) return noSessionSecret(c, 'An account already exists: once it is set, log in with it.');
  return noSessionSecret(c, posted ? 'Nothing was saved: set it, then create the account again.' : undefined);
}

auth.get('/login', async (c) => {
  if (!hasSessionSecret(c.env.SESSION_SECRET)) return noSessionSecret(c);
  if ((await countUsers(c.env.DB)) === 0) return c.redirect('/setup');
  const { t } = await i18nOf(c); // the household's language: nobody is signed in yet (§16 #93)
  // a setup that lost the race to another (below) lands here
  const note = c.req.query('raced') === undefined ? undefined : t('login.raced');
  return page(c, t('login.title'), <LoginForm note={note} />);
});

/** The lockout, as the login page and Account both answer it: the sentence, and 429 so a script can tell it from a wrong guess. */
export const TOO_MANY_ATTEMPTS = `Too many attempts — try again in ${LOGIN_ATTEMPT_WINDOW_MINUTES} minutes.`;

/** Where a request comes from, for throttling: Cloudflare's header, or "local" under `wrangler dev`. */
export const clientIp = (c: Context<AppEnv>): string => c.req.header('cf-connecting-ip') ?? 'local';

auth.post('/auth/login', async (c) => {
  const secret = c.env.SESSION_SECRET;
  if (!hasSessionSecret(secret)) return noSessionSecret(c);
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const password = String(body['password'] ?? '');
  // Counted before the password is checked, in the statement that counts (ARCH.md §8): ten failures in ten minutes
  // from this address, or at this account from anywhere, and the guess isn't checked at all — the right password
  // included, until they age out.
  const attempt = await recordLoginAttempt(c.env.DB, clientIp(c), username);
  const { t } = await i18nOf(c);
  if (!attempt) {
    c.status(429);
    return page(c, t('login.title'), <LoginForm error={t('login.too_many', { minutes: LOGIN_ATTEMPT_WINDOW_MINUTES })} fieldsWrong={false} />);
  }
  const user = username ? await getUserByUsername(c.env.DB, username) : null;
  // a name nobody has is checked against a fixed hash: the answer takes as long either way, and says nothing about
  // which usernames exist
  const ok = (await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH)) && user !== null;
  if (!user || !ok) return page(c, t('login.title'), <LoginForm error={t('login.wrong')} />);
  await forgetLoginAttempt(c.env.DB, attempt); // no failure: a login counts towards nobody's ten
  // an account restored from an older backup, or added by hand, has no key yet: it gets one now
  const account = isSessionKey(user.sessionKey) ? user : await ensureSessionKey(c.env.DB, user.id);
  if (!account) return page(c, t('login.title'), <LoginForm error={t('login.wrong')} />);
  await signIn(c, secret, account);
  return c.redirect('/');
});

auth.post('/auth/logout', async (c) => {
  // this device's session goes with its cookie (§16 #98): a copy of the cookie kept anywhere signs nobody in after this
  const session = await verifySessionToken(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), Math.floor(Date.now() / 1000));
  if (session?.sid) await deleteSession(c.env.DB, session.userId, session.sid);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  // the browser's cache of this origin goes with the session (signed-in pages are no-store, this is for whatever a
  // browser kept anyway); app.js empties the device's scan queue on the same click (§16 #48)
  c.header('Clear-Site-Data', '"cache"');
  return c.redirect('/login');
});

// ---- a one-time link (ARCH.md §16 #97): where an invited member, or one whose password was reset, chooses theirs ----

type JoinField = 'password' | 'confirm';

/** The form a live link opens: whose account it is (shown, and offered to a password manager), and the new password. */
const JoinForm = ({ token, username, purpose, error, wrong = [] }: { token: string; username: string; purpose: 'invite' | 'reset'; error?: string; wrong?: JoinField[] }) => {
  const { t } = useI18n();
  return (
    <article class="auth-card">
      <Brand />
      <h1>{t(purpose === 'invite' ? 'join.title_invite' : 'join.title_reset')}</h1>
      <p class="muted">{t(purpose === 'invite' ? 'join.intro_invite' : 'join.intro_reset', { name: username })}</p>
      {error ? (
        <p class="error" role="alert" id="join-error">
          {error}
        </p>
      ) : null}
      <form method="post" action={`/join/${token}`}>
        <label>
          {t('login.username')}
          <input name="username" value={username} readonly autocomplete="username" />
        </label>
        <label>
          {t('login.password')} <small>{t('setup.password_hint')}</small>
          {/* eslint-disable-next-line no-restricted-syntax -- the page is one form, opened to do one thing: choose a password */}
          <input type="password" name="password" required minlength={8} autofocus autocomplete="new-password" {...invalid(wrong.includes('password') && error, 'join-error')} />
        </label>
        <label>
          {t('setup.confirm')}
          <input type="password" name="confirm" required autocomplete="new-password" {...invalid(wrong.includes('confirm') && error, 'join-error')} />
        </label>
        <button type="submit">{t('join.submit')}</button>
      </form>
    </article>
  );
};

/** What a link that no longer works opens: why, and where to go. Says nothing about whose it was. */
const LinkGone = () => {
  const { t } = useI18n();
  return (
    <article class="auth-card">
      <Brand />
      <h1>{t('join.gone_title')}</h1>
      <p>{t('join.gone')}</p>
      <p>
        <a href="/login">{t('join.to_login')}</a>
      </p>
    </article>
  );
};

/**
 * A link's page, never kept by the browser — it carries a secret in its address, and the session middleware's no-store
 * doesn't reach this side of it — and the account the link opens, or the page saying it no longer works.
 */
async function linkPage(c: Context<AppEnv>, token: string) {
  c.header('cache-control', 'no-store');
  const account = isLinkToken(token) ? await accountLinkFor(c.env.DB, await hashLinkToken(token)) : null;
  if (!account) {
    c.status(410);
    return { account: null, gone: page(c, (await i18nOf(c)).t('join.gone_title'), <LinkGone />) };
  }
  return { account, gone: null };
}

auth.get('/join/:token', async (c) => {
  const token = c.req.param('token');
  const { account, gone } = await linkPage(c, token);
  if (!account) return gone;
  return page(c, (await i18nOf(c)).t(account.purpose === 'invite' ? 'join.title_invite' : 'join.title_reset'), (
    <JoinForm token={token} username={account.username} purpose={account.purpose} />
  ));
});

auth.post('/join/:token', async (c) => {
  const secret = c.env.SESSION_SECRET;
  if (!hasSessionSecret(secret)) return noSessionSecret(c);
  const token = c.req.param('token');
  // the link first, before any hashing: a request for a dead or made-up link costs a lookup, never a PBKDF2
  const { account, gone } = await linkPage(c, token);
  if (!account) return gone;
  const body = await c.req.parseBody();
  const password = String(body['password'] ?? '');
  const confirm = String(body['confirm'] ?? '');
  const { t } = await i18nOf(c);
  const form = (error: string, wrong: JoinField[]) =>
    page(c, t(account.purpose === 'invite' ? 'join.title_invite' : 'join.title_reset'), (
      <JoinForm token={token} username={account.username} purpose={account.purpose} error={error} wrong={wrong} />
    ));
  if (password.length < 8) return form(t('join.too_short'), ['password']);
  if (password !== confirm) return form(t('setup.mismatch'), ['confirm']);
  // the batch decides (§16 #97): the link is found again inside it, so of two uses racing, one sets the password
  const ns = await newSessionFor(c);
  const signedIn = await useAccountLink(c.env.DB, await hashLinkToken(token), await hashPassword(password), ns);
  if (!signedIn) {
    c.status(410);
    return page(c, t('join.gone_title'), <LinkGone />);
  }
  await setSessionCookie(c, secret, signedIn, ns.sid);
  return c.redirect('/');
});

// ---- signing in from another device (ARCH.md §16 #99): the new device's side — a code typed, or a QR shown ----

/** The new device's half of a scan: its poll secret, on this path alone, for as long as the request is open. */
const PAIR_COOKIE = 'nalanda_pair';

/** A code typed: a guess at a credential, so it counts with the address's failed logins — ten in ten minutes between
 *  them — by the address alone: a code names no account, and nobody elsewhere can add to an address's count. Taken back
 *  when the code works, as a login's is. */
const pairAttempt = (c: Context<AppEnv>) => recordLoginAttempt(c.env.DB, clientIp(c), null);

/** A scan request opened: a row anyone may make, so ten an address in ten minutes — counted apart from logins (its own
 *  address column, which only this route writes), so tapping "Sign in with your phone" never uses up a household's
 *  password tries, behind one router's address. */
const scanAttempt = (c: Context<AppEnv>) => recordLoginAttempt(c.env.DB, `#scan:${clientIp(c)}`, null);

const CodeForm = ({ code, error }: { code?: string; error?: string }) => {
  const { t } = useI18n();
  return (
    <article class="auth-card">
      <Brand />
      <h1>{t('pair.code_title')}</h1>
      <p class="muted">{t('pair.code_intro')}</p>
      {error ? (
        <p class="error" role="alert" id="pair-error">
          {error}
        </p>
      ) : null}
      <form method="post" action="/pair">
        <label>
          {t('pair.code_label')}
          {/* eslint-disable-next-line no-restricted-syntax -- the page is one field, opened to type one code */}
          <input name="code" value={code ?? ''} required autofocus autocomplete="one-time-code" autocapitalize="characters" spellcheck={false} class="mono" {...invalid(error, 'pair-error')} />
        </label>
        <button type="submit">{t('pair.code_submit')}</button>
      </form>
      <p>
        <a href="/login">{t('pair.back_to_login')}</a>
      </p>
    </article>
  );
};

auth.get('/pair', async (c) => {
  c.header('cache-control', 'no-store');
  // a QR from Account opens this with the code filled in; it signs nobody in until the form is sent
  const code = normalizePairCode(c.req.query('code'));
  return page(c, (await i18nOf(c)).t('pair.code_title'), <CodeForm code={code ? formatPairCode(code) : ''} />);
});

auth.post('/pair', async (c) => {
  const secret = c.env.SESSION_SECRET;
  if (!hasSessionSecret(secret)) return noSessionSecret(c);
  c.header('cache-control', 'no-store');
  const { t } = await i18nOf(c);
  const typed = String((await c.req.parseBody())['code'] ?? '');
  // what can't be a code is answered before the throttle: a typo costs no try
  const code = normalizePairCode(typed);
  if (!code) return page(c, t('pair.code_title'), <CodeForm code={typed} error={t('pair.code_wrong')} />);
  const attempt = await pairAttempt(c);
  if (!attempt) {
    c.status(429);
    return page(c, t('pair.code_title'), <CodeForm code={typed} error={t('login.too_many', { minutes: LOGIN_ATTEMPT_WINDOW_MINUTES })} />);
  }
  // one batch: the session, the code gone, and the try taken back if it worked (§16 #39)
  const ns = await newSessionFor(c);
  const account = await redeemPairCode(c.env.DB, await hashLinkToken(code), ns, attempt);
  if (!account) return page(c, t('pair.code_title'), <CodeForm code={typed} error={t('pair.code_wrong')} />);
  await setSessionCookie(c, secret, account, ns.sid);
  return c.redirect('/');
});

/**
 * What the new device shows while it waits: htmx asks every two seconds, and the answer is nothing (204, which htmx
 * leaves alone) until the request is approved — a redirect into the app — or over, when this is swapped for saying so.
 * Nothing in it takes focus, and the live region isn't made anew on every poll. `request` is the start of the request's
 * poll hash, nothing secret: a newer request in another tab replaced the cookie, and this one then says it's over.
 */
const PairWaiting = ({ request }: { request: string }) => {
  const { t } = useI18n();
  return (
    <form hx-get={`/pair/scan/status?r=${request}`} hx-trigger="every 2s" hx-swap="outerHTML" class="pair-waiting">
      <output aria-live="polite">{t('pair.waiting')}</output>
      <noscript>
        <p>
          {t('pair.needs_script')} <a href="/pair">{t('login.with_code')}</a>
        </p>
      </noscript>
    </form>
  );
};

/** What a waiting page shows of its request: enough of the poll hash to tell it from a newer one, and nothing secret. */
const requestTag = (pollHash: string): string => pollHash.slice(0, 12);

/** A request that is over: expired, declined, or answered wrongly on the phone. */
const PairGone = () => {
  const { t } = useI18n();
  return (
    <div class="pair-waiting">
      <p role="alert">{t('pair.expired')}</p>
      <p>
        <a href="/login">{t('pair.back_to_login')}</a>
      </p>
    </div>
  );
};

const ScanPage = ({ approveUrl, digits, request }: { approveUrl: string | null; digits: string | null; request: string }) => {
  const { t } = useI18n();
  return (
    <article class="auth-card">
      <Brand />
      <h1>{t('pair.scan_title')}</h1>
      {digits ? (
        <>
          <p class="muted">{t('pair.scan_intro')}</p>
          {approveUrl ? (
            <div class="share-qr pair-qr">
              <img data-qr={approveUrl} alt={t('pair.qr_alt')} width="512" height="512" src={QR_BLANK} />
            </div>
          ) : null}
          <p class="pair-digits-label">{t('pair.digits_label')}</p>
          <p class="pair-digits mono">{digits}</p>
          <PairWaiting request={request} />
          <script src="/vendor/qrcode.js" defer></script>
          <script src="/qr.js" defer></script>
        </>
      ) : (
        <PairGone />
      )}
    </article>
  );
};

auth.post('/pair/scan', async (c) => {
  if (!hasSessionSecret(c.env.SESSION_SECRET)) return noSessionSecret(c);
  c.header('cache-control', 'no-store');
  const { t } = await i18nOf(c);
  if (!(await scanAttempt(c))) {
    c.status(429);
    return page(c, t('login.title'), <LoginForm error={t('login.too_many', { minutes: LOGIN_ATTEMPT_WINDOW_MINUTES })} fieldsWrong={false} />);
  }
  // three secrets of this request: the cookie this device polls with, the QR the phone scans, and the digits to match
  const poll = newLinkToken();
  const pollHash = await hashLinkToken(poll);
  const approve = newLinkToken();
  const digits = newMatchDigits();
  await createPairScan(c.env.DB, { pollHash, approveHash: await hashLinkToken(approve), matchDigits: digits, device: deviceName(c.req.header('user-agent')) }, PAIR_MINUTES);
  setCookie(c, PAIR_COOKIE, poll, {
    path: '/pair',
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: PAIR_MINUTES * 60,
  });
  return page(c, t('pair.scan_title'), <ScanPage approveUrl={`${new URL(c.req.url).origin}/pair/approve/${approve}`} digits={digits} request={requestTag(pollHash)} />);
});

auth.get('/pair/scan/status', async (c) => {
  c.header('cache-control', 'no-store');
  const htmx = !!c.req.header('HX-Request');
  const poll = getCookie(c, PAIR_COOKIE);
  const pollHash = poll && isLinkToken(poll) ? await hashLinkToken(poll) : null;
  const { t } = await i18nOf(c);
  const over = () => (htmx ? partial(c, <PairGone />) : page(c, t('pair.scan_title'), <ScanPage approveUrl={null} digits={null} request="" />));
  // a page whose request a newer one replaced (another tab took the cookie): over, the cookie left to the newer one
  const asked = c.req.query('r');
  if (asked && (!pollHash || requestTag(pollHash) !== asked)) return over();
  const status = pollHash ? await pairScanStatus(c.env.DB, pollHash) : ({ state: 'gone' } as const);
  const secret = c.env.SESSION_SECRET;
  if (status.state === 'approved' && pollHash && hasSessionSecret(secret)) {
    const ns = await newSessionFor(c);
    const account = await claimPairScan(c.env.DB, pollHash, ns);
    if (account) {
      await setSessionCookie(c, secret, account, ns.sid);
      deleteCookie(c, PAIR_COOKIE, { path: '/pair' });
      if (!htmx) return c.redirect('/');
      c.header('HX-Redirect', '/');
      return c.body(null);
    }
  }
  // still waiting: nothing to swap
  if (status.state === 'waiting') return htmx ? c.body(null, 204) : page(c, t('pair.scan_title'), <ScanPage approveUrl={null} digits={status.matchDigits} request={requestTag(pollHash!)} />);
  deleteCookie(c, PAIR_COOKIE, { path: '/pair' });
  return over();
});

// ---- an admin's recovery code (ARCH.md §16 #100): shown at setup, used at /recover, made again on Account ----

/** A recovery code, the once it is shown: easy to select whole, and to read back in fours. */
export const RecoveryCodeBox = ({ code }: { code: string }) => {
  const { t } = useI18n();
  return (
    <div class="notice recovery-code">
      <p class="recovery-digits mono">{formatRecoveryCode(code)}</p>
      <p>{t('recovery.keep')}</p>
    </div>
  );
};

/** After setup, and after a recovery code was used: the code to keep, and on into the app. */
const RecoveryCodePage = ({ code, after }: { code: string; after: 'setup' | 'recovered' }) => {
  const { t } = useI18n();
  return (
    <article class="auth-card">
      <Brand />
      <h1>{t('recovery.title')}</h1>
      <p>{t(after === 'setup' ? 'recovery.after_setup' : 'recovery.after_recover')}</p>
      <RecoveryCodeBox code={code} />
      <p>
        <a href="/" class="btn">
          {t('recovery.continue')}
        </a>
      </p>
    </article>
  );
};

type RecoverField = 'username' | 'code' | 'password' | 'confirm';

const RecoverForm = ({ username, error, wrong = [] }: { username?: string; error?: string; wrong?: RecoverField[] }) => {
  const { t } = useI18n();
  const at = (f: RecoverField) => invalid(wrong.includes(f) && error, 'recover-error');
  return (
    <article class="auth-card">
      <Brand />
      <h1>{t('recover.title')}</h1>
      <p class="muted">{t('recover.intro')}</p>
      {error ? (
        <p class="error" role="alert" id="recover-error">
          {error}
        </p>
      ) : null}
      <form method="post" action="/recover">
        <label>
          {t('login.username')}
          {/* eslint-disable-next-line no-restricted-syntax -- the page is one form, opened to do one thing */}
          <input name="username" value={username ?? ''} required autofocus autocomplete="username" {...at('username')} />
        </label>
        <label>
          {t('recover.code_label')}
          <input name="code" required autocomplete="off" autocapitalize="characters" spellcheck={false} class="mono" {...at('code')} />
        </label>
        <label>
          {t('account.new')} <small>{t('setup.password_hint')}</small>
          <input type="password" name="password" required minlength={8} autocomplete="new-password" {...at('password')} />
        </label>
        <label>
          {t('setup.confirm')}
          <input type="password" name="confirm" required autocomplete="new-password" {...at('confirm')} />
        </label>
        <button type="submit">{t('join.submit')}</button>
      </form>
      <p>
        <a href="/login">{t('pair.back_to_login')}</a>
      </p>
    </article>
  );
};

auth.get('/recover', async (c) => page(c, (await i18nOf(c)).t('recover.title'), <RecoverForm />));

auth.post('/recover', async (c) => {
  const secret = c.env.SESSION_SECRET;
  if (!hasSessionSecret(secret)) return noSessionSecret(c);
  c.header('cache-control', 'no-store');
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const password = String(body['password'] ?? '');
  const confirm = String(body['confirm'] ?? '');
  const { t } = await i18nOf(c);
  const form = (error: string, wrong: RecoverField[]) => page(c, t('recover.title'), <RecoverForm username={username} error={error} wrong={wrong} />);
  // what was typed first: a password too short or unconfirmed costs no try
  if (password.length < 8) return form(t('join.too_short'), ['password']);
  if (password !== confirm) return form(t('setup.mismatch'), ['confirm']);
  // and what can't be a code at all — the wrong length, a character no code has: a typo guesses nothing
  const code = normalizeRecoveryCode(body['code']);
  if (!code) return form(t('recover.wrong'), ['username', 'code']);
  // then login's throttle (ARCH.md §8), by address and by the account named, counted before the code is checked
  const attempt = await recordLoginAttempt(c.env.DB, clientIp(c), username);
  if (!attempt) {
    c.status(429);
    return form(t('login.too_many', { minutes: LOGIN_ATTEMPT_WINDOW_MINUTES }), []);
  }
  // the code before the password is hashed: a wrong one costs a lookup, never a PBKDF2
  const codeHash = await hashLinkToken(code);
  if (!(await recoveryCodeOpens(c.env.DB, username, codeHash))) return form(t('recover.wrong'), ['username', 'code']);
  // the batch decides (§16 #100): the code is found again in every statement, so of two uses racing, one signs in;
  // the try is taken back in it too, so nothing after it can fail the request (§16 #39)
  const next = newRecoveryCode();
  const ns = await newSessionFor(c);
  const account = await recoverWithCode(c.env.DB, { username, codeHash, passwordHash: await hashPassword(password), nextCodeHash: await hashLinkToken(next) }, ns, attempt);
  if (!account) return form(t('recover.wrong'), ['username', 'code']);
  await setSessionCookie(c, secret, account, ns.sid);
  return page(c, t('recovery.title'), <RecoveryCodePage code={next} after="recovered" />);
});

type SetupField = 'username' | 'password' | 'confirm';

/** `wrong`: the fields the error is about, which point at it. */
const SetupForm = ({ error, wrong = [] }: { error?: string; wrong?: SetupField[] }) => {
  const { t } = useI18n();
  return (
    <article class="auth-card">
      <Brand />
      <h1>{t('setup.welcome')}</h1>
      <p class="muted">{t('setup.intro')}</p>
      {error ? (
        <p class="error" role="alert" id="setup-error">
          {error}
        </p>
      ) : null}
      <form method="post" action="/setup">
        <label>
          {t('login.username')}
          {/* eslint-disable-next-line no-restricted-syntax -- setup is one form, on a fresh instance: its first field is where everyone starts */}
          <input name="username" required autofocus autocomplete="username" {...invalid(wrong.includes('username') && error, 'setup-error')} />
        </label>
        <label>
          {t('login.password')} <small>{t('setup.password_hint')}</small>
          <input type="password" name="password" required minlength={8} autocomplete="new-password" {...invalid(wrong.includes('password') && error, 'setup-error')} />
        </label>
        <label>
          {t('setup.confirm')}
          <input type="password" name="confirm" required autocomplete="new-password" {...invalid(wrong.includes('confirm') && error, 'setup-error')} />
        </label>
        <button type="submit">{t('setup.submit')}</button>
      </form>
    </article>
  );
};

auth.get('/setup', async (c) => {
  if (!hasSessionSecret(c.env.SESSION_SECRET)) return setupWithoutSecret(c, false);
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  return page(c, (await i18nOf(c)).t('setup.title'), <SetupForm />);
});

// starter shelves for the three media types this household collects
const STARTER_SHELVES = ['Books', 'Board games', 'Vinyl'];

auth.post('/setup', async (c) => {
  const secret = c.env.SESSION_SECRET;
  if (!hasSessionSecret(secret)) return setupWithoutSecret(c, true);
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  const body = await c.req.parseBody();
  const username = String(body['username'] ?? '').trim();
  const password = String(body['password'] ?? '');
  const confirm = String(body['confirm'] ?? '');
  const { t } = await i18nOf(c);
  if (!username || password.length < 8) {
    return page(c, t('setup.title'), <SetupForm error={t('setup.invalid')} wrong={['username', 'password']} />);
  }
  if (password !== confirm) {
    return page(c, t('setup.title'), <SetupForm error={t('setup.mismatch')} wrong={['confirm']} />);
  }
  // The count above only saves hashing on a closed setup. The batch decides: of two setups racing, one wins. The
  // loser goes to login, which says why: usually it's the second click of a double-click, whose response is the
  // page the browser shows, and the password just chosen works there.
  const ns = await newSessionFor(c);
  // the admin's recovery code (§16 #100), made with the account and shown on the page this answers with, this once
  const recovery = newRecoveryCode();
  const admin = await createFirstAdmin(
    c.env.DB,
    { username, passwordHash: await hashPassword(password), recoveryHash: await hashLinkToken(recovery) },
    STARTER_SHELVES,
    ns,
  );
  if (admin === null) return c.redirect('/login?raced=1');
  await setSessionCookie(c, secret, admin, ns.sid);
  c.header('cache-control', 'no-store');
  return page(c, t('recovery.title'), <RecoveryCodePage code={recovery} after="setup" />);
});

export default auth;
