## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Added
- **Import from StoryGraph and LibraryThing.** Both exports are recognised on the Import page and brought in as a Goodreads export is: a book already here (by ISBN, then title and author) gets your rating, review and reads merged onto it; the rest become Not owned reading-log entries — or owned copies where the file says so (StoryGraph's Owned?, LibraryThing's collections and Copies). StoryGraph's dated reads each become a read, its format the copy's form, its moods, pace and content warnings your private notes; LibraryThing's Date Read and Date Started, Media, Comment and Private Comment, Collections, Series and Volume, Languages all map. Two runbooks say how to export.
