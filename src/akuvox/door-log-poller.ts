import { EventEmitter } from 'node:events';
import type { SessionManager } from './session-manager.js';
import type { DoorLogEntry } from './types.js';

/** Entries newer than `lastSeenId`, oldest-first; the full list when nothing was seen yet. */
export function newEntriesSince(entries: DoorLogEntry[], lastSeenId: string | undefined): DoorLogEntry[] {
  if (!lastSeenId) return [];
  const index = entries.findIndex((e) => e.id === lastSeenId);
  const fresh = index === -1 ? entries : entries.slice(0, index);
  return fresh.reverse();
}

export interface PollerLogger {
  warn: (m: string) => void;
}

/** Polls the member door log and emits `opened` for each new entry. */
export class DoorLogPoller extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private lastSeenId: string | undefined;

  constructor(
    private readonly session: SessionManager,
    private readonly log: PollerLogger,
    private readonly intervalMs = 30_000,
  ) {
    super();
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    let entries: DoorLogEntry[];
    try {
      entries = await this.session.getDoorLog(10);
    } catch (error) {
      this.log.warn(`Door-log poll failed: ${(error as Error).message}`);
      return;
    }
    if (entries.length === 0) return;
    const fresh = newEntriesSince(entries, this.lastSeenId);
    this.lastSeenId = entries[0]!.id;
    for (const entry of fresh) this.emit('opened', entry);
  }
}
