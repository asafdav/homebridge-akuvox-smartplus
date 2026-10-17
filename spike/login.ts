import {
  caesarShift,
  decryptLoginResponse,
  GATE,
  hostOf,
  isSuccess,
  md5Hex,
  parseJson,
  payload,
  readCredentials,
  request,
  shape,
  writeSession,
  type Envelope,
} from './akuvox-cloud.ts';

function step(name: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  if (!ok) process.exit(1);
}

const creds = readCredentials();

const restProbe = await request(`${GATE}/rest_server`, '6.0');
const restEnvelope = parseJson(restProbe.body);
step('gate reachable', restProbe.status === 200 && !!restEnvelope && isSuccess(restEnvelope), `HTTP ${restProbe.status}`);

const user = encodeURIComponent(caesarShift(creds.user)).replace(/%40/g, '@');
const login = await request(`${GATE}/login?user=${user}&passwd=${md5Hex(md5Hex(creds.password))}`, '6.4');
const loginEnvelope: Envelope | undefined =
  parseJson(login.body) ?? parseJson(decryptLoginResponse(creds.user, login.body));
step('login response decoded', !!loginEnvelope, `HTTP ${login.status}`);
const loginData = payload(loginEnvelope!);
step('login accepted', isSuccess(loginEnvelope!), {
  result: loginEnvelope!.result ?? loginEnvelope!.err_code,
  message: loginEnvelope!.message,
  fields: shape(loginData),
});

const token = loginData.token as string;
const restServer = loginData.rest_server_https as string;
step('token and rest server present', !!token && !!restServer, `rest host ${restServer}, rtsp relay ${hostOf(loginData.rtmp_server)}`);
writeSession({ token, restServer, rtmpServer: loginData.rtmp_server as string, obtainedAt: new Date().toISOString() });

const userconf = await request(`https://${restServer}/userconf?token=${token}`, '6.5', { headers: { 'X-AUTH-TOKEN': token } });
const confEnvelope = parseJson(userconf.body);
step('userconf accepted', userconf.status === 200 && !!confEnvelope && isSuccess(confEnvelope), `HTTP ${userconf.status}`);

const conf = payload(confEnvelope!);
const appConf = conf.app_conf as Envelope | undefined;
const devices = (conf.dev_list as Envelope[] | undefined) ?? [];
console.log('account', { project: appConf?.project_name, role: appConf?.role });
for (const dev of devices) {
  console.log('device', {
    location: dev.location,
    mac: dev.mac,
    type: dev.dev_type ?? dev.type,
    hasRtspPassword: !!dev.rtsp_pwd,
    relays: ((dev.relay as Envelope[] | undefined) ?? []).map((r) => ({ id: r.relay_id, door: r.door_name })),
  });
}
step('door unit listed', devices.some((d) => Array.isArray(d.relay) && d.relay.length > 0), `${devices.length} devices`);
