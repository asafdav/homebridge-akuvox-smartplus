import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { AkuvoxDevice, AkuvoxRelay } from '../akuvox/types.js';
import type { AkuvoxSmartPlusPlatform } from '../platform.js';
import { makeLockTargetHandler } from './lock-controller.js';

export class DoorLockAccessory {
  constructor(
    private readonly platform: AkuvoxSmartPlusPlatform,
    accessory: PlatformAccessory,
    device: AkuvoxDevice,
    relay: AkuvoxRelay,
  ) {
    const { Service, Characteristic } = this.platform.hap;
    const lockCurrent = Characteristic.LockCurrentState;
    const lockTarget = Characteristic.LockTargetState;

    accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Akuvox')
      .setCharacteristic(Characteristic.Model, 'SmartPlus Intercom')
      .setCharacteristic(Characteristic.SerialNumber, `${device.mac}:${relay.relayId}`);

    const service: Service =
      accessory.getService(Service.LockMechanism) ?? accessory.addService(Service.LockMechanism, accessory.displayName);

    service.setCharacteristic(lockCurrent.LockCurrentState, lockCurrent.SECURED);
    service.setCharacteristic(lockTarget.LockTargetState, lockTarget.SECURED);

    const setCurrent = (v: number) => service.updateCharacteristic(lockCurrent.LockCurrentState, v);
    const setTarget = (v: number) => service.updateCharacteristic(lockTarget.LockTargetState, v);

    const handler = makeLockTargetHandler({
      unlock: () => this.platform.session.openDoor(device.mac, relay.relayId),
      setCurrent,
      setTarget,
      states: { secured: lockCurrent.SECURED, unsecured: lockCurrent.UNSECURED },
      relockMs: this.platform.unlockSeconds * 1000,
      log: this.platform.log,
    });

    service.getCharacteristic(lockTarget.LockTargetState).onSet((value: CharacteristicValue) => handler(Number(value)));
  }
}
