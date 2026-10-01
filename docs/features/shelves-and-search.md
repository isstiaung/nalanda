# Shelves and search

Where things are listed and how you find them again: the shelf and its filter bar, saved views,
tags, bulk edit, the search box and its operators, and the pages for the people behind the items.

## Shelves

A shelf is a list with a name, and an item is on exactly one. `/setup` makes Books, Board games
and Vinyl; **Shelf settings** on a shelf renames it, publishes a view of it
([sharing.md](sharing.md)) and, for admins, deletes it — its items go to the trash
([members-and-privacy.md](members-and-privacy.md#trash)). The Overview lists every shelf with its
count, how public it is, its saved views and, once anything is priced, what it cost; beneath, what
is out on loan and the newest additions.

## The filter bar

Every shelf has the same bar ([#22](../decisions/022-shelf-filters-any-checkbox-groups.md)): a
search box over title, author and location; **Type**; **Status** — Not started, In progress,
Completed, Abandoned, with a book being re-read under In progress and Completed both; **Holding** —
Owned, Logged — not owned, Borrowed from someone; **Format**; **Read by**, once the household has
more than one member — me, not me, a member by name, anyone, or being read now; and a sort — newest
first, title A–Z, author A–Z, highest rated, date completed. Within a menu the choices are any-of;
between menus, all must hold. Sixty items a page, as a table or as covers, with a **Play tonight**
button on a shelf showing board games.

**Author A–Z** sorts by the first creator's surname — "Le Guin, Ursula K." and "Ursula K. Le Guin"
both under Le Guin — then the full name, then the title; items with nobody named come last
([#83](../decisions/083-author-sort.md)). A share link can be published in that order too.

**Columns** on the table is a per-device choice ([#28](../decisions/028-table-columns-per-device-choice.md)):
turn off any column but Title, and the browser remembers; under 1,400 px wide the Tags column starts
hidden so the table fits beside the sidebar. A vinyl shelf has no use for "Completed".

## Saved views

A shelf's filter bar can be saved under a name — **Save view** — and opened again from the row of
views under the bar or from the Overview, by anyone in the household; saving under the same name
replaces it, anyone can delete one, and a shelf holds twenty
([#81](../decisions/081-saved-views.md)). A view keeps everything the bar can say, the search box and
Read by included — a saved "Read by me" is each member's own. Two presets on every shelf: **Unread
for years** (owned, unread, added three or more years ago) and, where there are games or records,
**Not played lately** (no play in a year, never played included). Views stay inside the app: a
share link can't be made from one, and the backup carries them while the CSV, which is about
items, does not.

## Tags

Free text on any item, lowercased on the way in, several at once on the form with commas. **Tags**
in the sidebar lists them; a tag's page lists everything carrying it, on any shelf, owned or not,
and lets an admin publish that list as a share link
([#31](../decisions/031-share-links-can-capture-tag.md)). Bulk edit adds or removes a tag across a
selection. Imports bring tags from Goodreads' shelves, libib's groups and StoryGraph's and
LibraryThing's tags ([imports-and-exports.md](imports-and-exports.md)).

## Bulk edit

Tick items on a shelf or in search results, or **Select all on this page**, and a bar offers **Add
a tag**, **Remove a tag**, **Move to shelf**, **Mark owned** and **Mark not owned**
([#47](../decisions/047-bulk-edit-batch-per-action.md)) — up to 250 at a time, all or nothing. Owned
and not owned skip an item held in two or more copies, and a copy out on loan, and say how many they
skipped. Admins can **Delete** in bulk, after a page naming the count and the first titles; the
items go to the trash. It works without JavaScript.

## Search

**Search** covers titles, creators, descriptions, notes, locations and original titles, full-text,
and shows the fifty best matches ([#80](../decisions/080-search-operators.md)). Beside plain words
the box takes `author:`, `title:`, `tag:`, `status:` (unread, reading, read, abandoned and their
synonyms), `year:` (2019, or 2010-2019), `lang:` (a code or a name) and `type:` (book, game, record)
— `author:"le guin" status:unread year:1960-1979`, quotes for a phrase. Several operators are all
required; the same one twice is either, except `tag:`, which an item must carry every one of. A
prefix the box doesn't know, or a value it can't read, is searched as the text it is; operators on
their own list by title. Read by narrows a search as it does a shelf. An original title is found as
written: a script with spaces searches by word, and Chinese, Japanese or Thai by the whole run or a
prefix with `*`.

## Creators and publishers

**Creators** lists everyone the catalog names — authors of books, designers of games, artists of
records — grouped by which they mostly are, with a box to narrow the list; each name's page lists
their items as a shelf does, headed by how many of their books you've finished
([#72](../decisions/072-creator-and-publisher-pages.md)). **Publishers** does the same for
publishers and record labels. Names are read from the items as they are: "Le Guin, Ursula K." and
"Ursula K. Le Guin" are one author, "Terry Pratchett, Neil Gaiman" two. Each creator and the
publisher on an item's page link to theirs. Inside the app only; share pages show creators as text.

## The sidebar

Overview, Add items and Search stay at the top; everything else folds into sections by what you
came to do — Library, Shelves, Reading, Lending, Sharing & connections, Settings
([#62](../decisions/062-sidebar-folds-into-sections-what.md)). The section holding the page you're
on is open; the ones you open stay open on that device. A closed section's header counts what's
unread inside it.
