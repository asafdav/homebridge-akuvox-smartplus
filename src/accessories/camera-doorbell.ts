import type { PlatformAccessory, Service } from 'homebridge';
import type { AkuvoxDevice } from '../akuvox/types.js';
import { buildRtspUrl } from '../camera/rtsp.js';
import { AkuvoxStreamingDelegate } from '../camera/streaming-delegate.js';
import type { AkuvoxSmartPlusPlatform } from '../platform.js';

/** Camera + doorbell for a door station, published as a video doorbell. */
export class CameraDoorbellAccessory {
  private readonly doorbell: Service;
  delegate?: AkuvoxStreamingDelegate;

  constructor(
    private readonly platform: AkuvoxSmartPlusPlatform,
    private readonly accessory: PlatformAccessory,
    device: AkuvoxDevice,
  ) {
    const { Service, Characteristic } = this.platform.hap;

    accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Akuvox')
      .setCharacteristic(Characteristic.Model, 'SmartPlus Intercom')
      .setCharacteristic(Characteristic.SerialNumber, device.mac);

    // Shed lock/contact services left on this accessory by the earlier combined design.
    for (const stale of [...accessory.services]) {
      if (stale.UUID === Service.LockMechanism.UUID || stale.UUID === Service.ContactSensor.UUID) {
        accessory.removeService(stale);
      }
    }

    this.doorbell = accessory.getService(Service.Doorbell) ?? accessory.addService(Service.Doorbell, device.location);
    accessory.category = this.platform.hap.Categories.VIDEO_DOORBELL;

    if (device.rtspPassword && device.cameraCount > 0) {
      this.delegate = new AkuvoxStreamingDelegate(this.platform.api, this.platform.log, () => {
        const info = this.platform.session.getRtspInfo();
        return buildRtspUrl({ vrtspServer: info.vrtspServer, relayHost: info.relayHost, mac: device.mac, password: device.rtspPassword! });
      });
      accessory.configureController(this.delegate.attachController());
    }
  }

  ring(): void {
    const { Characteristic } = this.platform.hap;
    this.doorbell.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    this.platform.log.info(`Doorbell ring at ${this.accessory.displayName}`);
  }
}
