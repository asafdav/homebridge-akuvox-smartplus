import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { AkuvoxCloud } from './akuvox/cloud.js';
import { NotPairedError, SessionManager } from './akuvox/session-manager.js';
import { SessionStore } from './akuvox/session-store.js';
import type { Region } from './settings.js';
import { REGIONS } from './settings.js';

export interface AkuvoxConfig extends PlatformConfig {
  region?: Region;
  email?: string;
  password?: string;
}

export class AkuvoxSmartPlusPlatform implements DynamicPlatformPlugin {
  private readonly accessories = new Map<string, PlatformAccessory>();

  constructor(
    private readonly log: Logging,
    private readonly config: AkuvoxConfig,
    private readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => {
      void this.discover();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
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
    const manager = new SessionManager(cloud, new SessionStore(this.api.user.storagePath()), this.log);
    if (!manager.isPaired) {
      this.log.warn('Not paired yet. Run `akuvox-pair` once over SSH to complete the emailed-code sign-in, then restart Homebridge.');
      return;
    }

    try {
      const devices = await manager.listDevices();
      const doors = devices.filter((d) => d.relays.length > 0);
      this.log.info(`Akuvox session active. ${doors.length} door unit(s): ${doors.map((d) => d.location).join(', ')}. Accessories are wired in the next build.`);
    } catch (error) {
      if (error instanceof NotPairedError) {
        this.log.warn(`${error.message}`);
        return;
      }
      this.log.error(`Akuvox discovery failed: ${(error as Error).message}`);
    }
  }
}
