import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { DoorLockAccessory } from './accessories/door-lock.js';
import { AkuvoxCloud } from './akuvox/cloud.js';
import { NotPairedError, SessionManager } from './akuvox/session-manager.js';
import { SessionStore } from './akuvox/session-store.js';
import type { AkuvoxDevice, AkuvoxRelay } from './akuvox/types.js';
import type { Region } from './settings.js';
import { PLATFORM_NAME, PLUGIN_NAME, REGIONS } from './settings.js';

export interface AkuvoxConfig extends PlatformConfig {
  region?: Region;
  email?: string;
  password?: string;
  unlockSeconds?: number;
}

export class AkuvoxSmartPlusPlatform implements DynamicPlatformPlugin {
  readonly hap: HAP;
  readonly unlockSeconds: number;
  session!: SessionManager;

  private readonly cached = new Map<string, PlatformAccessory>();

  constructor(
    readonly log: Logging,
    private readonly config: AkuvoxConfig,
    private readonly api: API,
  ) {
    this.hap = api.hap;
    this.unlockSeconds = Math.max(1, this.config.unlockSeconds ?? 5);
    this.api.on('didFinishLaunching', () => {
      void this.discover();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private async discover(): Promise<void> {
    const region = this.config.region ?? 'ecloud';
    if (!REGIONS.includes(region)) {
      this.log.error(`Unknown region "${region}". Expected one of: ${REGIONS.join(', ')}`);
      return;
    }
    if (!this.config.email || !this.config.password) {
      this.log.error('Missing "email" or "password" in the platform config; cannot sign in.');
      return;
    }

    const cloud = new AkuvoxCloud(region, this.config.email, this.config.password);
    this.session = new SessionManager(cloud, new SessionStore(this.api.user.storagePath()), this.log);
    if (!this.session.isPaired) {
      this.log.warn('Not paired yet. Run `akuvox-pair` once over SSH to complete the emailed-code sign-in, then restart Homebridge.');
      return;
    }

    let devices: AkuvoxDevice[];
    try {
      devices = await this.session.listDevices();
    } catch (error) {
      if (error instanceof NotPairedError) {
        this.log.warn(error.message);
      } else {
        this.log.error(`Akuvox discovery failed: ${(error as Error).message}`);
      }
      return;
    }

    const wanted = new Set<string>();
    for (const device of devices) {
      for (const relay of device.relays.filter((r) => r.enabled)) {
        wanted.add(this.registerLock(device, relay));
      }
    }
    this.pruneExcept(wanted);
  }

  private registerLock(device: AkuvoxDevice, relay: AkuvoxRelay): string {
    const uuid = this.hap.uuid.generate(`akuvox:${device.mac}:${relay.relayId}`);
    const hasMultipleRelays = device.relays.filter((r) => r.enabled).length > 1;
    const name = hasMultipleRelays ? `${device.location} ${relay.doorName}` : device.location;

    let accessory = this.cached.get(uuid);
    if (accessory) {
      accessory.displayName = name;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
      this.log.info(`Added lock "${name}"`);
    }
    new DoorLockAccessory(this, accessory, device, relay);
    return uuid;
  }

  private pruneExcept(keep: Set<string>): void {
    for (const [uuid, accessory] of this.cached) {
      if (keep.has(uuid)) continue;
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.delete(uuid);
      this.log.info(`Removed stale accessory "${accessory.displayName}"`);
    }
  }
}
