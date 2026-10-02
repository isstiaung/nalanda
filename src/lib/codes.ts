// Codes a person reads off one screen and types on another (ARCH.md §16 #99, #100): a device's pairing code, an admin's
// recovery code. Pure: the alphabet, making one, showing it in fours, and reading back what was typed.

/** No 0/O, 1/I/L: read off a screen, written on paper, typed with a television's remote. 31 characters, ~4.95 bits each. */
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A new code of `length` characters, each equally likely: a byte past the alphabet's last whole multiple is drawn again. */
export function newCode(length: number): string {
  const limit = 256 - (256 % ALPHABET.length);
  let code = '';
  while (code.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length))) {
      if (b < limit && code.length < length) code += ALPHABET[b % ALPHABET.length];
    }
  }
  return code;
}

/** A code as it is shown: in fours, "ABCD-EFGH". */
export const groupCode = (code: string): string => (code.match(/.{1,4}/g) ?? []).join('-');

/** A code as typed — lower case, spaces, dashes — read back as the code it was meant to be; '' if it can't be one. */
export function readCode(raw: unknown, length: number): string {
  const code = String(raw ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  return code.length === length && [...code].every((ch) => ALPHABET.includes(ch)) ? code : '';
}
