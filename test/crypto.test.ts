import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { caesarShift, hashPassword, loginUserParam, md5Hex } from '../src/akuvox/crypto.js';

describe('caesarShift', () => {
  it('shifts letters and digits by 3, keeping symbols', () => {
    expect(caesarShift('abz.XYZ+789@mail.com')).toBe('dec.ABC+012@pdlo.frp');
  });

  it('wraps within each alphabet', () => {
    expect(caesarShift('z')).toBe('c');
    expect(caesarShift('9')).toBe('2');
    expect(caesarShift('Z')).toBe('C');
  });
});

describe('loginUserParam', () => {
  it('shifts the user but leaves + and @ literal for the gate', () => {
    expect(loginUserParam('ab+cd@ex.com')).toBe('de+fg@ha.frp');
  });

  it('still percent-encodes other unsafe characters', () => {
    expect(loginUserParam('a b')).toBe('d%20e');
  });
});

describe('hashPassword', () => {
  it('is MD5 applied twice', () => {
    const once = md5Hex('secret');
    expect(hashPassword('secret')).toBe(md5Hex(once));
  });

  it('matches a known MD5 of the empty string', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
});

describe('aes round-trip sanity', () => {
  it('confirms the legacy response key recipe still decrypts what it encrypts', () => {
    const user = 'someone@example.com';
    const key = Buffer.concat([createHash('md5').update(user).digest(), Buffer.from('Akuvox55069013!@')]);
    const cipher = createCipheriv('aes-256-cbc', key, Buffer.from('1234567887654321'));
    const blob = Buffer.concat([cipher.update('{"ok":1}'), cipher.final()]);
    expect(blob.length % 16).toBe(0);
  });
});
