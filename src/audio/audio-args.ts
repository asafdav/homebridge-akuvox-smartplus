export interface DoorToHomekitArgs {
  /** SDP file describing the inbound G.711 RTP that Node forwards from the door. */
  sdpPath: string;
  hkAddress: string;
  hkPort: number;
  hkSsrc: number;
  payloadType: number;
  sampleRate: number;
  packetTime: number;
  /** base64(key+salt) HomeKit gave us to encrypt the audio it will play. */
  srtpParams: string;
}

/** ffmpeg: door G.711 RTP (via SDP) → Opus → SRTP to HomeKit. */
export function doorToHomekitArgs(a: DoorToHomekitArgs): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'pipe,udp,rtp,file',
    '-f', 'sdp', '-i', a.sdpPath,
    '-map', '0:a',
    '-c:a', 'libopus', '-application', 'voip', '-ac', '1', '-ar', String(a.sampleRate),
    '-frame_duration', String(a.packetTime),
    '-payload_type', String(a.payloadType), '-ssrc', String(a.hkSsrc),
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', a.srtpParams,
    `srtp://${a.hkAddress}:${a.hkPort}?rtcpport=${a.hkPort}&pkt_size=188`,
  ];
}

export interface HomekitToDoorArgs {
  /** SDP describing HomeKit's return audio (Opus, with SRTP crypto) that ffmpeg decrypts. */
  sdpPath: string;
  /** Local port where Node reads the re-encoded G.711 RTP and relays it out the symmetric socket. */
  forwardPort: number;
  doorPayloadType: number;
}

/** ffmpeg: HomeKit return Opus SRTP (via SDP) → G.711 μ-law RTP → localhost for the symmetric relay. */
export function homekitToDoorArgs(a: HomekitToDoorArgs): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'pipe,udp,rtp,file',
    '-f', 'sdp', '-i', a.sdpPath,
    '-map', '0:a',
    '-c:a', 'pcm_mulaw', '-ac', '1', '-ar', '8000',
    '-payload_type', String(a.doorPayloadType),
    '-f', 'rtp', `rtp://127.0.0.1:${a.forwardPort}?pkt_size=172`,
  ];
}

/** SDP describing the door's inbound G.711 RTP, fed to ffmpeg on a localhost port. */
export function doorInputSdp(localPort: number, payloadType: number, codec: 'PCMU' | 'PCMA'): string {
  return [
    'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=door', 'c=IN IP4 127.0.0.1', 't=0 0',
    `m=audio ${localPort} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} ${codec}/8000`,
    'a=ptime:20', 'a=recvonly', '',
  ].join('\r\n');
}

/** SDP describing HomeKit's return Opus audio, including the SRTP key for decryption. */
export function homekitReturnSdp(localPort: number, payloadType: number, sampleRate: number, srtpKeySaltB64: string): string {
  return [
    'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=homekit-return', 'c=IN IP4 127.0.0.1', 't=0 0',
    `m=audio ${localPort} RTP/SAVP ${payloadType}`,
    `a=rtpmap:${payloadType} opus/${sampleRate}/2`,
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${srtpKeySaltB64}`,
    'a=recvonly', '',
  ].join('\r\n');
}
