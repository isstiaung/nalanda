// A session for a user the test knows only by id: the token login would set, naming their id and session key
// (ARCH.md §16 #56). Reads the row on env.DB, so it adds nothing to a request's budgeted count.
import { env } from 'cloudflare:test';
import { getUserById } from '../src/db/queries';
import { createSessionToken } from '../src/lib/auth';

export async function sessionTokenFor(userId: number): Promise<string> {
  const user = await getUserById(env.DB, userId);
  if (!user) throw new Error(`no user ${userId} to sign in`);
  return createSessionToken(env.SESSION_SECRET, user, Math.floor(Date.now() / 1000));
}
