import { randomBytes } from 'node:crypto';
import { form, isSuccess, payload, readSession, request, type Envelope } from './akuvox-cloud.ts';

const session = readSession();
if (!session) throw new Error('no session, run login.ts first');

const conf = payload((await request(`https://${session.restServer}/userconf?token=${session.token}`, '7.13', { headers: { 'x-auth-token': session.token } })).envelope);
const door = ((conf.dev_list as Envelope[]) ?? []).find((d) => d.dev_type === '1');
if (!door) throw new Error('no door unit found');

const relay = ((door.relay as Envelope[]) ?? [])[0];
const traceId = randomBytes(11).toString('hex');
console.log('opening', door.location, 'relay', relay.door_name);

const res = await form(`https://${session.restServer}/opendoor?token=${session.token}`, '7.1', {
  mac: door.mac as string,
  relay: relay.relay_id as string,
  trace_id: traceId,
}, { 'x-auth-token': session.token });

console.log(isSuccess(res.envelope) ? 'PASS  opendoor accepted' : 'FAIL  opendoor rejected', { result: res.envelope.result ?? res.envelope.err_code, message: res.envelope.message, datas: payload(res.envelope) });
