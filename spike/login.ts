import { createInterface } from 'node:readline/promises';
import {
  form,
  GATE,
  hostOf,
  isSuccess,
  json,
  loginUserParam,
  md5Hex,
  payload,
  readCredentials,
  readSession,
  request,
  shape,
  writeSession,
  type Envelope,
} from './akuvox-cloud.ts';

function step(name: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
  if (!ok) process.exit(1);
}

const codes = (e: Envelope) => ({ result: e.result ?? e.err_code, message: e.message });

const creds = readCredentials();
const previous = readSession();

const idCodeQuery = previous?.idCode ? `&id_code=${encodeURIComponent(previous.idCode)}` : '';
const login = await request(`${GATE}/login?user=${loginUserParam(creds.user)}&passwd=${md5Hex(md5Hex(creds.password))}${idCodeQuery}`, '7.33');
step('login accepted', isSuccess(login.envelope), { ...codes(login.envelope), fields: shape(payload(login.envelope)) });

let session = payload(login.envelope);
const restServer = session.rest_server_https as string;

if (String(session.is_need_two_factor_auth) === '1') {
  const sent = await form(`https://${restServer}/apprest/v2/send_two_factor_authentication_code`, '7.1', {
    account_type: 'enduser',
    login_account: creds.user,
    two_factor_auth_temp_token: session.two_factor_auth_temp_token as string,
  });
  step('verification code sent to email', isSuccess(sent.envelope), codes(sent.envelope));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question('Enter the verification code from the email: ')).trim();
  rl.close();

  const verified = await json(`${GATE}/enduser/enduser_verify_code`, '7.33', { verify_code: code, user: creds.user });
  step('verification code accepted', isSuccess(verified.envelope), codes(verified.envelope));
  session = payload(verified.envelope);
}

const token = session.token as string;
step('token issued', !!token, { fields: shape(session), validSeconds: session.token_valid, rtspRelay: hostOf(session.rtmp_server) });
writeSession({
  token,
  refreshToken: session.refresh_token as string,
  tokenValidSeconds: Number(session.token_valid),
  idCode: (session.two_factor_auth_idcode as string | undefined) ?? previous?.idCode,
  restServer: (session.rest_server_https as string) ?? restServer,
  rtmpServer: session.rtmp_server as string,
  obtainedAt: new Date().toISOString(),
});

const userconf = await request(`https://${restServer}/userconf?token=${token}`, '7.13', { headers: { 'x-auth-token': token } });
step('userconf accepted', isSuccess(userconf.envelope), codes(userconf.envelope));

const conf = payload(userconf.envelope);
const appConf = conf.app_conf as Envelope | undefined;
const devices = (conf.dev_list as Envelope[] | undefined) ?? [];
console.log('account', { project: appConf?.project_name, role: appConf?.role });
for (const dev of devices) {
  console.log('device', {
    location: dev.location,
    mac: dev.mac,
    devType: dev.dev_type,
    cameras: dev.camera_num,
    hasRtspPassword: !!dev.rtsp_pwd,
    relays: ((dev.relay as Envelope[] | undefined) ?? []).map((r) => ({ id: r.relay_id, door: r.door_name, type: r.type, enabled: r.enable })),
  });
}
step('door unit listed', devices.some((d) => Array.isArray(d.relay) && d.relay.length > 0), `${devices.length} devices`);
