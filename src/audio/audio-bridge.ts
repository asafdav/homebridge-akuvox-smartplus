import { type ChildProcess, spawn } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doorInputSdp, doorToHomekitArgs, homekitReturnSdp, homekitToDoorArgs } from './audio-args.js';

export interface BridgeLogger {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}

export interface BridgeParams {
  door: { address: string; port: number; payloadType: number; codec: 'PCMU' | 'PCMA' };
  homekit: {
    address: string;
    audioPort: number;
    ssrc: number;
    payloadType: number;
    sampleRate: number;
    packetTime: number;
    /** base64(key+salt) to encrypt audio we send to HomeKit. */
    outgoingSrtp: string;
    /** base64(key+salt) to decrypt HomeKit's return audio. */
    incomingSrtp: string;
  };
  /** The RTP port we advertised to the door in the SDP answer; our symmetric socket binds here. */
  localAudioPort: number;
  /** The port HomeKit sends its return audio to (what we returned in prepareStream). */
  homekitReturnPort: number;
}

const PCMU_SILENCE = 0xff;
const SAMPLES_PER_FRAME = 160; // 20 ms of 8 kHz

/**
 * Bridges door audio (plain G.711 RTP via a public relay) to HomeKit (Opus SRTP) and back.
 * Node owns one symmetric socket to the relay so return audio latches through home NAT;
 * ffmpeg does codec + SRTP on localhost only.
 */
export class AudioBridge {
  private relaySocket?: UdpSocket;
  private returnSocket?: UdpSocket;
  private doorToHk?: ChildProcess;
  private hkToDoor?: ChildProcess;
  private keepalive?: NodeJS.Timeout;
  private tmp?: string;
  private seq = Math.floor(Math.random() * 0xffff);
  private timestamp = Math.floor(Math.random() * 0xffffffff);
  private ssrc = Math.floor(Math.random() * 0xffffffff);
  private lastSentAt = 0;

  constructor(private readonly log: BridgeLogger) {}

  start(p: BridgeParams): void {
    this.tmp = mkdtempSync(join(tmpdir(), 'akuvox-audio-'));
    const doorFeedPort = p.localAudioPort + 2; // localhost: Node → ffmpeg(door→HK)
    const doorSdp = join(this.tmp, 'door.sdp');
    const hkSdp = join(this.tmp, 'hk.sdp');
    writeFileSync(doorSdp, doorInputSdp(doorFeedPort, p.door.payloadType, p.door.codec));
    writeFileSync(hkSdp, homekitReturnSdp(p.homekitReturnPort, p.homekit.payloadType, p.homekit.sampleRate, p.homekit.incomingSrtp));

    // Symmetric socket: receives door audio and sends our audio from the same port.
    const relay = createSocket('udp4');
    this.relaySocket = relay;
    relay.on('message', (msg) => relay.send(msg, doorFeedPort, '127.0.0.1'));
    relay.bind(p.localAudioPort, () => this.startKeepalive(p));

    // Node reads re-encoded G.711 from the HK→door ffmpeg and relays it out the symmetric socket.
    const ret = createSocket('udp4');
    this.returnSocket = ret;
    ret.on('message', (msg) => {
      this.lastSentAt = Date.now();
      this.relaySocket?.send(msg, p.door.port, p.door.address);
    });
    ret.bind(p.localAudioPort + 4);

    this.doorToHk = this.spawn('door→HomeKit', doorToHomekitArgs({
      sdpPath: doorSdp, hkAddress: p.homekit.address, hkPort: p.homekit.audioPort, hkSsrc: p.homekit.ssrc,
      payloadType: p.homekit.payloadType, sampleRate: p.homekit.sampleRate, packetTime: p.homekit.packetTime, srtpParams: p.homekit.outgoingSrtp,
    }));
    this.hkToDoor = this.spawn('HomeKit→door', homekitToDoorArgs({
      sdpPath: hkSdp, forwardPort: p.localAudioPort + 4, doorPayloadType: p.door.payloadType,
    }));
    this.log.info('Audio bridge started');
  }

  /** Keep the NAT mapping open and latched by sending G.711 silence when no real audio is flowing. */
  private startKeepalive(p: BridgeParams): void {
    this.keepalive = setInterval(() => {
      if (Date.now() - this.lastSentAt < 40) return;
      this.relaySocket?.send(this.silencePacket(p.door.payloadType), p.door.port, p.door.address);
    }, 20);
  }

  private silencePacket(payloadType: number): Buffer {
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = payloadType & 0x7f;
    this.seq = (this.seq + 1) & 0xffff;
    header.writeUInt16BE(this.seq, 2);
    this.timestamp = (this.timestamp + SAMPLES_PER_FRAME) >>> 0;
    header.writeUInt32BE(this.timestamp, 4);
    header.writeUInt32BE(this.ssrc, 8);
    return Buffer.concat([header, Buffer.alloc(SAMPLES_PER_FRAME, PCMU_SILENCE)]);
  }

  private spawn(label: string, args: string[]): ChildProcess {
    const proc = spawn('ffmpeg', args, { env: process.env });
    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) this.log.warn(`ffmpeg ${label}: ${text}`);
    });
    proc.on('error', (e) => this.log.error(`ffmpeg ${label} failed to start: ${e.message}`));
    return proc;
  }

  stop(): void {
    clearInterval(this.keepalive);
    this.doorToHk?.kill('SIGKILL');
    this.hkToDoor?.kill('SIGKILL');
    this.relaySocket?.close();
    this.returnSocket?.close();
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
    this.tmp = undefined;
    this.log.info('Audio bridge stopped');
  }
}
