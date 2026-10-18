#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AkuvoxCloud } from './akuvox/cloud.js';
import { SessionManager } from './akuvox/session-manager.js';
import { SessionStore } from './akuvox/session-store.js';
import type { Region } from './settings.js';
import { PLATFORM_NAME } from './settings.js';

interface PlatformBlock {
  platform?: string;
  region?: Region;
  email?: string;
  password?: string;
}

function storagePath(): string {
  const flag = process.argv.indexOf('-U');
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1]!;
  return process.env.HOMEBRIDGE_STORAGE_PATH ?? '/var/lib/homebridge';
}

function readPlatformBlock(dir: string): PlatformBlock {
  try {
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { platforms?: PlatformBlock[] };
    return (config.platforms ?? []).find((p) => p.platform === PLATFORM_NAME) ?? {};
  } catch {
    return {};
  }
}

/** Credentials never need to live in config.json; a one-time pairing reads them here. */
function readCredentialsFile(): { email?: string; password?: string } {
  try {
    const [email, password] = readFileSync(join(homedir(), '.akuvox', 'credentials'), 'utf8').split('\n');
    return { email: email?.trim() || undefined, password: password || undefined };
  } catch {
    return {};
  }
}

const log = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m), error: (m: string) => console.error(m) };

const dir = storagePath();
const block = readPlatformBlock(dir);
const file = readCredentialsFile();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const region: Region = block.region ?? 'ecloud';
const email = block.email ?? file.email ?? (await rl.question('SmartPlus account email: ')).trim();
const password = block.password ?? file.password ?? (await rl.question('SmartPlus account password: '));
const cloud = new AkuvoxCloud(region, email, password);
const manager = new SessionManager(cloud, new SessionStore(dir), log);

console.log(`Signing in to Akuvox (${region}) as ${email} …`);
const challenge = await cloud.login();

let result = challenge.result;
if (!result) {
  if (!challenge.needsTwoFactor || !challenge.tempToken) throw new Error('Login returned no token and no two-factor challenge.');
  await cloud.sendTwoFactorCode(challenge.restServer, challenge.tempToken);
  const code = (await rl.question('Enter the verification code emailed to the account: ')).trim();
  result = await cloud.verifyTwoFactorCode(code);
}
rl.close();

const sip = await cloud.getSipConfig(result.restServer, result.token);
const sipServer = await cloud.getSipServer(result.token);
manager.adopt(result, sip, sipServer);

const devices = await manager.listDevices();
console.log('\nPaired. Session saved to the Homebridge storage directory.');
console.log('Devices visible to this account:');
for (const d of devices) {
  console.log(`  - ${d.location} (${d.devType === '1' ? 'door station' : 'indoor monitor'}), relays: ${d.relays.map((r) => r.doorName).join(', ') || 'none'}`);
}
console.log('\nRestart Homebridge to let the plugin pick up the session.');
