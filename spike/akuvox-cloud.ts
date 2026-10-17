import { createDecipheriv, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const GATE = 'https://gate.ecloud.akuvox.com:8600';
const USER_AGENT = 'VBell/6.61.2 (iPhone; iOS 16.6; Scale/3.00)';
const RESPONSE_KEY_SUFFIX = 'Akuvox55069013!@';
const RESPONSE_IV = '1234567887654321';

export const STATE_DIR = join(homedir(), '.akuvox');
const CREDENTIALS_FILE = join(STATE_DIR, 'credentials');
const SESSION_FILE = join(STATE_DIR, 'session.json');

export interface Credentials {
  user: string;
  password: string;
}

export interface Session {
  token: string;
  restServer: string;
  rtmpServer?: string;
  obtainedAt: string;
}

export type Envelope = Record<string, unknown>;

export function readCredentials(): Credentials {
  const [user, password] = readFileSync(CREDENTIALS_FILE, 'utf8').split('\n');
  if (!user || !password) throw new Error(`${CREDENTIALS_FILE} must hold the username and password on two lines`);
  return { user, password };
}

export function readSession(): Session {
  return JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Session;
}

export function writeSession(session: Session): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  chmodSync(SESSION_FILE, 0o600);
}

const md5 = (input: string): Buffer => createHash('md5').update(input, 'utf8').digest();
export const md5Hex = (input: string): string => md5(input).toString('hex');

export function caesarShift(input: string, key = 3): string {
  return input.replace(/[a-z]|[A-Z]|[0-9]/g, (chr) => {
    const code = chr.charCodeAt(0);
    if (chr >= 'a' && chr <= 'z') return String.fromCharCode(((code - 97 + key) % 26) + 97);
    if (chr >= 'A' && chr <= 'Z') return String.fromCharCode(((code - 65 + key) % 26) + 65);
    return String.fromCharCode(((code - 48 + key) % 10) + 48);
  });
}

export function decryptLoginResponse(user: string, body: string): string {
  const key = Buffer.concat([md5(user), Buffer.from(RESPONSE_KEY_SUFFIX, 'utf8')]);
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(RESPONSE_IV, 'utf8'));
  return Buffer.concat([decipher.update(Buffer.from(body.trim(), 'base64')), decipher.final()]).toString('utf8');
}

export function isSuccess(envelope: Envelope): boolean {
  return envelope.result === 0 || envelope.err_code === '0' || envelope.code === 0;
}

export function payload(envelope: Envelope): Envelope {
  return (envelope.datas ?? envelope.data ?? envelope) as Envelope;
}

export async function request(url: string, apiVersion: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'api-version': apiVersion,
      'User-Agent': USER_AGENT,
      'x-cloud-lang': 'en',
      Accept: '*/*',
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.text() };
}

export function parseJson(body: string): Envelope | undefined {
  try {
    return JSON.parse(body) as Envelope;
  } catch {
    return undefined;
  }
}

/** Shape of a value with every string replaced by its length, so secrets never reach a log. */
export function shape(value: unknown): unknown {
  if (typeof value === 'string') return `<string:${value.length}>`;
  if (Array.isArray(value)) return value.length ? [shape(value[0]), `…${value.length} items`] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  }
  return value;
}

export function hostOf(server: unknown): string | undefined {
  return typeof server === 'string' && server ? server.split(':')[0] : undefined;
}
