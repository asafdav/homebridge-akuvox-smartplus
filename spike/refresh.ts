import {
  GATE,
  isSuccess,
  http2Json,
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
  type Session,
} from './akuvox-cloud.ts';

const codes = (e: Envelope) => ({ result: e.result ?? e.err_code, message: e.message });

async function tokenWorks(token: string, restServer: string): Promise<boolean> {
  const r = await request(`https://${restServer}/userconf?token=${token}`, '7.13', { headers: { 'x-auth-token': token } });
  return isSuccess(r.envelope);
}

const session = readSession();
if (!session) throw new Error('no session, run login.ts first');
console.log('current token works:', await tokenWorks(session.token, session.restServer));

function save(next: Envelope, from: Session): Session {
  const saved: Session = {
    ...from,
    token: next.token as string,
    refreshToken: (next.refresh_token as string | undefined) ?? from.refreshToken,
    tokenValidSeconds: Number(next.token_valid ?? from.tokenValidSeconds),
    idCode: (next.two_factor_auth_idcode as string | undefined) ?? from.idCode,
    obtainedAt: new Date().toISOString(),
  };
  writeSession(saved);
  return saved;
}

for (const apiVersion of process.env.SKIP_REFRESH ? [] : ['6.8', '7.0', '6.6', '6.4', '6.0', '7.1', '7.13']) {
  let r: Awaited<ReturnType<typeof http2Json>>;
  try {
    r = await http2Json(`${GATE}/refresh_token`, apiVersion, { refresh_token: session.refreshToken }, { 'x-auth-token': session.token });
  } catch (error) {
    console.log(`refresh_token api ${apiVersion}:`, (error as Error).message.replace(/^.*?: /, ''));
    continue;
  }
  const data = payload(r.envelope);
  console.log(`refresh_token api ${apiVersion}:`, { http: r.status, ...codes(r.envelope), fields: shape(data) });
  if (isSuccess(r.envelope) && data.token) {
    const next = save(data, session);
    const changed = next.token !== session.token;
    console.log('PASS  refresh', { apiVersion, tokenChanged: changed, newTokenWorks: await tokenWorks(next.token, next.restServer), oldTokenStillWorks: changed ? await tokenWorks(session.token, session.restServer) : 'same token' });
    process.exit(0);
  }
}

const { user, password } = readCredentials();
const login = await request(`${GATE}/login?user=${loginUserParam(user)}&passwd=${md5Hex(md5Hex(password))}&id_code=${encodeURIComponent(session.idCode ?? '')}`, '7.33');
const data = payload(login.envelope);
console.log('re-login with id_code:', { ...codes(login.envelope), needs2fa: data.is_need_two_factor_auth, fields: shape(data) });
if (isSuccess(login.envelope) && data.token) {
  const next = save(data, session);
  console.log('PASS  re-login without email code', { newTokenWorks: await tokenWorks(next.token, next.restServer) });
} else {
  console.log('FAIL  no silent renewal path; a new email code would be needed');
}
