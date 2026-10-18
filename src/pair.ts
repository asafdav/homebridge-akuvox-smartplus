#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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

function loadPlatformConfig(dir: string): Required<Omit<PlatformBlock, 'platform'>> {
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { platforms?: PlatformBlock[] };
  const block = (config.platforms ?? []).find((p) => p.platform === PLATFORM_NAME);
  if (!block) throw new Error(`No "${PLATFORM_NAME}" platform found in ${join(dir, 'config.json')}`);
  if (!block.email || !block.password) throw new Error('The platform config needs both "email" and "password".');
  return { region: block.region ?? 'ecloud', email: block.email, password: block.password };
}

const log = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m), error: (m: string) => console.error(m) };

const dir = storagePath();
const { region, email, password } = loadPlatformConfig(dir);
const cloud = new AkuvoxCloud(region, email, password);
const manager = new SessionManager(cloud, new SessionStore(dir), log);

console.log(`Signing in to Akuvox (${region}) as ${email} …`);
const challenge = await cloud.login();

let result = challenge.result;
if (!result) {
  if (!challenge.needsTwoFactor || !challenge.tempToken) throw new Error('Login returned no token and no two-factor challenge.');
  await cloud.sendTwoFactorCode(challenge.restServer, challenge.tempToken);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question('Enter the verification code emailed to the account: ')).trim();
  rl.close();
  result = await cloud.verifyTwoFactorCode(code);
}

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
