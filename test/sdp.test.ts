import { describe, expect, it } from 'vitest';
import { buildAudioAnswer, parseSdpOffer } from '../src/sip/sdp.js';

// The exact offer captured from a real door-station ring.
const realOffer = [
  'v=0',
  'o=FS 1792296728 1792296729 IN IP4 3.79.120.60',
  'c=IN IP4 3.79.120.60',
  't=0 0',
  'm=audio 18022 RTP/AVP 0 8 101',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:101 telephone-event/8000',
  'a=fmtp:101 0-16',
  'a=ptime:20',
  'm=video 23112 RTP/AVP 104',
  'a=rtpmap:104 H264/90000',
].join('\r\n');

describe('parseSdpOffer', () => {
  it('reads the audio endpoint, codecs and video from the real offer', () => {
    const o = parseSdpOffer(realOffer);
    expect(o.address).toBe('3.79.120.60');
    expect(o.secure).toBe(false);
    expect(o.audio).toMatchObject({ port: 18022, pcmu: 0, pcma: 8, telephoneEvent: 101 });
    expect(o.videoPort).toBe(23112);
  });

  it('flags a secure profile as such', () => {
    const o = parseSdpOffer('m=audio 100 RTP/SAVP 0\r\na=rtpmap:0 PCMU/8000');
    expect(o.secure).toBe(true);
  });

  it('prefers a media-level connection address over the session one', () => {
    const o = parseSdpOffer('c=IN IP4 1.1.1.1\r\nm=audio 200 RTP/AVP 0\r\nc=IN IP4 2.2.2.2\r\na=rtpmap:0 PCMU/8000');
    expect(o.address).toBe('2.2.2.2');
  });
});

describe('buildAudioAnswer', () => {
  it('accepts G.711 two-way and declines video with port 0', () => {
    const answer = buildAudioAnswer({ localAddress: '192.168.1.197', localAudioPort: 40000, payloadType: 0, payloadName: 'PCMU', telephoneEvent: 101, offeredVideoPort: 23112 });
    expect(answer).toContain('m=audio 40000 RTP/AVP 0 101');
    expect(answer).toContain('a=rtpmap:0 PCMU/8000');
    expect(answer).toContain('a=sendrecv');
    expect(answer).toContain('m=video 0 RTP/AVP 104');
    expect(answer).toContain('c=IN IP4 192.168.1.197');
  });

  it('omits video when none was offered', () => {
    const answer = buildAudioAnswer({ localAddress: '10.0.0.1', localAudioPort: 5000, payloadType: 8, payloadName: 'PCMA' });
    expect(answer).not.toContain('m=video');
    expect(answer).toContain('m=audio 5000 RTP/AVP 8');
  });
});
