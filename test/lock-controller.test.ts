import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLockTargetHandler } from '../src/accessories/lock-controller.js';

const states = { secured: 1, unsecured: 0 };
const silent = { info: () => {}, error: () => {} };

describe('makeLockTargetHandler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('unlocks, shows unsecured, then relocks after the delay', async () => {
    const unlock = vi.fn(async () => {});
    const setCurrent = vi.fn();
    const setTarget = vi.fn();
    const handler = makeLockTargetHandler({ unlock, setCurrent, setTarget, states, relockMs: 5000, log: silent });

    await handler(states.unsecured);
    expect(unlock).toHaveBeenCalledOnce();
    expect(setCurrent).toHaveBeenLastCalledWith(states.unsecured);
    expect(setTarget).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(setCurrent).toHaveBeenLastCalledWith(states.secured);
    expect(setTarget).toHaveBeenCalledWith(states.secured);
  });

  it('does not call the cloud when the target is Secured', async () => {
    const unlock = vi.fn(async () => {});
    const setCurrent = vi.fn();
    const handler = makeLockTargetHandler({ unlock, setCurrent, setTarget: vi.fn(), states, relockMs: 5000, log: silent });

    await handler(states.secured);
    expect(unlock).not.toHaveBeenCalled();
    expect(setCurrent).toHaveBeenCalledWith(states.secured);
  });

  it('reverts the target and rethrows when the unlock fails', async () => {
    const unlock = vi.fn(async () => {
      throw new Error('cloud down');
    });
    const setCurrent = vi.fn();
    const setTarget = vi.fn();
    const handler = makeLockTargetHandler({ unlock, setCurrent, setTarget, states, relockMs: 5000, log: silent });

    await expect(handler(states.unsecured)).rejects.toThrow('cloud down');
    expect(setTarget).toHaveBeenCalledWith(states.secured);
    expect(setCurrent).not.toHaveBeenCalledWith(states.unsecured);
  });
});
