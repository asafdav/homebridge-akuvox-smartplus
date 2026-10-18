import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { payload, readSession, request, type Envelope } from './akuvox-cloud.ts';

const LISTEN_SECONDS = Number(process.argv[2] ?? 120);
const REGISTER_EXPIRES = Math.max(60, Math.min(LISTEN_SECONDS + 30, 600));

const session = readSession();
if (!session) throw new Error('no session, run login.ts first');

const conf = payload((await request(`https://${session.restServer}/userconf?token=${session.token}`, '7.13', { headers: { 'x-auth-token': session.token } })).envelope);
const app = conf.app_conf as Envelope;
const servers = payload((await request('https://gate.ecloud.akuvox.com:8600/servers_list', '6.8', { headers: { 'x-auth-token': session.token } })).envelope);

const [host, portStr] = (servers.pbx_server as string).split(':');
const port = Number(portStr);
const sipUser = app.sip as string;
const sipPassword = app.sip_passwd as string;
const doorSips = new Map(((conf.dev_list as Envelope[]) ?? []).map((d) => [d.sip as string, d.location as string]));

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const secrets = [sipUser, sipPassword, ...doorSips.keys()].filter(Boolean);
const mask = (s: string) => secrets.reduce((acc, v) => acc.split(v).join('<redacted>'), s);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const tag = () => randomBytes(6).toString('hex');

interface Msg { start: string; headers: Map<string, string[]>; body: string; raw: string }

function parse(raw: string): Msg {
  const [head, body = ''] = raw.split('\r\n\r\n');
  const [start, ...lines] = head.split('\r\n');
  const headers = new Map<string, string[]>();
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(i + 1).trim()]);
  }
  return { start, headers, body, raw };
}
const h1 = (m: Msg, name: string) => m.headers.get(name)?.[0] ?? '';

function digest(challenge: string, method: string, uri: string): string {
  const field = (n: string) => challenge.match(new RegExp(`${n}="?([^",]+)"?`, 'i'))?.[1] ?? '';
  const realm = field('realm');
  const nonce = field('nonce');
  const qop = field('qop');
  const opaque = field('opaque');
  const ha1 = md5(`${sipUser}:${realm}:${sipPassword}`);
  const ha2 = md5(`${method}:${uri}`);
  const parts = [`username="${sipUser}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`, 'algorithm=MD5'];
  let response: string;
  if (qop) {
    const cnonce = tag();
    const nc = '00000001';
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  parts.push(`response="${response}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

const socket: Socket = connect({ host, port });
await new Promise<void>((resolve, reject) => socket.once('connect', () => resolve()).once('error', reject));
const contactHost = `${socket.localAddress}:${socket.localPort}`;
log('TCP connected to PBX', `${host}:${port}`, 'local', contactHost);

const callId = randomUUID();
const fromTag = tag();
const uri = `sip:${host}`;
const aor = `sip:${sipUser}@${host}`;
let cseq = 0;
let rings = 0;

let currentExpires = REGISTER_EXPIRES;

function sendRegister(expires: number, authorization?: string): void {
  currentExpires = expires;
  cseq += 1;
  const via = `SIP/2.0/TCP ${contactHost};branch=z9hG4bK${tag()};rport`;
  const msg = [
    `REGISTER ${uri} SIP/2.0`,
    `Via: ${via}`,
    'Max-Forwards: 70',
    `From: <${aor}>;tag=${fromTag}`,
    `To: <${aor}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} REGISTER`,
    `Contact: <sip:${sipUser}@${contactHost};transport=tcp>`,
    `Expires: ${expires}`,
    'User-Agent: homebridge-akuvox-smartplus-spike/0',
    ...(authorization ? [`Authorization: ${authorization}`] : []),
    'Content-Length: 0',
    '', '',
  ].join('\r\n');
  socket.write(msg);
}

function respondToInvite(invite: Msg, status: string): void {
  const lines = [
    `SIP/2.0 ${status}`,
    ...(invite.headers.get('via') ?? []).map((v) => `Via: ${v}`),
    `From: ${h1(invite, 'from')}`,
    `To: ${h1(invite, 'to')};tag=${tag()}`,
    `Call-ID: ${h1(invite, 'call-id')}`,
    `CSeq: ${h1(invite, 'cseq')}`,
    `Contact: <sip:${sipUser}@${contactHost};transport=tcp>`,
    'User-Agent: homebridge-akuvox-smartplus-spike/0',
    'Content-Length: 0',
    '', '',
  ].join('\r\n');
  socket.write(lines);
}

let registered = false;
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString('binary');
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) break;
    const headPart = buffer.slice(0, end);
    const clMatch = headPart.match(/content-length:\s*(\d+)/i);
    const contentLength = clMatch ? Number(clMatch[1]) : 0;
    const total = end + 4 + contentLength;
    if (buffer.length < total) break;
    const raw = buffer.slice(0, total);
    buffer = buffer.slice(total);
    handle(parse(raw));
  }
});

function handle(m: Msg): void {
  if (m.start.startsWith('SIP/2.0')) {
    const status = m.start.slice(8);
    const cseqHeader = h1(m, 'cseq');
    if (cseqHeader.includes('REGISTER')) {
      if (status.startsWith('401') || status.startsWith('407')) {
        const challenge = h1(m, 'www-authenticate') || h1(m, 'proxy-authenticate');
        sendRegister(currentExpires, digest(challenge, 'REGISTER', uri));
      } else if (status.startsWith('200')) {
        if (currentExpires === 0) {
          log('unregistered cleanly');
        } else if (!registered) {
          registered = true;
          log('REGISTERED as family-member SIP account — now waiting for a ring (expires', `${REGISTER_EXPIRES}s)`);
        }
      } else {
        log('REGISTER response:', mask(m.start));
      }
    }
    return;
  }

  const method = m.start.split(' ')[0];
  if (method === 'INVITE') {
    rings += 1;
    const from = h1(m, 'from');
    const callerSip = from.match(/sip:([^@;>]+)/)?.[1] ?? '';
    const where = doorSips.get(callerSip);
    respondToInvite(m, '180 Ringing');
    log('>>> RING received. caller is', where ? `the door unit "${where}"` : `SIP ${mask(callerSip)}`, '— replied 180 Ringing, NOT answering');
  } else if (method === 'CANCEL' || method === 'BYE') {
    respondToInvite(m, '200 OK');
    log(`<<< ${method} — another device handled the call (expected)`);
  } else if (method === 'OPTIONS') {
    respondToInvite(m, '200 OK');
  }
}

function unregister(reason: string): void {
  log(reason, '— unregistering', `(${rings} ring(s) seen)`);
  sendRegister(0);
  setTimeout(() => { socket.end(); process.exit(0); }, 1200);
}

log('masked SIP identity:', { user: mask(sipUser), server: `${host}:${port}`, doorUnits: [...doorSips.values()] });
sendRegister(REGISTER_EXPIRES);
setTimeout(() => unregister('listen window over'), LISTEN_SECONDS * 1000);
process.on('SIGINT', () => unregister('interrupted'));
