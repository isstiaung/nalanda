# §16 #76 — A household default language, every item's own, and an original title in any script; search matches text as written

**Decided:** 2026-10-01 (where it is now). Cited as `ARCH.md §16 #76`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

There was no language field and no original title: a household reading in two or three
languages had nowhere to say "the Tamil translation of a Murakami", and a shelf showed
nothing of it. **The owner decided** the shape, and pared it down from a proposal that
inferred the household's language from its catalogue:

1. **A household default language**, any ISO 639-1 language, English until an admin changes
   it, set under Members beside the currency (`site_settings.language`). Changing it later
   leaves every item already added as it is.
2. **Every item added takes it** — from the form, a scan, a search result or an import —
   unless its source said otherwise: Open Library's `language` (ISO 639-2, mapped), Google
   Books' `language`, or a Nalanda export's `language` column. Editable while adding and at any
   time after, on the item form, from the full list. An item from before the column reads as
   the household's. A **language pill** shows beside the type only when an item's language
   differs from the household's, so a shelf of one language stays plain; the pill knows the
   household's from the item page's existing batch (`itemPageLog`), not a call of its own.
3. **Original title** is optional free text in whatever script the person types, shown in
   italics under the title. No rule about its language.
4. **Search matches text as written**: the original title joins the FTS index (migration
   0044, a rebuild as 0032 was), so கடல் is found by typing கடல். No transliteration, no
   cross-script matching, by the owner's decision.

Both fields are public catalogue data like the publisher: in `toPublicItem()` (`language`,
`originalTitle`), on gift lists (which language, and which title, to buy), to connections
(older households drop the keys; `ItemDetail` carries them optionally). Both round-trip
through the CSV; a blank or unknown `language` on import takes the household's.

**Two limits, stated:** FTS5's `unicode61` tokenizer splits on spaces and punctuation, so an
original title in Chinese, Japanese or Thai, written without spaces, is one token — found by its
whole run or a prefix with `*`, not by a word inside it; scripts with spaces (Tamil, Devanagari,
Cyrillic, Arabic) search by word. A trigram tokenizer would change every search, so not here. And
every kind of item takes the household's language, games and records included — a record has a
language as a book does — not books alone.

**What it rules out:** inferring a "normal" language from the catalogue (a setting is
simpler, and the owner wanted one); a per-member language; transliterated search; a language
filter on the shelf for now (`lang:` comes with the search operators, queue 6).

`test/language.spec.ts` holds it: every code and the provider and file mappings; the default,
its change by an admin, and an item taking it unless told; a member editing both, a form
without a code keeping the item's, a NULL reading as the household's; the pill only on a
difference; search finding the original title as written and not transliterated; both fields
on share pages and in `toPublicItem()`; the CSV round trip.
