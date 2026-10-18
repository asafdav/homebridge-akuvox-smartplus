import type { PlatformAccessory, Service } from 'homebridge';
import type { AkuvoxDevice } from '../akuvox/types.js';
import type { AkuvoxSmartPlusPlatform } from '../platform.js';

const CONTACT_OPEN_MS = 5000;

/** A standalone contact sensor that pulses open when the door is opened. */
export class ContactAccessory {
  private readonly contact: Service;

  constructor(
    private readonly platform: AkuvoxSmartPlusPlatform,
    accessory: PlatformAccessory,
    device: AkuvoxDevice,
    name: string,
  ) {
    const { Service, Characteristic } = this.platform.hap;

    accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Akuvox')
      .setCharacteristic(Characteristic.Model, 'SmartPlus Intercom')
      .setCharacteristic(Characteristic.SerialNumber, `${device.mac}:contact`);

    this.contact = accessory.getService(Service.ContactSensor) ?? accessory.addService(Service.ContactSensor, name);
    this.contact.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_DETECTED);
  }

  opened(): void {
    const state = this.platform.hap.Characteristic.ContactSensorState;
    this.contact.updateCharacteristic(state.ContactSensorState, state.CONTACT_NOT_DETECTED);
    setTimeout(() => this.contact.updateCharacteristic(state.ContactSensorState, state.CONTACT_DETECTED), CONTACT_OPEN_MS);
  }
}
