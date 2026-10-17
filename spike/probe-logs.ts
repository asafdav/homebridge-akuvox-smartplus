import { payload, readSession, request, type Envelope } from './akuvox-cloud.ts';

const session = readSession();
if (!session) throw new Error('no session, run login.ts first');

const WEB = 'https://backend.ecloud.akuvox.com/web-server/v4/smartplus/community/log/member';
const headers = {
  'x-auth-token': session.token,
  'x-cloud-version': '6.4',
  'x-cloud-lang': 'en',
  Origin: 'https://ecloud.akuvox.com',
  Referer: 'https://ecloud.akuvox.com/',
};

for (const log of ['getDoorLog', 'getCallLog']) {
  const r = await request(`${WEB}/${log}?row=3&page=1&_t=${Date.now()}`, '6.4', { headers });
  const rows = ((payload(r.envelope).list as Envelope[] | undefined) ?? []);
  console.log(`${r.envelope.code === 0 ? 'PASS' : 'FAIL'}  ${log}`, { http: r.status, code: r.envelope.code, msg: r.envelope.msg, rows: rows.length });
  for (const row of rows) {
    console.log('   ', log === 'getDoorLog'
      ? { at: row.captureTime, type: row.captureType, response: row.response, hasPic: !!row.picUrl }
      : { at: row.startTime, ring: row.isCallee && row.isGroupCall, answered: row.isAnswer });
  }
}
