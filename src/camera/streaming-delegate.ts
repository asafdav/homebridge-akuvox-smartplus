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
import { redactRtsp } from './rtsp.js';

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
const SAMPLERATE_HZ = [8000, 16000, 24000];
const DOOR_LOCAL_AUDIO_PORT = 41000;

export class AkuvoxStreamingDelegate implements CameraStreamingDelegate {
  controller!: CameraController;
  private readonly pending = new Map<string, SessionInfo>();
  private readonly ongoing = new Map<string, ChildProcess>();
  private readonly bridges = new Map<string, AudioBridge>();

  constructor(
    private readonly api: API,
    private readonly log: Logging,
    private readonly getRtspUrl: () => string | undefined,
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

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const url = this.getRtspUrl();
    if (!url) {
      callback(new Error('camera stream URL unavailable'));
      return;
    }
    const proc = spawn('ffmpeg', snapshotArgs(url, request.width, request.height), { env: process.env });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        this.log.error(`Snapshot failed: ${error.message}`);
        callback(error);
      } else {
        callback(undefined, Buffer.concat(chunks));
      }
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(new Error('snapshot timed out'));
    }, SNAPSHOT_TIMEOUT_MS);
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('error', (e) => finish(e));
    proc.on('close', (code) => finish(code === 0 && chunks.length > 0 ? undefined : new Error(`ffmpeg exited ${code}`)));
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
    const url = this.getRtspUrl();
    if (!info || !url) {
      callback(new Error('no prepared session or stream URL'));
      return;
    }

    const v = request.video;
    const proc = spawn('ffmpeg', videoStreamArgs({
      rtspUrl: url, width: v.width, height: v.height, fps: v.fps, bitrateKbps: v.max_bit_rate,
      payloadType: v.pt, ssrc: info.videoSSRC, srtpParams: info.videoSRTP,
      targetAddress: info.address, targetPort: info.videoPort, mtu: v.mtu,
    }), { env: process.env });
    this.ongoing.set(request.sessionID, proc);
    this.log.info(`Starting camera stream from ${redactRtsp(url)}`);

    this.maybeStartTwoWayAudio(request, info);

    let started = false;
    const ready = () => { if (!started) { started = true; callback(); } };
    proc.stderr.on('data', (d: Buffer) => { if (d.toString().includes('frame=')) ready(); });
    proc.on('error', (e) => { this.log.error(`Camera ffmpeg error: ${e.message}`); if (!started) { started = true; callback(e); } });
    proc.on('close', (code) => { this.ongoing.delete(request.sessionID); if (!started) { started = true; callback(new Error(`camera ffmpeg exited ${code}`)); } });
    setTimeout(ready, 4000);
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

  shutdownStreams(): void {
    for (const proc of this.ongoing.values()) proc.kill('SIGKILL');
    for (const bridge of this.bridges.values()) bridge.stop();
    this.ongoing.clear();
    this.bridges.clear();
    this.pending.clear();
  }
}
