import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { SipListener } from '../src/akuvox/sip.js';

class FakeSocket extends EventEmitter {
  writes: string[] = [];
  localAddress = '192.168.1.197';
  localPort = 55555;
  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
  destroy(): void {}
  last(pred: (w: string) => boolean): string | undefined {
    return [...this.writes].reverse().find(pred);
  }
}

const INVITE = [
  'INVITE sip:member@pbx SIP/2.0',
  'Via: SIP/2.0/TCP 3.79.120.60;branch=z9hG4bKabc',
  'From: "Door" <sip:door@pbx>;tag=remote1',
  'To: <sip:member@pbx>',
  'Call-ID: call-xyz',
  'CSeq: 1 INVITE',
  'Contact: <sip:door@3.79.120.60:5060;transport=tcp>',
  'Content-Type: application/sdp',
  '',
  ['v=0', 'o=FS 1 1 IN IP4 3.79.120.60', 'c=IN IP4 3.79.120.60', 'm=audio 18022 RTP/AVP 0 8 101', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:101 telephone-event/8000', 'm=video 23112 RTP/AVP 104'].join('\r\n'),
].join('\r\n');

function ringing(): { sip: SipListener; sock: FakeSocket } {
  const sock = new FakeSocket();
  const sip = new SipListener({ host: 'pbx', port: 5070, user: 'member', password: 'pw', createSocket: () => sock as unknown as Socket });
  sip.start();
  sock.emit('connect');
  const framed = INVITE.replace(/Content-Length.*\r\n/, '');
  const withLen = framed.replace('\r\n\r\n', `\r\nContent-Length: ${Buffer.byteLength(framed.split('\r\n\r\n')[1] ?? '')}\r\n\r\n`);
  sock.emit('data', Buffer.from(withLen, 'binary'));
  return { sip, sock };
}

describe('SipListener call dialog', () => {
  it('replies 180 Ringing and emits the offer on INVITE', () => {
    const events: unknown[] = [];
    const sock = new FakeSocket();
    const sip = new SipListener({ host: 'pbx', port: 5070, user: 'member', password: 'pw', createSocket: () => sock as unknown as Socket });
    sip.on('ring', (e) => events.push(e));
    sip.start();
    sock.emit('connect');
    const body = INVITE.split('\r\n\r\n')[1]!;
    sock.emit('data', Buffer.from(INVITE.replace('\r\n\r\n', `\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`), 'binary'));

    expect(sock.writes.some((w) => w.startsWith('SIP/2.0 180 Ringing'))).toBe(true);
    expect(events).toHaveLength(1);
    expect((events[0] as { offer?: { audio?: { pcmu?: number } } }).offer?.audio?.pcmu).toBe(0);
    expect(sip.hasCall).toBe(true);
  });

  it('answers with a 200 OK carrying our SDP and returns the door RTP endpoint', () => {
    const { sip, sock } = ringing();
    const result = sip.answer('v=0\r\nm=audio 40000 RTP/AVP 0\r\n');
    expect(result).toEqual({ address: '3.79.120.60', audioPort: 18022, payloadType: 0 });

    const ok = sock.last((w) => w.startsWith('SIP/2.0 200 OK'));
    expect(ok).toBeDefined();
    expect(ok).toContain('Call-ID: call-xyz');
    expect(ok).toContain('CSeq: 1 INVITE');
    expect(ok).toMatch(/To: <sip:member@pbx>;tag=[0-9a-f]+/);
    expect(ok).toContain('Content-Type: application/sdp');
    expect(ok).toContain('m=audio 40000 RTP/AVP 0');
  });

  it('sends an in-dialog BYE on hangup', () => {
    const { sip, sock } = ringing();
    sip.answer('v=0\r\nm=audio 40000 RTP/AVP 0\r\n');
    sip.hangup();
    const bye = sock.last((w) => w.startsWith('BYE '));
    expect(bye).toBeDefined();
    expect(bye).toContain('BYE sip:door@3.79.120.60:5060;transport=tcp SIP/2.0');
    expect(bye).toContain('Call-ID: call-xyz');
    expect(bye).toContain('To: "Door" <sip:door@pbx>;tag=remote1');
    expect(bye).toMatch(/From: <sip:member@pbx>;tag=[0-9a-f]+/);
    expect(sip.hasCall).toBe(false);
  });

  it('ends the call when the caller sends BYE', () => {
    const { sip, sock } = ringing();
    let ended = false;
    sip.on('callEnded', () => (ended = true));
    const bye = ['BYE sip:member@pbx SIP/2.0', 'Via: SIP/2.0/TCP 3.79.120.60;branch=z9hG4bKb', 'From: <sip:door@pbx>;tag=remote1', 'To: <sip:member@pbx>;tag=x', 'Call-ID: call-xyz', 'CSeq: 2 BYE', 'Content-Length: 0', '', ''].join('\r\n');
    sock.emit('data', Buffer.from(bye, 'binary'));
    expect(ended).toBe(true);
    expect(sip.hasCall).toBe(false);
    expect(sock.last((w) => w.startsWith('SIP/2.0 200 OK'))).toBeDefined();
  });
});
