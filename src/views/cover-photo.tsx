// A cover from the camera (ARCH.md §16 #73): the form under an item's cover, and the field on the item form. The
// browser shrinks the picture before it's sent (public/app.js, data-resize); the Worker stores the bytes as they come.
import type { FC } from 'hono/jsx';

export const PHOTO_MAX_MB = 4;

/**
 * The file field alone — on the item form, beside the cover URL. No `capture` attribute: with it, a phone opens the
 * camera and offers no way to pick a photo already taken; with `accept` alone it offers both. `invalid` is the
 * attributes a refused photo gets, from invalid() in components.tsx.
 */
export const CoverPhotoField: FC<{ id?: string; invalid?: Record<string, string | undefined> }> = ({ id = 'cover-photo', invalid = {} }) => (
  <label>
    Cover photo <small>(from the camera or a file — shrunk before it's sent; shown wherever the cover is, share pages included)</small>
    <input type="file" name="photo" id={id} accept="image/*" data-resize="cover" {...invalid} />
  </label>
);

/** Why an upload can't be a cover, as the pages say it. */
export const PHOTO_REFUSED = `That file isn’t a picture Nalanda can keep: a JPEG, PNG, GIF, WebP or AVIF, up to ${PHOTO_MAX_MB} MB.`;

/** Under an item's cover: take or pick a picture and use it, or remove the cover it has. */
export const CoverPhotoForm: FC<{ itemId: number; hasCover: boolean; error?: boolean }> = ({ itemId, hasCover, error }) => (
  <form method="post" action={`/items/${itemId}/cover`} enctype="multipart/form-data" class="cover-photo">
    {error ? (
      <p class="error" role="alert" id="cover-photo-error">
        {PHOTO_REFUSED}
      </p>
    ) : null}
    <label>
      {hasCover ? 'Replace the cover with a photo' : 'Add a cover from a photo'}
      <input
        type="file"
        name="photo"
        accept="image/*"
        data-resize="cover"
        required
        aria-describedby={error ? 'cover-photo-error' : undefined}
        aria-invalid={error ? 'true' : undefined}
      />
    </label>
    <div class="cover-photo-actions">
      <button type="submit" class="btn">
        Use this photo
      </button>
      {hasCover ? (
        <button type="submit" name="action" value="remove" class="btn" formnovalidate>
          Remove cover
        </button>
      ) : null}
    </div>
  </form>
);
