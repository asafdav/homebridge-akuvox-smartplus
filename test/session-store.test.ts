import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialsStore, isStale, SessionStore } from '../src/akuvox/session-store.js';
import type { AkuvoxSession } from '../src/akuvox/types.js';

const sample = (obtainedAt: string): AkuvoxSession => ({
  token: 't',
  refreshToken: 'r',
  tokenValidSeconds: 604800,
  restServer: 'rest.example.com',
  obtainedAt,
});

describe('SessionStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'akuvox-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when nothing is stored', () => {
    expect(new SessionStore(dir).read()).toBeUndefined();
  });

  it('round-trips a session and writes it owner-only', () => {
    const store = new SessionStore(dir);
    const session = sample(new Date().toISOString());
    store.write(session);
    expect(store.read()).toEqual(session);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });
});

describe('CredentialsStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'akuvox-cred-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips credentials owner-only', () => {
    const store = new CredentialsStore(dir);
    store.write({ email: 'a@b.com', password: 'pw' });
    expect(store.read()).toEqual({ email: 'a@b.com', password: 'pw' });
    expect(statSync(join(dir, 'akuvox-smartplus', 'credentials.json')).mode & 0o777).toBe(0o600);
  });

  it('returns undefined when absent or incomplete', () => {
    const store = new CredentialsStore(dir);
    expect(store.read()).toBeUndefined();
    store.write({ email: 'a@b.com', password: '' });
    expect(store.read()).toBeUndefined();
  });
});

describe('isStale', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');

  it('is false early in the token lifetime', () => {
    expect(isStale(sample('2026-01-09T18:00:00Z'), now)).toBe(false);
  });

  it('is true past 80% of the lifetime', () => {
    expect(isStale(sample('2026-01-03T00:00:00Z'), now)).toBe(true);
  });

  it('is false when no lifetime is known', () => {
    expect(isStale({ ...sample('2026-01-01T00:00:00Z'), tokenValidSeconds: 0 }, now)).toBe(false);
  });
});
