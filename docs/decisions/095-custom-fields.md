# §16 #95 — Custom fields: up to ten household fields (text, yes/no, date) on every item form, kept in `items.custom`, private unless a field's own share switch is on, never to connections

**Decided:** 2026-10-01. Cited as `ARCH.md §16 #95`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

A household has facts about its things that no catalogue column holds — who gave a book, whether a
record is signed, when a game was bought — and until now they went into private notes as prose, or
into `details` as ad-hoc keys, which share pages render whole. libib has custom fields; **the owner
decided** (queue item 19) on a small version of them: an admin defines the fields, every item form
shows them, and each field says for itself whether its values may be published.

**What was decided:**
- **A `custom_fields` table** (migration 0055): a name of up to 40 characters, unique without regard
  to case; a kind — `text` (up to 500 characters), `bool` (a yes/no) or `date` (a calendar date); a
  position (by creation — no reordering yet); and `on_shares`, **off by default**. At most
  **ten** (`CUSTOM_FIELD_LIMIT`): enough for the facts a shelf carries, few enough that every form
  stays short. The cap and the name's uniqueness are checked in the insert statement itself, so two
  admins adding at once can't make an eleventh or two of one name. Ids are never reused
  (AUTOINCREMENT): a value a trash snapshot keeps under a deleted field's id can't come back under a
  newer field's. Only an admin sees or touches the panel (it lives under Members, behind the
  admin-only middleware); members see the fields on the forms and the pages, as everyone does.
- **Values in `items.custom`**, one JSON column keyed by the field's id as a string: text, `true` for
  a ticked yes/no, or a date. **Never in `details`**, which is published, and not in a table of
  their own: the item page, the shelf, the export and the trash snapshot all read the item's row
  already, so a column costs no call and the snapshot picks it up by construction
  (`trashPayloadSql()` takes every column, #74). A yes/no left unticked is unset, not `false`, so
  the page shows set values only and an item nobody has said anything about says nothing; `false`
  on the way in (an import, a hand-edited file) reads as unset too. A key with no field among the
  household's — a field deleted since, in an old snapshot — is never shown, exported or published.
- **Private by default, public by the field's own switch.** `toPublicItem()` adds a `custom` key —
  `[{ name, kind, value }]`, never an id — only for fields whose `on_shares` is on (`publicCustom()`
  checks, whatever list it is given), and only when the caller passes the fields in, which the
  **share item page** alone does: listings, feeds, gift lists and link previews serve exactly what
  they did. **Never to connections**: `ConnectionItem` omits the key and `toConnectionItem()`
  passes no fields, so shelves, item pages, feeds and recommendations carry neither a field's name
  nor its value, whatever the switch says — the switch is about share pages, and a field is the
  household's own.
- **The form** reads each value by its field's kind (`customFromForm()`), refuses with the reason tied
  to the field (`role="alert"`, `aria-invalid`), and shows what was typed again. A hidden marker says a
  form carried the fields: a scan's or a search result's add, or a form opened before a field
  existed, says nothing and the item's values stay as they are; a household with no fields writes
  nothing. The values ride in the item's own write batch (`createItemWithTags`,
  `updateItemWithTags`). Bulk edit is untouched.
- **Deleting a field deletes its values**: the `json_remove` over every item and the row's delete are
  one batch, the confirm says the values are lost, and the admin is named in each changed item's
  history. Renaming keeps the values; a kind can't change, since the values already hold it.
- **History records it** (migration 0056 recreates the #84 trigger with `custom` among its columns):
  the field named `custom`, before and after as the column's JSON cut to 200 characters, as `details`
  is recorded — raw, by id, since a trigger has no sensible way to say names, and the page labels it
  "Fields".
- **The CSV round trip is by name.** The export's `custom` cell, just before `details`, is the item's
  values keyed by the field's *name* — `{"Signed":true,"Gifted by":"Ravi"}` — so a file moves between
  households, whose fields have different ids. A Nalanda import matches names to this household's
  fields (case aside) and checks each value by kind; a name with no field here is dropped and the
  preview says how many ("had no field here"), as is a value that doesn't fit. `custom` joins
  `PRIVATE_COLUMNS`, so a libib, Goodreads, StoryGraph or LibraryThing file with such a column never
  puts it into `details`.
- **Backups** list `custom_fields` (before `items`, whose values key on it); the restore loop follows.
  Removing a member touches nothing here: the fields are the household's.

**What it rules out:** fields in `details` (published); per-member fields (a member's thing is not
a column, docs/adding-a-column.md §1); number, choice or multi-line kinds for now (text holds a
number as a spreadsheet would write one; a choice is a text field with a convention); reordering
(position is by creation); filtering or sorting a shelf by a field (not an `ItemFilters` column, so
no share link or connection view can ever capture one — a private field as a filter would publish
its values by omission); sending them to connections under a switch of their own; changing a
field's kind.

Touches §9 (the whitelist gains a key under a per-field switch), §16 #74 (the snapshot carries the
column), #84 (the trigger's column list). `test/custom-fields.spec.ts` holds it: the panel is an
admin's, caps at ten in the statement, refuses a duplicate name case aside, and a delete strips
values in one batch; the form validates each kind, saves on add and edit, writes nothing without the
marker, and shows set values; a share page's bytes are identical with and without a private field's
value and a switched-on field shows by name on the item page only; connections' served JSON lacks it;
the export writes names and the import reads them back, a comma in a name and a field missing here
included, while other formats keep it out of details; the trash snapshot and restore keep it; history
records it; and the item page, the shelf and the edit form cost no more calls than before.
