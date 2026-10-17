import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const GATE = 'https://gate.ecloud.akuvox.com:8600';
const USER_AGENT = 'VBell/7.51.3 (iPad; iOS 26.6; Scale/2.00)';

export const STATE_DIR = join(homedir(), '.akuvox');
const CREDENTIALS_FILE = join(STATE_DIR, 'credentials');
const SESSION_FILE = join(STATE_DIR, 'session.json');

export interface Credentials {
  user: string;
  password: string;
}

export interface Session {
  token: string;
  refreshToken: string;
  tokenValidSeconds: number;
  idCode?: string;
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

export function readSession(): Session | undefined {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Session;
  } catch {
    return undefined;
  }
}

export function writeSession(session: Session): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  chmodSync(SESSION_FILE, 0o600);
}

export const md5Hex = (input: string): string => createHash('md5').update(input, 'utf8').digest('hex');

export function caesarShift(input: string, key = 3): string {
  return input.replace(/[a-z]|[A-Z]|[0-9]/g, (chr) => {
    const code = chr.charCodeAt(0);
    if (chr >= 'a' && chr <= 'z') return String.fromCharCode(((code - 97 + key) % 26) + 97);
    if (chr >= 'A' && chr <= 'Z') return String.fromCharCode(((code - 65 + key) % 26) + 65);
    return String.fromCharCode(((code - 48 + key) % 10) + 48);
  });
}

/** The gate reads `user` without form-decoding, so `+` and `@` must reach it unescaped. */
export function loginUserParam(user: string): string {
  return encodeURIComponent(caesarShift(user)).replace(/%40/g, '@').replace(/%2B/g, '+');
}

export function isSuccess(envelope: Envelope): boolean {
  return envelope.result === 0 || envelope.err_code === '0' || envelope.code === 0;
}

export function payload(envelope: Envelope): Envelope {
  return (envelope.datas ?? envelope.data ?? envelope) as Envelope;
}

export async function request(url: string, apiVersion: string, init: RequestInit = {}): Promise<{ status: number; envelope: Envelope }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'api-version': apiVersion,
      'User-Agent': USER_AGENT,
      'x-auth-token': '',
      'Accept-Language': 'en',
      Accept: '*/*',
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  try {
    return { status: res.status, envelope: JSON.parse(body) as Envelope };
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON response (${body.length} bytes) from ${new URL(url).pathname}`);
  }
}

export async function form(url: string, apiVersion: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return request(url, apiVersion, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

export async function json(url: string, apiVersion: string, body: unknown, headers: Record<string, string> = {}) {
  return request(url, apiVersion, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
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
