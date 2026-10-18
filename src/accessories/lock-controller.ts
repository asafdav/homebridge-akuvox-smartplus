export interface LockStates {
  secured: number;
  unsecured: number;
}

export interface LockControllerOptions {
  unlock: () => Promise<void>;
  setCurrent: (value: number) => void;
  setTarget: (value: number) => void;
  states: LockStates;
  relockMs: number;
  log: { info: (m: string) => void; error: (m: string) => void };
}

/**
 * The door is a momentary buzzer, not a latch: an unlock opens it briefly and HomeKit
 * must snap back to Secured. Returns the handler for LockTargetState writes.
 */
export function makeLockTargetHandler(opts: LockControllerOptions): (target: number) => Promise<void> {
  return async (target) => {
    if (target !== opts.states.unsecured) {
      opts.setCurrent(opts.states.secured);
      return;
    }
    try {
      await opts.unlock();
    } catch (error) {
      opts.log.error(`Unlock failed: ${(error as Error).message}`);
      opts.setTarget(opts.states.secured);
      throw error;
    }
    opts.setCurrent(opts.states.unsecured);
    setTimeout(() => {
      opts.setCurrent(opts.states.secured);
      opts.setTarget(opts.states.secured);
    }, opts.relockMs);
  };
}
