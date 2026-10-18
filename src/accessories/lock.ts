import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { AkuvoxDevice, AkuvoxRelay } from '../akuvox/types.js';
import type { AkuvoxSmartPlusPlatform } from '../platform.js';
import { makeLockTargetHandler } from './lock-controller.js';

/** A standalone HomeKit lock for one door relay. */
export class LockAccessory {
  constructor(
    private readonly platform: AkuvoxSmartPlusPlatform,
    accessory: PlatformAccessory,
    device: AkuvoxDevice,
    relay: AkuvoxRelay,
    name: string,
  ) {
    const { Service, Characteristic } = this.platform.hap;
    const current = Characteristic.LockCurrentState;
    const target = Characteristic.LockTargetState;

    accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Akuvox')
      .setCharacteristic(Characteristic.Model, 'SmartPlus Intercom')
      .setCharacteristic(Characteristic.SerialNumber, `${device.mac}:${relay.relayId}`);

    const service: Service = accessory.getService(Service.LockMechanism) ?? accessory.addService(Service.LockMechanism, name);
    service.updateCharacteristic(current.LockCurrentState, current.SECURED);
    service.updateCharacteristic(target.LockTargetState, target.SECURED);

    const handler = makeLockTargetHandler({
      unlock: () => this.platform.session.openDoor(device.mac, relay.relayId),
      setCurrent: (v) => service.updateCharacteristic(current.LockCurrentState, v),
      setTarget: (v) => service.updateCharacteristic(target.LockTargetState, v),
      states: { secured: current.SECURED, unsecured: current.UNSECURED },
      relockMs: this.platform.unlockSeconds * 1000,
      log: this.platform.log,
    });
    service.getCharacteristic(target.LockTargetState).onSet((value: CharacteristicValue) => handler(Number(value)));
  }
}
