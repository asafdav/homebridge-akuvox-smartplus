import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';

export interface SipMessage {
  start: string;
  headers: Map<string, string[]>;
  body: string;
}

export function parseSipMessage(raw: string): SipMessage {
  const [head = '', body = ''] = raw.split('\r\n\r\n');
  const [start = '', ...lines] = head.split('\r\n');
  const headers = new Map<string, string[]>();
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(i + 1).trim()]);
  }
  return { start, headers, body };
}

export const sipHeader = (m: SipMessage, name: string): string => m.headers.get(name)?.[0] ?? '';

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

export interface DigestInput {
  challenge: string;
  username: string;
  password: string;
  method: string;
  uri: string;
}

export function buildDigestAuth({ challenge, username, password, method, uri }: DigestInput): string {
  const field = (n: string) => challenge.match(new RegExp(`${n}="?([^",]+)"?`, 'i'))?.[1] ?? '';
  const realm = field('realm');
  const nonce = field('nonce');
  const qop = field('qop');
  const opaque = field('opaque');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const parts = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`, 'algorithm=MD5'];
  let response: string;
  if (qop) {
    const cnonce = randomBytes(6).toString('hex');
    const nc = '00000001';
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  parts.push(`response="${response}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export interface RingEvent {
  callerSip: string;
}

export interface SipLogger {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  debug?: (m: string) => void;
}

export interface SipListenerConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  registerExpires?: number;
}

/**
 * Registers the family-member SIP account on the Akuvox PBX and emits `ring` on an incoming
 * INVITE, answering only 180 Ringing so the household's other devices keep ringing.
 */
export class SipListener extends EventEmitter {
  private socket?: Socket;
  private running = false;
  private registered = false;
  private buffer = '';
  private cseq = 0;
  private currentExpires: number;
  private callId = randomUUID();
  private fromTag = randomBytes(6).toString('hex');
  private contactHost = '';
  private reconnectDelayMs = 2000;
  private reregisterTimer?: NodeJS.Timeout;

  private readonly expires: number;
  private readonly uri: string;
  private readonly aor: string;

  constructor(private readonly config: SipListenerConfig, private readonly log: SipLogger) {
    super();
    this.expires = config.registerExpires ?? 180;
    this.currentExpires = this.expires;
    this.uri = `sip:${config.host}`;
    this.aor = `sip:${config.user}@${config.host}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reregisterTimer);
    if (this.socket && this.registered) this.sendRegister(0);
    setTimeout(() => this.socket?.destroy(), 500);
  }

  private open(): void {
    this.registered = false;
    this.buffer = '';
    this.callId = randomUUID();
    this.fromTag = randomBytes(6).toString('hex');
    const socket = connect({ host: this.config.host, port: this.config.port });
    this.socket = socket;
    socket.on('connect', () => {
      this.contactHost = `${socket.localAddress}:${socket.localPort}`;
      this.reconnectDelayMs = 2000;
      this.sendRegister(this.expires);
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (e) => this.log.warn(`SIP socket error: ${e.message}`));
    socket.on('close', () => this.onClose());
  }

  private onClose(): void {
    this.registered = false;
    clearTimeout(this.reregisterTimer);
    if (!this.running) return;
    this.log.warn(`SIP disconnected; reconnecting in ${this.reconnectDelayMs / 1000}s`);
    setTimeout(() => this.running && this.open(), this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('binary');
    while (true) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) break;
      const head = this.buffer.slice(0, end);
      const contentLength = Number(head.match(/content-length:\s*(\d+)/i)?.[1] ?? 0);
      const total = end + 4 + contentLength;
      if (this.buffer.length < total) break;
      const raw = this.buffer.slice(0, total);
      this.buffer = this.buffer.slice(total);
      this.handle(parseSipMessage(raw));
    }
  }

  private handle(m: SipMessage): void {
    if (m.start.startsWith('SIP/2.0')) {
      this.handleResponse(m);
      return;
    }
    const method = m.start.split(' ')[0];
    if (method === 'INVITE') {
      this.respond(m, '180 Ringing');
      const callerSip = sipHeader(m, 'from').match(/sip:([^@;>]+)/)?.[1] ?? '';
      this.emit('ring', { callerSip } satisfies RingEvent);
    } else if (method === 'CANCEL' || method === 'BYE') {
      this.respond(m, '200 OK');
    } else if (method === 'OPTIONS') {
      this.respond(m, '200 OK');
    }
  }

  private handleResponse(m: SipMessage): void {
    if (!sipHeader(m, 'cseq').includes('REGISTER')) return;
    const status = m.start.slice(8);
    if (status.startsWith('401') || status.startsWith('407')) {
      const challenge = sipHeader(m, 'www-authenticate') || sipHeader(m, 'proxy-authenticate');
      this.sendRegister(this.currentExpires, buildDigestAuth({ challenge, username: this.config.user, password: this.config.password, method: 'REGISTER', uri: this.uri }));
    } else if (status.startsWith('200')) {
      if (this.currentExpires === 0) return;
      if (!this.registered) {
        this.registered = true;
        this.log.info('SIP registered; listening for doorbell rings');
      }
      clearTimeout(this.reregisterTimer);
      this.reregisterTimer = setTimeout(() => this.sendRegister(this.expires), (this.expires * 1000) / 2);
    } else {
      this.log.warn(`SIP REGISTER failed: ${status}`);
    }
  }

  private sendRegister(expires: number, authorization?: string): void {
    if (!this.socket) return;
    this.currentExpires = expires;
    this.cseq += 1;
    this.socket.write([
      `REGISTER ${this.uri} SIP/2.0`,
      `Via: SIP/2.0/TCP ${this.contactHost};branch=z9hG4bK${randomBytes(6).toString('hex')};rport`,
      'Max-Forwards: 70',
      `From: <${this.aor}>;tag=${this.fromTag}`,
      `To: <${this.aor}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq} REGISTER`,
      `Contact: <sip:${this.config.user}@${this.contactHost};transport=tcp>`,
      `Expires: ${expires}`,
      'User-Agent: homebridge-akuvox-smartplus/0',
      ...(authorization ? [`Authorization: ${authorization}`] : []),
      'Content-Length: 0',
      '', '',
    ].join('\r\n'));
  }

  private respond(invite: SipMessage, status: string): void {
    if (!this.socket) return;
    this.socket.write([
      `SIP/2.0 ${status}`,
      ...(invite.headers.get('via') ?? []).map((v) => `Via: ${v}`),
      `From: ${sipHeader(invite, 'from')}`,
      `To: ${sipHeader(invite, 'to')};tag=${randomBytes(6).toString('hex')}`,
      `Call-ID: ${sipHeader(invite, 'call-id')}`,
      `CSeq: ${sipHeader(invite, 'cseq')}`,
      `Contact: <sip:${this.config.user}@${this.contactHost};transport=tcp>`,
      'User-Agent: homebridge-akuvox-smartplus/0',
      'Content-Length: 0',
      '', '',
    ].join('\r\n'));
  }
}
