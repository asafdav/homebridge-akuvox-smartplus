import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildDigestAuth, parseSipMessage, sipHeader } from '../src/akuvox/sip.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('parseSipMessage', () => {
  it('parses the start line and repeated Via headers', () => {
    const raw = ['INVITE sip:me@pbx SIP/2.0', 'Via: SIP/2.0/TCP a;branch=1', 'Via: SIP/2.0/TCP b;branch=2', 'From: <sip:door@pbx>;tag=x', '', ''].join('\r\n');
    const m = parseSipMessage(raw);
    expect(m.start).toBe('INVITE sip:me@pbx SIP/2.0');
    expect(m.headers.get('via')).toHaveLength(2);
    expect(sipHeader(m, 'from')).toBe('<sip:door@pbx>;tag=x');
  });
});

describe('buildDigestAuth', () => {
  it('computes the qop=auth response with the SIP digest formula', () => {
    const challenge = 'Digest realm="akuvox", nonce="abc", qop="auth"';
    const auth = buildDigestAuth({ challenge, username: 'user1', password: 'pw', method: 'REGISTER', uri: 'sip:pbx' });

    const cnonce = auth.match(/cnonce="([^"]+)"/)?.[1] ?? '';
    const ha1 = md5('user1:akuvox:pw');
    const ha2 = md5('REGISTER:sip:pbx');
    const expected = md5(`${ha1}:abc:00000001:${cnonce}:auth:${ha2}`);
    expect(auth).toContain(`response="${expected}"`);
    expect(auth).toContain('qop=auth');
  });

  it('falls back to the no-qop formula', () => {
    const auth = buildDigestAuth({ challenge: 'Digest realm="r", nonce="n"', username: 'u', password: 'p', method: 'REGISTER', uri: 'sip:pbx' });
    const expected = md5(`${md5('u:r:p')}:n:${md5('REGISTER:sip:pbx')}`);
    expect(auth).toContain(`response="${expected}"`);
    expect(auth).not.toContain('qop');
  });
});
