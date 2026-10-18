import { describe, expect, it } from 'vitest';
import { doorInputSdp, doorToHomekitArgs, homekitReturnSdp, homekitToDoorArgs } from '../src/audio/audio-args.js';

describe('doorToHomekitArgs', () => {
  it('encodes Opus and sends SRTP to HomeKit', () => {
    const args = doorToHomekitArgs({ sdpPath: '/t/door.sdp', hkAddress: '10.0.0.5', hkPort: 50000, hkSsrc: 1, payloadType: 110, sampleRate: 24000, packetTime: 20, srtpParams: 'OUT' });
    expect(args).toContain('libopus');
    expect(args).toContain('OUT');
    expect(args.at(-1)).toBe('srtp://10.0.0.5:50000?rtcpport=50000&pkt_size=188');
    expect(args).toContain('/t/door.sdp');
  });
});

describe('homekitToDoorArgs', () => {
  it('decodes to G.711 μ-law and forwards RTP to localhost', () => {
    const args = homekitToDoorArgs({ sdpPath: '/t/hk.sdp', forwardPort: 40004, doorPayloadType: 0 });
    expect(args).toContain('pcm_mulaw');
    expect(args.at(-1)).toBe('rtp://127.0.0.1:40004?pkt_size=172');
  });
});

describe('sdp builders', () => {
  it('door input SDP describes the G.711 RTP', () => {
    const sdp = doorInputSdp(40002, 0, 'PCMU');
    expect(sdp).toContain('m=audio 40002 RTP/AVP 0');
    expect(sdp).toContain('a=rtpmap:0 PCMU/8000');
  });

  it('HomeKit return SDP carries the SRTP crypto for decryption', () => {
    const sdp = homekitReturnSdp(50000, 110, 24000, 'KEYSALT');
    expect(sdp).toContain('m=audio 50000 RTP/SAVP 110');
    expect(sdp).toContain('a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:KEYSALT');
    expect(sdp).toContain('a=rtpmap:110 opus/24000/2');
  });
});
