import { type ChildProcess, spawn } from 'node:child_process';
import type {
  API,
  CameraController,
  CameraStreamingDelegate,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import { AudioBridge } from '../audio/audio-bridge.js';
import { snapshotArgs, videoStreamArgs } from './ffmpeg-args.js';
import { redactRtsp, type StreamSource } from './rtsp.js';

/** Answers and ends the door SIP call on behalf of a camera stream; implemented by the platform. */
export interface CallController {
  readonly localAddress: string;
  hasPendingCall(): boolean;
  /** Answer with our audio on `localAudioPort`; returns the door's RTP endpoint. */
  answer(localAudioPort: number): { address: string; audioPort: number; payloadType: number } | undefined;
  hangup(): void;
}

interface SessionInfo {
  address: string;
  videoPort: number;
  videoSSRC: number;
  videoSRTP: string;
  audioPort?: number;
  audioSSRC: number;
  audioSRTP?: string;
}

const SNAPSHOT_TIMEOUT_MS = 10_000;
// We serve the cached frame instantly, so a thumbnail up to this old is fine; this bounds how
// often HomeKit's background polling spawns an ffmpeg grab.
const SNAPSHOT_REFRESH_MS = 30_000;
// 1x1 JPEG, returned only before the first real frame exists, so a notification never waits on a fetch.
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwA//9k=',
  'base64',
);
const SAMPLERATE_HZ = [8000, 16000, 24000];
const DOOR_LOCAL_AUDIO_PORT = 41000;

export class AkuvoxStreamingDelegate implements CameraStreamingDelegate {
  controller!: CameraController;
  private readonly pending = new Map<string, SessionInfo>();
  private readonly ongoing = new Map<string, ChildProcess>();
  private readonly bridges = new Map<string, AudioBridge>();
  private cachedSnapshot?: { buf: Buffer; at: number };
  private fetchingSnapshot = false;

  constructor(
    private readonly api: API,
    private readonly log: Logging,
    private readonly getSources: () => StreamSource[],
    private readonly calls?: CallController,
  ) {}

  attachController(): CameraController {
    const h = this.api.hap;
    this.controller = new h.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [h.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          codec: {
            profiles: [h.H264Profile.BASELINE, h.H264Profile.MAIN],
            levels: [h.H264Level.LEVEL3_1, h.H264Level.LEVEL4_0],
          },
          resolutions: [
            [640, 480, 30],
            [640, 480, 15],
            [480, 360, 30],
            [320, 240, 15],
          ],
        },
        audio: {
          twoWayAudio: !!this.calls,
          codecs: [
            { type: h.AudioStreamingCodecType.OPUS, samplerate: [h.AudioStreamingSamplerate.KHZ_16, h.AudioStreamingSamplerate.KHZ_24] },
          ],
        },
      },
    });
    return this.controller;
  }

  handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    // Never block: answer immediately with the latest frame (or a placeholder), so the doorbell
    // push goes out without waiting on a fetch. Refresh in the background for next time.
    const cached = this.cachedSnapshot;
    callback(undefined, cached ? cached.buf : PLACEHOLDER_JPEG);
    void this.refreshSnapshot();
  }

  /** Grab a fresh frame into the cache, unless one is already in flight or the cache is still fresh. */
  async warmSnapshot(): Promise<void> {
    await this.refreshSnapshot(true);
  }

  private async refreshSnapshot(force = false): Promise<void> {
    if (this.fetchingSnapshot) return;
    if (!force && this.cachedSnapshot && Date.now() - this.cachedSnapshot.at < SNAPSHOT_REFRESH_MS) return;
    this.fetchingSnapshot = true;
    try {
      const buf = await this.fetchSnapshot(640, 480);
      this.cachedSnapshot = { buf, at: Date.now() };
    } catch (error) {
      this.log.warn(`Snapshot refresh failed: ${(error as Error).message}`);
    } finally {
      this.fetchingSnapshot = false;
    }
  }

  private async fetchSnapshot(width: number, height: number): Promise<Buffer> {
    const sources = this.getSources();
    if (sources.length === 0) throw new Error('no camera stream source');
    let lastError: Error | undefined;
    for (const source of sources) {
      try {
        return await this.grabFrame(source, width, height);
      } catch (error) {
        lastError = error as Error;
        this.log.warn(`Snapshot via ${source.label} failed: ${lastError.message}`);
      }
    }
    throw lastError ?? new Error('all snapshot sources failed');
  }

  private grabFrame(source: StreamSource, width: number, height: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const proc = spawn('ffmpeg', snapshotArgs(source.url, width, height, source.transport), { env: process.env });
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (error?: Error, buf?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(buf!);
      };
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        finish(new Error('snapshot timed out'));
      }, SNAPSHOT_TIMEOUT_MS);
      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.on('error', (e) => finish(e));
      proc.on('close', (code) => finish(code === 0 && chunks.length > 0 ? undefined : new Error(`ffmpeg exited ${code}`), Buffer.concat(chunks)));
    });
  }

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const videoSSRC = this.api.hap.CameraController.generateSynchronisationSource();
    const audioSSRC = this.api.hap.CameraController.generateSynchronisationSource();
    const info: SessionInfo = {
      address: request.targetAddress,
      videoPort: request.video.port,
      videoSSRC,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]).toString('base64'),
      audioSSRC,
    };
    const response: Parameters<PrepareStreamCallback>[1] = {
      video: { port: request.video.port, ssrc: videoSSRC, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
    };
    if (request.audio) {
      info.audioPort = request.audio.port;
      info.audioSRTP = Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]).toString('base64');
      response.audio = { port: request.audio.port, ssrc: audioSSRC, srtp_key: request.audio.srtp_key, srtp_salt: request.audio.srtp_salt };
    }
    this.pending.set(request.sessionID, info);
    callback(undefined, response);
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    if (request.type === 'start') {
      this.startStream(request, callback);
    } else if (request.type === 'reconfigure') {
      callback();
    } else {
      this.stopStream(request.sessionID);
      callback();
    }
  }

  private startStream(request: Extract<StreamingRequest, { type: 'start' }>, callback: StreamRequestCallback): void {
    const info = this.pending.get(request.sessionID);
    const sources = this.getSources();
    if (!info || sources.length === 0) {
      callback(new Error('no prepared session or stream source'));
      return;
    }

    let started = false;
    const done = (error?: Error) => {
      if (started) return;
      started = true;
      if (error) callback(error);
      else callback();
    };

    const spawnSource = (index: number): void => {
      const source = sources[index];
      if (!source) {
        done(new Error('all camera stream sources failed'));
        return;
      }
      const v = request.video;
      const proc = spawn('ffmpeg', videoStreamArgs({
        rtspUrl: source.url, transport: source.transport, width: v.width, height: v.height, fps: v.fps,
        bitrateKbps: v.max_bit_rate, payloadType: v.pt, ssrc: info.videoSSRC, srtpParams: info.videoSRTP,
        targetAddress: info.address, targetPort: info.videoPort, mtu: v.mtu,
      }), { env: process.env });
      this.ongoing.set(request.sessionID, proc);
      this.log.info(`Starting camera stream (${source.label}) from ${redactRtsp(source.url)}`);
      proc.stderr.on('data', (d: Buffer) => { if (d.toString().includes('frame=')) done(); });
      proc.on('error', (e) => this.log.error(`Camera ffmpeg error (${source.label}): ${e.message}`));
      proc.on('close', (code) => {
        this.ongoing.delete(request.sessionID);
        // Respawn on the next source only if it died before streaming and wasn't stopped by HomeKit.
        if (started || !this.pending.has(request.sessionID)) return;
        this.log.warn(`Camera stream (${source.label}) ended before first frame (code ${code}); trying next source`);
        spawnSource(index + 1);
      });
    };

    spawnSource(0);
    this.maybeStartTwoWayAudio(request, info);
    setTimeout(() => done(), 4000);
  }

  /** If HomeKit opened the mic during an active ring, answer the call and bridge audio. */
  private maybeStartTwoWayAudio(request: Extract<StreamingRequest, { type: 'start' }>, info: SessionInfo): void {
    const audio = request.audio;
    if (!this.calls || !audio || !info.audioPort || !info.audioSRTP) return;
    if (!this.calls.hasPendingCall()) return;

    const door = this.calls.answer(DOOR_LOCAL_AUDIO_PORT);
    if (!door) {
      this.log.warn('Tried to answer the door call but no call was pending');
      return;
    }
    const bridge = new AudioBridge(this.log);
    this.bridges.set(request.sessionID, bridge);
    bridge.start({
      door: { address: door.address, port: door.audioPort, payloadType: door.payloadType, codec: door.payloadType === 8 ? 'PCMA' : 'PCMU' },
      homekit: {
        address: info.address,
        audioPort: info.audioPort,
        ssrc: info.audioSSRC,
        payloadType: audio.pt,
        sampleRate: SAMPLERATE_HZ[audio.sample_rate] ?? 24000,
        packetTime: audio.packet_time ?? 20,
        outgoingSrtp: info.audioSRTP,
        incomingSrtp: info.audioSRTP,
      },
      localAudioPort: DOOR_LOCAL_AUDIO_PORT,
      homekitReturnPort: info.audioPort,
    });
    this.log.info('Two-way audio active for this call');
  }

  private stopStream(sessionID: string): void {
    this.ongoing.get(sessionID)?.kill('SIGKILL');
    this.ongoing.delete(sessionID);
    const bridge = this.bridges.get(sessionID);
    if (bridge) {
      bridge.stop();
      this.bridges.delete(sessionID);
      this.calls?.hangup();
    }
    this.pending.delete(sessionID);
  }

  /** Tear down audio bridges when the door call ends, even if HomeKit keeps the video stream open. */
  endCalls(): void {
    for (const [id, bridge] of this.bridges) {
      bridge.stop();
      this.bridges.delete(id);
    }
  }

  shutdownStreams(): void {
    for (const proc of this.ongoing.values()) proc.kill('SIGKILL');
    for (const bridge of this.bridges.values()) bridge.stop();
    this.ongoing.clear();
    this.bridges.clear();
    this.pending.clear();
  }
}
