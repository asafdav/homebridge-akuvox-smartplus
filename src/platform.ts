import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { CameraDoorbellAccessory } from './accessories/camera-doorbell.js';
import { ContactAccessory } from './accessories/contact.js';
import { LockAccessory } from './accessories/lock.js';
import { AkuvoxCloud } from './akuvox/cloud.js';
import { DoorLogPoller } from './akuvox/door-log-poller.js';
import { NotPairedError, SessionManager } from './akuvox/session-manager.js';
import { SessionStore } from './akuvox/session-store.js';
import { SipListener, type RingEvent } from './akuvox/sip.js';
import type { AkuvoxDevice } from './akuvox/types.js';
import type { Region } from './settings.js';
import { PLATFORM_NAME, PLUGIN_NAME, REGIONS } from './settings.js';

export interface AkuvoxConfig extends PlatformConfig {
  region?: Region;
  email?: string;
  password?: string;
  unlockSeconds?: number;
  doorbell?: boolean;
}

export class AkuvoxSmartPlusPlatform implements DynamicPlatformPlugin {
  readonly hap: HAP;
  readonly unlockSeconds: number;
  session!: SessionManager;

  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly doorbells = new Map<string, CameraDoorbellAccessory>();
  private readonly contacts = new Map<string, ContactAccessory>();
  private readonly sipToMac = new Map<string, string>();
  private sip?: SipListener;
  private poller?: DoorLogPoller;

  constructor(
    readonly log: Logging,
    private readonly config: AkuvoxConfig,
    readonly api: API,
  ) {
    this.hap = api.hap;
    this.unlockSeconds = Math.max(1, this.config.unlockSeconds ?? 5);
    this.api.on('didFinishLaunching', () => void this.discover());
    this.api.on('shutdown', () => {
      this.sip?.stop();
      this.poller?.stop();
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
    const cloud = new AkuvoxCloud(region, this.config.email ?? '', this.config.password ?? '');
    this.session = new SessionManager(cloud, new SessionStore(this.api.user.storagePath()), this.log);
    if (!this.session.isPaired) {
      this.log.warn('Not paired yet. Run `akuvox-pair` once over SSH, then restart Homebridge.');
      return;
    }

    let devices: AkuvoxDevice[];
    try {
      devices = await this.session.listDevices();
    } catch (error) {
      this.log.error(`Akuvox discovery failed: ${error instanceof NotPairedError ? error.message : (error as Error).message}`);
      return;
    }

    const doorStations = devices.filter((d) => d.relays.some((r) => r.enabled));
    const wanted = new Set<string>();
    for (const device of doorStations) {
      const relays = device.relays.filter((r) => r.enabled);

      wanted.add(this.ensureAccessory(`akuvox:${device.mac}`, device.location, this.hap.Categories.VIDEO_DOORBELL, (a) => {
        this.doorbells.set(device.mac, new CameraDoorbellAccessory(this, a, device));
      }));

      for (const relay of relays) {
        const lockName = relays.length > 1 ? `${device.location} ${relay.doorName}` : `${device.location} Lock`;
        wanted.add(this.ensureAccessory(`akuvox:${device.mac}:${relay.relayId}:lock`, lockName, this.hap.Categories.DOOR_LOCK, (a) => {
          new LockAccessory(this, a, device, relay, lockName);
        }));
      }

      const contactName = `${device.location} Opened`;
      wanted.add(this.ensureAccessory(`akuvox:${device.mac}:contact`, contactName, this.hap.Categories.SENSOR, (a) => {
        this.contacts.set(device.mac, new ContactAccessory(this, a, device, contactName));
      }));

      if (device.sip) this.sipToMac.set(device.sip, device.mac);
    }
    this.pruneExcept(wanted);

    if (this.config.doorbell !== false) this.startDoorbell();
    this.startDoorLog();
  }

  private ensureAccessory(key: string, name: string, category: number, build: (a: PlatformAccessory) => void): string {
    const uuid = this.hap.uuid.generate(key);
    const existing = this.cached.get(uuid);
    if (existing) {
      existing.displayName = name;
      build(existing);
      this.api.updatePlatformAccessories([existing]);
      return uuid;
    }
    const accessory = new this.api.platformAccessory(name, uuid);
    accessory.category = category;
    build(accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.cached.set(uuid, accessory);
    this.log.info(`Added "${name}"`);
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

  private startDoorbell(): void {
    const creds = this.session.getSipCredentials();
    if (!creds) {
      this.log.warn('No SIP credentials in the session; re-run `akuvox-pair` to enable doorbell rings.');
      return;
    }
    this.sip = new SipListener(creds, this.log);
    this.sip.on('ring', (event: RingEvent) => {
      const mac = this.sipToMac.get(event.callerSip);
      const doorbell = (mac && this.doorbells.get(mac)) || this.only(this.doorbells);
      doorbell?.ring();
    });
    this.sip.start();
  }

  private startDoorLog(): void {
    this.poller = new DoorLogPoller(this.session, this.log);
    this.poller.on('opened', () => {
      // One door station in practice; route to it. Multi-station routing needs the entry's MAC.
      this.only(this.contacts)?.opened();
    });
    this.poller.start();
  }

  private only<T>(map: Map<string, T>): T | undefined {
    return map.size === 1 ? [...map.values()][0] : undefined;
  }
}
