# §16 #61 — What was paid is an integer number of minor units with its currency, on every item, in the household's currency. A record's Discogs market value was considered and dropped, because of Discogs' API terms

**Decided:** 2026-09-30 (purchase price, and Discogs market value dropped). Cited as `ARCH.md §16 #61`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

The owner first asked for two things: a record's market value from Discogs'
marketplace (the lowest listed price and how many copies are for sale, refreshed per record and
for the whole catalog, stored with the date it was fetched and totalled per shelf "as of" then),
and an optional purchase price on every item, both in one household currency an admin sets, both
in the app only. Research came first; on what it found, **the owner dropped market value
entirely**. Purchase price, the household currency and the paid totals are what shipped.
- **Why market value was dropped — Discogs' terms.** Discogs' API Terms of Use
  (<https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use>, "Last Updated:
  May 27th, 2025"; read on 2026-09-30 through the Wayback Machine's capture of 2026-05-30, the
  newest, since discogs.com answers fetches with a 403 challenge page) put marketplace prices in
  **Restricted Data**: *"'Marketplace Data' such as related inventory, orders, lists, fees, pricing
  suggestions, including but not limited to: pricing, release images posted in connection with
  offers for sale, and sales history."* Of all the API's content they say: *"The Content within Our
  API is dynamic and is quickly outdated. You may not display in any format or to any audience the
  Content if it is more than six (6) hours older than the information on Our online properties or
  applications and applications. You may not cache or store the Content longer than is necessary
  to provide a service to Your application's users."* A value kept with its fetch date and shown
  "as of" it, and a shelf total summed from values fetched days apart, is what that forbids.
  Restricted Data also may not be *"Transfer[red] … to any third party"* or used *"for any
  commercial purposes"*, and any data from the API wants *"Data provided by Discogs."* beside it,
  linked to its discogs.com page. Nothing of the marketplace is fetched, stored or shown.
- **What the research found, kept for the record.** Discogs' API documentation
  (<https://www.discogs.com/developers>, Wayback capture of 2026-09-19): `GET
  /marketplace/stats/{release_id}{?curr_abbr}` returns *"the number of items currently for sale,
  lowest listed price of any item for sale, and whether the item is blocked for sale"* as
  `{"lowest_price": {"currency", "value"}, "num_for_sale", "blocked_from_sale"}`; *"Releases that
  have no items for sale in the marketplace will return a body with null data in the lowest_price
  and num_for_sale keys. Releases that are blocked for sale will also have null data for these
  keys."* Without `curr_abbr` an authenticated caller gets its own buyer currency, an
  unauthenticated one US dollars; `curr_abbr` *"Must be one of the following: USD GBP EUR CAD AUD
  JPY CHF MXN BRL NZD SEK ZAR"* — **not INR**. `/marketplace/price_suggestions` needs *"the user …
  to have filled out their seller settings"*, and the owner had ruled it out. Authenticated
  requests are *"limited to 60 per minute"*, tracked as *"a moving average over a 60 second
  window"* and reported in `X-Discogs-Ratelimit`, `-Used` and `-Remaining`.
- **Purchase price: two columns, `purchase_price` and `purchase_currency` (migration 0039).**
  The amount is an integer count of the currency's minor units — paise, cents, and for a
  currency without one (JPY) the unit itself; how many decimals a currency has comes from
  `Intl.NumberFormat`'s `maximumFractionDigits`, so KWD takes three. Never a float: the form's
  text is parsed digit by digit (`parseMoney()`), a sum leaves SQLite as the text of an integer
  (`CAST(sum(…) AS TEXT)`), and `formatMoney()` hands Intl a decimal string, which it formats
  exactly — tested past 2^53. The code sits beside every amount rather than only in
  `site_settings`, so a household that changes currency keeps what it paid in what it paid it
  in; nothing is ever converted. A price is on every media type, optional, zero allowed (a gift),
  at most 999,999,999 whole units; a negative, a non-number, or more decimals than the currency
  has are refused on the form with the reason tied to the field (`aria-describedby`,
  `aria-invalid`), and dropped by an import. A price that isn't whole, non-negative minor units
  with a known code — only a hand-edited row — is left out of the item page, the totals and the
  export rather than failing any of them.
- **The household currency: `site_settings.currency`**, an ISO 4217 code an admin picks on the
  Members page from every code the runtime's Intl knows; `POST /settings/currency`, admin-only
  like everything under `/settings`, refuses anything else with a fixed message. NULL until set:
  the item form then has no price field, only a line saying an admin sets the currency — the app
  never guesses one. It can be changed, not cleared. A price already in another currency is shown
  in its own, and its edit form offers that currency and the household's, nothing else; a request
  naming any other is refused.
- **Forms.** The price is on the manual add form and the edit form (`ItemForm`), with the code
  shown before the input and named in its label. A scan's or a search result's one-click add has
  no price field — the edit form is a click away — and so costs no extra D1 call; a form with the
  field reads the setting once.
- **Totals: per shelf, per currency, never across currencies.** `shelfTotals()` is one D1 call
  — a batch of two grouped reads and the setting — for one shelf or all: items by type, and per
  currency the count priced and the sum. A shelf's page shows "Paid ₹30,200 for 9 · $45 for 2, in
  USD — of 12 records on this shelf"; the Overview's shelf table gains a Paid column once anything
  is priced. The shelf page went from 12 D1 calls to 13 and the Overview from 11 to 12; the edit
  page, the add page and the Members page read the setting, one call each; the item page costs
  nothing more.
- **Portable.** `/export.csv` gains `purchase_price` (a plain decimal in major units, "302.50") and
  `purchase_currency`, after `loans`. A Nalanda import reads the amount in the currency the row
  names, or the household's when it names none; a code that isn't one, an amount that doesn't
  parse, or a price with no currency to be in is dropped — an import never guesses at money. A
  libib file's `price` column, which has no currency, becomes the purchase price in the
  household's currency when one is set and it reads as a number; otherwise it stays in the item's
  details as before, in the app only (next point). The preview counts both.
- **Never outside the app.** No whitelist has the columns, and `toPublicItem()` now strips money
  keys (`price`, `purchase_price`, `purchase_currency`, any case) from the details it publishes,
  which also covers what connections get (`toConnectionItem()` and `plainDetails()` build on it).
  Before this, a libib price in details was published on share pages and to connections; the
  rehearsal found no such item in production's backup. Changing a price records no feed activity:
  the item triggers watch `review`, `rating`, `status` and `completed_on`. Tests compare share pages
  and a connection's shelf, item and feed byte for byte with and without a price.

**Chosen without asking, overrulable:** the Members page
as the currency's home; a currency that can be changed but not cleared; zero as a valid price;
the 999,999,999 cap; the 'en' locale for every currency (a lakh reads ₹100,000, not the Indian
grouping ₹1,00,000); whole amounts shown without ".00"; no price on the
one-click adds; libib's `price` read only when the household currency is set before the import;
stripping money keys from published details rather than migrating old libib prices out of them.
