import { spawnSync } from 'node:child_process';
import { payload, readSession, request, type Envelope } from './akuvox-cloud.ts';

const DOOR_LAN_IP = process.argv[2];

const session = readSession();
if (!session) throw new Error('no session, run login.ts first');

const conf = payload((await request(`https://${session.restServer}/userconf?token=${session.token}`, '7.13', { headers: { 'x-auth-token': session.token } })).envelope);
const door = ((conf.dev_list as Envelope[]) ?? []).find((d) => d.dev_type === '1');
if (!door) throw new Error('no door unit in userconf');

const mac = door.mac as string;
const pwd = encodeURIComponent(door.rtsp_pwd as string);
const login = payload((await request(`https://gate.ecloud.akuvox.com:8600/servers_list`, '6.8', { headers: { 'x-auth-token': session.token } })).envelope);
const relayHost = (session.rtmpServer ?? '').split(':')[0];
const vrtsp = (login.vrtsp_server as string | undefined) ?? '';
const vrtsps = (login.vrtsps_server as string | undefined) ?? '';

const candidates: Array<[string, string, string]> = [
  ['cloud rtmp-host :554 /MAC', `rtsp://ak:${pwd}@${relayHost}:554/${mac}`, 'udp'],
  ['cloud rtmp-host :554 /MAC', `rtsp://ak:${pwd}@${relayHost}:554/${mac}`, 'tcp'],
  ['cloud vrtsp_server /MAC', `rtsp://ak:${pwd}@${vrtsp}/${mac}`, 'udp'],
  ['cloud vrtsp_server /MAC', `rtsp://ak:${pwd}@${vrtsp}/${mac}`, 'tcp'],
  ['cloud vrtsps_server /MAC', `rtsps://ak:${pwd}@${vrtsps}/${mac}`, 'tcp'],
];
if (DOOR_LAN_IP) {
  candidates.push(['local /live/ch00_0 as ak', `rtsp://ak:${pwd}@${DOOR_LAN_IP}/live/ch00_0`, 'tcp']);
}

const mask = (s: string) => s.split(pwd).join('<pwd>').split(mac).join('<MAC>');
console.log('relay hosts:', { rtmp: relayHost, vrtsp: vrtsp || 'absent', vrtsps: vrtsps || 'absent' });

for (const [name, url, transport] of candidates) {
  if (url.includes('@/') || url.includes('@:')) {
    console.log(`SKIP  ${name} (${transport}): host missing`);
    continue;
  }
  const out = `/tmp/akuvox-frame-${transport}.jpg`;
  const started = Date.now();
  const r = spawnSync('timeout', ['25', 'ffmpeg', '-hide_banner', '-loglevel', 'info', '-rtsp_transport', transport, '-i', url, '-frames:v', '1', '-y', out], { encoding: 'utf8' });
  const stderr = mask(r.stderr ?? '');
  const stream = stderr.match(/Stream #0:\d.*Video:[^\n]*/)?.[0];
  const ok = r.status === 0 && !!stream;
  const error = stderr.split('\n').filter((l) => /error|unauthor|40\d|refused|timed out|not found|invalid/i.test(l)).slice(-2).join(' | ');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (${transport}) ${((Date.now() - started) / 1000).toFixed(1)}s`, ok ? `${stream} -> ${out}` : error || `exit ${r.status}`);
}
