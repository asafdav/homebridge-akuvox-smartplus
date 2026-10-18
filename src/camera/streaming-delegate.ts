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
import { snapshotArgs, videoStreamArgs } from './ffmpeg-args.js';
import { redactRtsp } from './rtsp.js';

interface SessionInfo {
  address: string;
  videoPort: number;
  videoSSRC: number;
  videoSRTP: string;
}

const SNAPSHOT_TIMEOUT_MS = 10_000;

/** Streams the door camera's cloud RTSP to HomeKit as SRTP, and serves JPEG snapshots. */
export class AkuvoxStreamingDelegate implements CameraStreamingDelegate {
  controller!: CameraController;
  private readonly pending = new Map<string, SessionInfo>();
  private readonly ongoing = new Map<string, ChildProcess>();

  constructor(
    private readonly api: API,
    private readonly log: Logging,
    private readonly getRtspUrl: () => string | undefined,
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
    this.pending.set(request.sessionID, {
      address: request.targetAddress,
      videoPort: request.video.port,
      videoSSRC,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]).toString('base64'),
    });
    callback(undefined, {
      video: {
        port: request.video.port,
        ssrc: videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
    });
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
    const args = videoStreamArgs({
      rtspUrl: url,
      width: v.width,
      height: v.height,
      fps: v.fps,
      bitrateKbps: v.max_bit_rate,
      payloadType: v.pt,
      ssrc: info.videoSSRC,
      srtpParams: info.videoSRTP,
      targetAddress: info.address,
      targetPort: info.videoPort,
      mtu: v.mtu,
    });

    this.log.info(`Starting camera stream from ${redactRtsp(url)}`);
    const proc = spawn('ffmpeg', args, { env: process.env });
    this.ongoing.set(request.sessionID, proc);

    let started = false;
    const ready = () => {
      if (started) return;
      started = true;
      callback();
    };
    proc.stderr.on('data', (d: Buffer) => {
      if (d.toString().includes('frame=')) ready();
    });
    proc.on('error', (e) => {
      this.log.error(`Camera ffmpeg error: ${e.message}`);
      if (!started) {
        started = true;
        callback(e);
      }
    });
    proc.on('close', (code) => {
      this.ongoing.delete(request.sessionID);
      if (!started) {
        started = true;
        callback(new Error(`camera ffmpeg exited ${code} before streaming`));
      }
    });
    setTimeout(ready, 4000);
  }

  private stopStream(sessionID: string): void {
    const proc = this.ongoing.get(sessionID);
    if (proc) {
      proc.kill('SIGKILL');
      this.ongoing.delete(sessionID);
    }
    this.pending.delete(sessionID);
  }

  /** Kill any live ffmpeg so a Homebridge restart leaves no orphaned streams. */
  shutdownStreams(): void {
    for (const proc of this.ongoing.values()) proc.kill('SIGKILL');
    this.ongoing.clear();
    this.pending.clear();
  }
}
