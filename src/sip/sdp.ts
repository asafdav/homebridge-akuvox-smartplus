export interface MediaOffer {
  /** Connection address the far side will send/receive RTP on (session or media level). */
  address: string;
  audio?: {
    port: number;
    /** Dynamic/static payload types offered, in order. */
    payloadTypes: number[];
    /** Payload type for PCMU (0) if offered. */
    pcmu?: number;
    /** Payload type for PCMA (8) if offered. */
    pcma?: number;
    /** Payload type for RFC 2833 telephone-event (DTMF) if offered. */
    telephoneEvent?: number;
  };
  videoPort?: number;
  /** True when any media line used an SRTP/secure profile rather than plain RTP/AVP. */
  secure: boolean;
}

/** Parse the parts of a door-station SDP offer that the audio bridge needs. */
export function parseSdpOffer(sdp: string): MediaOffer {
  const lines = sdp.split(/\r?\n/);
  let sessionAddress = '';
  let audioAddress = '';
  let secure = false;
  let audio: MediaOffer['audio'];
  let videoPort: number | undefined;
  let current: 'session' | 'audio' | 'video' = 'session';

  for (const line of lines) {
    if (line.startsWith('c=')) {
      const ip = line.match(/IN IP4 ([0-9.]+)/)?.[1];
      if (ip) {
        if (current === 'session') sessionAddress = ip;
        else if (current === 'audio') audioAddress = ip;
      }
      continue;
    }
    if (line.startsWith('m=audio ')) {
      current = 'audio';
      const [, portStr, proto, ...pts] = line.split(' ');
      if (/SAVP|SRTP/i.test(proto ?? '')) secure = true;
      audio = { port: Number(portStr), payloadTypes: pts.map(Number).filter((n) => !Number.isNaN(n)) };
      continue;
    }
    if (line.startsWith('m=video ')) {
      current = 'video';
      const [, portStr, proto] = line.split(' ');
      if (/SAVP|SRTP/i.test(proto ?? '')) secure = true;
      videoPort = Number(portStr);
      continue;
    }
    if (line.startsWith('a=rtpmap:') && audio && current === 'audio') {
      const m = line.match(/a=rtpmap:(\d+)\s+([A-Za-z0-9-]+)\/(\d+)/);
      if (m) {
        const pt = Number(m[1]);
        const name = m[2]!.toUpperCase();
        if (name === 'PCMU') audio.pcmu = pt;
        else if (name === 'PCMA') audio.pcma = pt;
        else if (name === 'TELEPHONE-EVENT') audio.telephoneEvent = pt;
      }
    }
  }

  // A media-level c= on audio wins; otherwise fall back to the session address.
  return { address: audioAddress || sessionAddress, audio, videoPort, secure };
}

export interface AudioAnswerParams {
  /** Our local address the far side should send RTP to. */
  localAddress: string;
  localAudioPort: number;
  /** Payload type to use for G.711 (echo the offer's number). */
  payloadType: number;
  payloadName: 'PCMU' | 'PCMA';
  telephoneEvent?: number;
  /** Video port from the offer, declined by answering 0. */
  offeredVideoPort?: number;
}

/** Build an audio-only SDP answer: accept G.711 two-way, decline video. */
export function buildAudioAnswer(p: AudioAnswerParams): string {
  const sessionId = Date.now();
  const pts = [String(p.payloadType), ...(p.telephoneEvent !== undefined ? [String(p.telephoneEvent)] : [])];
  const lines = [
    'v=0',
    `o=homebridge ${sessionId} ${sessionId} IN IP4 ${p.localAddress}`,
    's=akuvox-smartplus',
    `c=IN IP4 ${p.localAddress}`,
    't=0 0',
    `m=audio ${p.localAudioPort} RTP/AVP ${pts.join(' ')}`,
    `a=rtpmap:${p.payloadType} ${p.payloadName}/8000`,
    ...(p.telephoneEvent !== undefined ? [`a=rtpmap:${p.telephoneEvent} telephone-event/8000`, `a=fmtp:${p.telephoneEvent} 0-16`] : []),
    'a=ptime:20',
    'a=sendrecv',
  ];
  if (p.offeredVideoPort !== undefined) {
    // Decline video: port 0 keeps the m-line order the offerer expects.
    lines.push('m=video 0 RTP/AVP 104');
  }
  return lines.join('\r\n') + '\r\n';
}
