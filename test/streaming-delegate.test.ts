import { EventEmitter } from 'node:events';
import type { API } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable fake ffmpeg processes, one per spawn() call, driven by a queued behavior.
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  constructor(public args: string[]) {
    super();
  }
}
const procs: FakeProc[] = [];
type Behavior = (p: FakeProc) => void;
const behaviors: Behavior[] = [];
const spawnMock = vi.fn((_cmd: string, args: string[]) => {
  const p = new FakeProc(args);
  procs.push(p);
  const behavior = behaviors.shift();
  if (behavior) setImmediate(() => behavior(p));
  return p;
});
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(a[0] as string, a[1] as string[]) }));

const { AkuvoxStreamingDelegate } = await import('../src/camera/streaming-delegate.js');

const snapshotOk: Behavior = (p) => { p.stdout.emit('data', Buffer.from([0xff, 0xd8, 0xff])); p.emit('close', 0); };
const snapshotFail: Behavior = (p) => p.emit('close', 1);
const streamStarts: Behavior = (p) => p.stderr.emit('data', Buffer.from('frame=  1 fps=25'));
const streamDiesEarly: Behavior = (p) => p.emit('close', 1);

const api = { hap: { CameraController: { generateSynchronisationSource: () => 1 } } } as unknown as API;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const sources = [
  { url: 'rtsp://local/feed', transport: 'tcp' as const, label: 'local' as const },
  { url: 'rtsp://cloud/feed', transport: 'udp' as const, label: 'cloud' as const },
];
const urlOf = (p: FakeProc) => p.args[p.args.indexOf('-i') + 1];

function prepared(delegate: InstanceType<typeof AkuvoxStreamingDelegate>, sessionID = 's1'): void {
  const key = Buffer.alloc(16);
  delegate.prepareStream(
    { sessionID, targetAddress: '10.0.0.5', video: { port: 50000, srtp_key: key, srtp_salt: key } } as never,
    () => {},
  );
}
const startReq = (sessionID = 's1') => ({
  type: 'start', sessionID,
  video: { width: 640, height: 480, fps: 30, max_bit_rate: 299, pt: 99, mtu: 1316 },
} as never);

describe('AkuvoxStreamingDelegate source fallback', () => {
  beforeEach(() => {
    procs.length = 0;
    behaviors.length = 0;
    spawnMock.mockClear();
  });
  afterEach(() => vi.clearAllTimers());

  it('snapshot falls back to the cloud source when local fails', async () => {
    behaviors.push(snapshotFail, snapshotOk);
    const delegate = new AkuvoxStreamingDelegate(api, log, () => sources);
    await delegate.warmSnapshot();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(urlOf(procs[0]!)).toBe('rtsp://local/feed');
    expect(urlOf(procs[1]!)).toBe('rtsp://cloud/feed');
  });

  it('live stream respawns on the next source when the first dies before a frame, calling back once', async () => {
    behaviors.push(streamDiesEarly, streamStarts);
    const delegate = new AkuvoxStreamingDelegate(api, log, () => sources);
    prepared(delegate);
    const callback = vi.fn();
    delegate.handleStreamRequest(startReq(), callback);

    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback).toHaveBeenCalledWith(); // no error
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(urlOf(procs[0]!)).toBe('rtsp://local/feed');
    expect(urlOf(procs[1]!)).toBe('rtsp://cloud/feed');
  });

  it('does not respawn when the first source starts then exits later', async () => {
    behaviors.push(streamStarts);
    const delegate = new AkuvoxStreamingDelegate(api, log, () => sources);
    prepared(delegate);
    const callback = vi.fn();
    delegate.handleStreamRequest(startReq(), callback);

    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    procs[0]!.emit('close', 0); // mid-stream exit after it had started
    await new Promise((r) => setImmediate(r));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
