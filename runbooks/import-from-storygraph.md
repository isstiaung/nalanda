# Runbook: Import from StoryGraph

Brings your StoryGraph library into Nalanda — your reads with their dates, your star ratings,
reviews and tags — the way the [Goodreads import](import-from-goodreads.md) does: a book
already in Nalanda gets your reading merged onto it; a book that isn't becomes a "Not owned"
reading-log entry (`copies = 0`), or an owned copy where StoryGraph says **Owned? Yes**.

## Export from StoryGraph

app.thestorygraph.com → your profile menu → **Manage Account** → **Export StoryGraph library**
(near the bottom). Generation takes a moment; a download link appears on the same page when
it's ready. One CSV covers everything: every book with its read status, dates read, rating,
review, tags, moods and pace.

## Import into Nalanda

1. Log in **as the person whose StoryGraph export it is** → **/import**. Everything the file
   brings — reads, rating, review — becomes that member's own (ARCH.md §16 #43). Each member
   imports their own export.
2. Pick the CSV and the destination shelf. The StoryGraph format is auto-detected (the
   "default type" and "music as vinyl" options don't apply). The destination only affects
   **new** entries; matched books stay on their shelf.
3. **Preview (dry run, optional)** — shows, for the first 200 rows, how many map, how many
   **match books already in Nalanda** (their reading will merge), how many are **new**, and how
   many **reads** it would add or date. Nothing is written yet.
4. **Import** — uploads in batches of 200 with live progress.

**Re-running is safe**: rows imported last time match by ISBN (or title + author) on the next
run and merge instead of duplicating.

## What maps where

| StoryGraph | Nalanda |
|---|---|
| Title (with "(Series, #1)") | Title; the suffix becomes the series and number |
| Authors | Creators |
| ISBN/UID | ISBN-13 or ISBN-10; any other id stays in details as `storygraph_uid` |
| Format (hardcover, paperback, ebook, audiobook) | Held as |
| Read Status (read, currently-reading, to-read, did-not-finish) | Reading status |
| Dates Read ("start-end", several joined by commas) | One read per dated range; an open range while currently reading is the open read |
| Last Date Read, Read Count | The finish and count a merge reconciles with reads already here |
| Star Rating (0–5, halves and quarters) | Rating 1–10 (4.25 → 9) |
| Review | Your review |
| Tags | Tags |
| Owned? | Yes: one copy; No: a reading-log entry, not owned |
| Moods, Pace, Character- or Plot-Driven?, the character questions, Content Warnings | Your private notes — opinions, never on a share page |
| Date Added, Contributors | Details (kept) |

StoryGraph has no publisher, page count or notes; those stay empty for a new entry and are
never blanked on a matched one.

## Matching and merge rules

The same as Goodreads': a row is matched by **ISBN-13 → ISBN-10 → normalized title +
first-author surname**; on a match StoryGraph wins for *your* rating and review, the book's
notes keep what they had with the impressions added after, and your reads
are **added and never removed** — importing the same file again adds nothing. See the
[Goodreads runbook](import-from-goodreads.md#matching-and-merge-rules) for the rules read by
read.
