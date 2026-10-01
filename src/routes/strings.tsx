// The interface strings as a file (ARCH.md §16 #93): GET /strings/<locale>.json serves the whole table for a shipped
// locale — its shipped strings with this household's own translation on top, so a translator starts from what the
// pages show — and English for a locale that isn't shipped. One D1 call, for the household's row. Behind the session
// middleware: a member downloads it from Account, corrects it, and an admin imports it under Members or opens a pull
// request. Pretty-printed, so it can be edited by hand and read in a diff.
import { Hono } from 'hono';
import { getTranslation } from '../db/queries';
import type { AppEnv } from '../env';
import { isLocale, stringsFor, type Locale } from '../i18n';

const strings = new Hono<AppEnv>();

strings.get('/strings/:file', async (c) => {
  const m = /^([a-z]{2,3})\.json$/.exec(c.req.param('file'));
  if (!m) return c.notFound();
  const locale: Locale = isLocale(m[1]) ? m[1] : 'en';
  const own = await getTranslation(c.env.DB, locale);
  return c.body(JSON.stringify(stringsFor(locale, own), null, 2), 200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="nalanda-strings-${locale}.json"`,
  });
});

export default strings;
