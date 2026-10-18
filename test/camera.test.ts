import { describe, expect, it } from 'vitest';
import { snapshotArgs, videoStreamArgs } from '../src/camera/ffmpeg-args.js';
import { buildRtspUrl, redactRtsp } from '../src/camera/rtsp.js';

describe('buildRtspUrl', () => {
  it('prefers vrtsp_server', () => {
    expect(buildRtspUrl({ vrtspServer: 'rtspsrv1.ecloud.akuvox.com:8601', relayHost: '1.2.3.4', mac: '0C11052A6095', password: 'pw' }))
      .toBe('rtsp://ak:pw@rtspsrv1.ecloud.akuvox.com:8601/0C11052A6095');
  });

  it('falls back to the relay host on :554', () => {
    expect(buildRtspUrl({ relayHost: '1.2.3.4', mac: 'MAC', password: 'pw' })).toBe('rtsp://ak:pw@1.2.3.4:554/MAC');
  });

  it('url-encodes the password and returns undefined with no host', () => {
    expect(buildRtspUrl({ relayHost: 'h', mac: 'm', password: 'p@ss word' })).toBe('rtsp://ak:p%40ss%20word@h:554/m');
    expect(buildRtspUrl({ mac: 'm', password: 'p' })).toBeUndefined();
  });
});

describe('redactRtsp', () => {
  it('masks the password', () => {
    expect(redactRtsp('rtsp://ak:secret@host:554/MAC')).toBe('rtsp://ak:<redacted>@host:554/MAC');
  });
});

describe('ffmpeg args', () => {
  it('snapshot grabs one scaled JPEG frame over udp', () => {
    const args = snapshotArgs('rtsp://x', 640, 480);
    expect(args).toContain('-rtsp_transport');
    expect(args[args.indexOf('-rtsp_transport') + 1]).toBe('udp');
    expect(args).toContain('-frames:v');
    expect(args.at(-1)).toBe('-');
  });

  it('video stream carries the SRTP suite, params and target', () => {
    const args = videoStreamArgs({
      rtspUrl: 'rtsp://x', width: 640, height: 480, fps: 30, bitrateKbps: 299,
      payloadType: 99, ssrc: 12345, srtpParams: 'BASE64', targetAddress: '10.0.0.5', targetPort: 50000, mtu: 1316,
    });
    expect(args).toContain('AES_CM_128_HMAC_SHA1_80');
    expect(args).toContain('BASE64');
    expect(args.at(-1)).toBe('srtp://10.0.0.5:50000?rtcpport=50000&pkt_size=1316');
    expect(args).toContain('libx264');
  });
});
