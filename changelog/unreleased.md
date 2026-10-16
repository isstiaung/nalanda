## [Unreleased]

<!-- Each pull request adds its entries here (### Added, ### Changed, ### Fixed, and ### Upgrading
for what a host must do; link runbooks as ../runbooks/…); a release commit renames this file to vX.Y.Z.md and starts a fresh one (ARCH.md §16 #42). -->

### Changed

- **On a phone, Nalanda is built for a thumb** (ARCH.md §16 #103). Controls are 40px tall with 16px
  text at 880px and under, so Safari no longer zooms into a field you tap, and the menu drawer's rows
  are as tall. The bar above every page carries **Search** and **Add items**.
- **A shelf's filters are one Filters button**, at every width, beside the search box and saying how
  many filters are in use. It opens a panel with every filter's choices in sight (no dropdown inside a
  dropdown), Read by and the sort, **Apply** and **Clear filters**. The panel offers what could match:
  a shelf of books isn't offered Cassette, and a shelf of one type has no Type to choose.
- **A shelf on a phone** lists its items rather than showing a table that scrolled sideways: cover,
  title, creators, and the rating, status or Not owned that set each apart. "Save view" and its
  name share one row at every width.
- **An item's page** opens on its head: on a phone the cover sits beside the title, creators, tags
  and **Edit**; on a wide screen **Edit** sits at the top right. **Change cover** folds the photo
  form away until it is wanted (a refused photo opens it). **Delete** stays at the foot of the page.
  Share pages take the same cover-beside-title head on a phone.
- A lighter polish everywhere: page titles at 26px with balanced line breaks, **Previous** and
  **Next** as buttons, the Overview's covers three to a row on a phone, an item's description and
  review at a reading width, and larger cover thumbnails in tables.
