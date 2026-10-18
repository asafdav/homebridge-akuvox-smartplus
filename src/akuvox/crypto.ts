import { createHash } from 'node:crypto';

export const md5Hex = (input: string): string => createHash('md5').update(input, 'utf8').digest('hex');

/** Double MD5, as the SmartPlus app hashes a password before login. */
export const hashPassword = (password: string): string => md5Hex(md5Hex(password));

/** Shift each letter and digit by `key` places; other characters pass through. */
export function caesarShift(input: string, key = 3): string {
  return input.replace(/[a-z]|[A-Z]|[0-9]/g, (chr) => {
    const code = chr.charCodeAt(0);
    if (chr >= 'a' && chr <= 'z') return String.fromCharCode(((code - 97 + key) % 26) + 97);
    if (chr >= 'A' && chr <= 'Z') return String.fromCharCode(((code - 65 + key) % 26) + 65);
    return String.fromCharCode(((code - 48 + key) % 10) + 48);
  });
}

/** The gate reads the `user` query param without form-decoding, so `+` and `@` must reach it literally. */
export function loginUserParam(user: string): string {
  return encodeURIComponent(caesarShift(user)).replace(/%40/g, '@').replace(/%2B/g, '+');
}
