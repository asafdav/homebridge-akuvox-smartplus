import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { AkuvoxDevice } from '../akuvox/types.js';
import type { AkuvoxSmartPlusPlatform } from '../platform.js';
import { makeLockTargetHandler } from './lock-controller.js';

const CONTACT_OPEN_MS = 5000;

/** One HomeKit accessory for a door station: a lock per relay, a doorbell, and a door-opened contact. */
export class DoorStationAccessory {
  private readonly contact?: Service;
  private readonly doorbell?: Service;

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

    const relays = device.relays.filter((r) => r.enabled);
    for (const relay of relays) {
      const name = relays.length > 1 ? `${device.location} ${relay.doorName}` : device.location;
      const service = accessory.getServiceById(Service.LockMechanism, relay.relayId) ?? accessory.addService(Service.LockMechanism, name, relay.relayId);
      this.wireLock(service, device.mac, relay.relayId);
    }

    this.doorbell = accessory.getService(Service.Doorbell) ?? accessory.addService(Service.Doorbell, device.location);
    this.contact = accessory.getService(Service.ContactSensor) ?? accessory.addService(Service.ContactSensor, `${device.location} opened`);
    this.contact.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_DETECTED);
  }

  private wireLock(service: Service, mac: string, relayId: string): void {
    const { Characteristic } = this.platform.hap;
    const current = Characteristic.LockCurrentState;
    const target = Characteristic.LockTargetState;
    service.updateCharacteristic(current.LockCurrentState, current.SECURED);
    service.updateCharacteristic(target.LockTargetState, target.SECURED);

    const handler = makeLockTargetHandler({
      unlock: () => this.platform.session.openDoor(mac, relayId),
      setCurrent: (v) => service.updateCharacteristic(current.LockCurrentState, v),
      setTarget: (v) => service.updateCharacteristic(target.LockTargetState, v),
      states: { secured: current.SECURED, unsecured: current.UNSECURED },
      relockMs: this.platform.unlockSeconds * 1000,
      log: this.platform.log,
    });
    service.getCharacteristic(target.LockTargetState).onSet((value: CharacteristicValue) => handler(Number(value)));
  }

  ring(): void {
    const { Characteristic } = this.platform.hap;
    this.doorbell?.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    this.platform.log.info(`Doorbell ring at ${this.accessory.displayName}`);
  }

  opened(): void {
    const { Characteristic } = this.platform.hap;
    const state = Characteristic.ContactSensorState;
    this.contact?.updateCharacteristic(state.ContactSensorState, state.CONTACT_NOT_DETECTED);
    setTimeout(() => this.contact?.updateCharacteristic(state.ContactSensorState, state.CONTACT_DETECTED), CONTACT_OPEN_MS);
  }
}
