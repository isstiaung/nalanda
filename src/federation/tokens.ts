// Invitation tokens (docs/proposals/connections.md §5). 256 random bits, shown to the admin once;
// only a SHA-256 hash is ever stored, so a leaked database or backup can't redeem anything.
import { b64url } from '../lib/auth';

export function newInviteToken(): string {
  return b64url.encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
