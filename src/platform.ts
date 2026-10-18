import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { AkuvoxCloud } from './akuvox/cloud.js';
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
    try {
      const challenge = await cloud.login();
      if (challenge.needsTwoFactor) {
        this.log.warn('This account requires a verification code on first sign-in. Run the pairing step (coming in the next build) to complete setup.');
        return;
      }
      this.log.info('Signed in to Akuvox SmartPlus; device discovery is wired in the next build.');
    } catch (error) {
      this.log.error(`Akuvox sign-in failed: ${(error as Error).message}`);
    }
  }
}
