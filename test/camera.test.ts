import { describe, expect, it } from 'vitest';
import { snapshotArgs, videoStreamArgs } from '../src/camera/ffmpeg-args.js';
import { buildRtspUrl, buildStreamSources, findLocalCamera, normalizeMac, redactRtsp } from '../src/camera/rtsp.js';

const transportOf = (args: string[]): string => args[args.indexOf('-rtsp_transport') + 1]!;

describe('buildRtspUrl', () => {
  it('prefers vrtsp_server', () => {
    expect(buildRtspUrl({ vrtspServer: 'rtspsrv1.ecloud.akuvox.com:8601', relayHost: '1.2.3.4', mac: 'AABBCCDDEEFF', password: 'pw' }))
      .toBe('rtsp://ak:pw@rtspsrv1.ecloud.akuvox.com:8601/AABBCCDDEEFF');
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

  it('masks a Dahua URL with a percent-encoded password and a query string', () => {
    expect(redactRtsp('rtsp://viewer:p%40ss@192.168.1.230:554/cam/realmonitor?channel=1&subtype=1'))
      .toBe('rtsp://viewer:<redacted>@192.168.1.230:554/cam/realmonitor?channel=1&subtype=1');
  });
});

describe('ffmpeg args', () => {
  it('snapshot defaults to udp and honours the chosen transport', () => {
    expect(transportOf(snapshotArgs('rtsp://x', 640, 480))).toBe('udp');
    expect(transportOf(snapshotArgs('rtsp://x', 640, 480, 'tcp'))).toBe('tcp');
    expect(snapshotArgs('rtsp://x', 640, 480).at(-1)).toBe('-');
  });

  it('video stream carries the transport, SRTP suite, params and target', () => {
    const args = videoStreamArgs({
      rtspUrl: 'rtsp://x', transport: 'tcp', width: 640, height: 480, fps: 30, bitrateKbps: 299,
      payloadType: 99, ssrc: 12345, srtpParams: 'BASE64', targetAddress: '10.0.0.5', targetPort: 50000, mtu: 1316,
    });
    expect(transportOf(args)).toBe('tcp');
    expect(args).toContain('AES_CM_128_HMAC_SHA1_80');
    expect(args).toContain('BASE64');
    expect(args.at(-1)).toBe('srtp://10.0.0.5:50000?rtcpport=50000&pkt_size=1316');
    expect(args).toContain('libx264');
  });
});

describe('buildStreamSources', () => {
  const local = { url: 'rtsp://nvr/local', transport: 'tcp' as const };
  it('puts local first, then cloud (udp)', () => {
    const sources = buildStreamSources(local, 'rtsp://cloud/url');
    expect(sources.map((s) => s.label)).toEqual(['local', 'cloud']);
    expect(sources[0]).toMatchObject({ url: 'rtsp://nvr/local', transport: 'tcp', label: 'local' });
    expect(sources[1]).toMatchObject({ url: 'rtsp://cloud/url', transport: 'udp', label: 'cloud' });
  });

  it('cloud only', () => {
    expect(buildStreamSources(undefined, 'rtsp://cloud/url').map((s) => s.label)).toEqual(['cloud']);
  });

  it('local only', () => {
    expect(buildStreamSources(local, undefined).map((s) => s.label)).toEqual(['local']);
  });

  it('empty when neither is available', () => {
    expect(buildStreamSources(undefined, undefined)).toEqual([]);
  });
});

describe('camera MAC matching', () => {
  const cameras = [{ mac: '0C:11:05:2A:60:95', rtspUrl: 'rtsp://nvr/1' }];
  it('ignores case and separators', () => {
    expect(normalizeMac('0C:11:05:2A:60:95')).toBe('0c11052a6095');
    expect(findLocalCamera(cameras, '0c11052a6095')?.rtspUrl).toBe('rtsp://nvr/1');
    expect(findLocalCamera(cameras, '0C-11-05-2A-60-95')?.rtspUrl).toBe('rtsp://nvr/1');
  });
  it('returns undefined for a non-match or empty config', () => {
    expect(findLocalCamera(cameras, 'AABBCCDDEEFF')).toBeUndefined();
    expect(findLocalCamera(undefined, '0c11052a6095')).toBeUndefined();
  });
});
