import { describe, expect, it } from 'vitest';
import { newEntriesSince } from '../src/akuvox/door-log-poller.js';
import type { DoorLogEntry } from '../src/akuvox/types.js';

const entry = (id: string): DoorLogEntry => ({ id, captureTime: id, captureType: 'remoteOpenDoor', response: 'success', relayName: 'Relay1', initiator: 'x' });

// getDoorLog returns newest-first.
const log = [entry('e5'), entry('e4'), entry('e3'), entry('e2'), entry('e1')];

describe('newEntriesSince', () => {
  it('returns nothing on the first poll (no baseline yet)', () => {
    expect(newEntriesSince(log, undefined)).toEqual([]);
  });

  it('returns entries newer than the last seen, oldest-first', () => {
    expect(newEntriesSince(log, 'e3').map((e) => e.id)).toEqual(['e4', 'e5']);
  });

  it('returns empty when nothing is newer', () => {
    expect(newEntriesSince(log, 'e5')).toEqual([]);
  });

  it('treats an unknown last-seen id as a full gap and reports all, oldest-first', () => {
    expect(newEntriesSince(log, 'gone').map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });
});
