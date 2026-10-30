import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AkuvoxSession } from './types.js';

const DIR_NAME = 'akuvox-smartplus';
const FILE_NAME = 'session.json';
const CREDENTIALS_FILE = 'credentials.json';

export interface StoredCredentials {
  email: string;
  password: string;
}

/**
 * Persists the account credentials owner-only, so the plugin can re-login by itself when a token
 * is invalidated. Same on-disk posture as the session token; keeps the password out of config.json.
 */
export class CredentialsStore {
  private readonly dir: string;
  private readonly file: string;

  constructor(storagePath: string) {
    this.dir = join(storagePath, DIR_NAME);
    this.file = join(this.dir, CREDENTIALS_FILE);
  }

  read(): StoredCredentials | undefined {
    try {
      const c = JSON.parse(readFileSync(this.file, 'utf8')) as StoredCredentials;
      return c.email && c.password ? c : undefined;
    } catch {
      return undefined;
    }
  }

  write(credentials: StoredCredentials): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}

/** Persists one Akuvox session as owner-only JSON under the Homebridge storage path. */
export class SessionStore {
  private readonly dir: string;
  private readonly file: string;

  constructor(storagePath: string) {
    this.dir = join(storagePath, DIR_NAME);
    this.file = join(this.dir, FILE_NAME);
  }

  get path(): string {
    return this.file;
  }

  read(): AkuvoxSession | undefined {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as AkuvoxSession;
    } catch {
      return undefined;
    }
  }

  write(session: AkuvoxSession): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(session, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}

/** True once the session is past `ratio` of its lifetime and should be refreshed proactively. */
export function isStale(session: AkuvoxSession, now = Date.now(), ratio = 0.8): boolean {
  if (!session.tokenValidSeconds) return false;
  const ageMs = now - Date.parse(session.obtainedAt);
  return ageMs >= session.tokenValidSeconds * 1000 * ratio;
}
