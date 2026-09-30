// Receiving recommendations from a connection (ARCH.md §16 #58): one of their items, recommended to this household by
// one of their members, with an optional note. Pushed to the inbox or pulled from their outbox, both land here, and
// both are idempotent by activity id.
//
// Everything in one is a string from another instance — the title, creators, the name it's signed with and the note —
// checked by parseInboxMessage() and rendered only as escaped text. Its cover is only ever a key into their /covers/.
import { takeRecommendation } from '../db/federation';
import type { Connection } from '../db/schema';
import type { Outcome } from './comments';
import type { Recommend } from './messages';

export async function receiveRecommendation(d1: D1Database, connection: Connection, m: Recommend): Promise<Outcome> {
  const intake = await takeRecommendation(
    d1,
    {
      activityId: m.id,
      connectionId: connection.id,
      theirItemId: m.item.id,
      theirItemStamp: m.item.stamp,
      theirViewId: m.item.view,
      mediaType: m.item.mediaType,
      title: m.item.title,
      creators: m.item.creators,
      published: m.item.published,
      coverKey: m.item.coverKey,
      identifiers: JSON.stringify(m.item.ids),
      recommender: m.recommender,
      note: m.note,
    },
    // the household's name as this instance knows it, and the title as they sent it; the link is built here
    { kind: 'recommendation', householdName: connection.householdName, subject: m.item.title, href: '/recommendations' },
  );
  switch (intake) {
    case 'received':
    case 'already received':
      return { status: 200, body: { status: intake } };
    // A 4xx the sender takes as final (outbox.ts's `refused`): it shows as refused there, and isn't retried for days.
    case 'too many waiting':
      return { status: 409, body: { error: 'too many recommendations waiting' } };
    case 'too many today':
      return { status: 409, body: { error: 'too many recommendations today' } };
  }
}
