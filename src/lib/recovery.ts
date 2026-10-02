// An admin's recovery code (ARCH.md §16 #100): what signs them back in with a forgotten password when no other admin can
// make them a link. Pure: its length and how it is shown and read back; the row is in db/queries.ts, the pages in
// routes/auth.tsx (setup, /recover) and routes/account.tsx.
import { groupCode, newCode, readCode } from './codes';

/** Twenty characters, ~99 bits: written down or kept in a password manager, guessed at only ten times in ten minutes. */
export const RECOVERY_CODE_LENGTH = 20;

export const newRecoveryCode = (): string => newCode(RECOVERY_CODE_LENGTH);

/** As shown: in fives of four, "ABCD-EFGH-JKMN-PQRS-TUVW". */
export const formatRecoveryCode = groupCode;

/** As typed, read back; '' if it can't be one. */
export const normalizeRecoveryCode = (raw: unknown): string => readCode(raw, RECOVERY_CODE_LENGTH);
