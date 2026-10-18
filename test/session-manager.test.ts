import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AkuvoxError, type AkuvoxCloud, type LoginResult } from '../src/akuvox/cloud.js';
import { SessionManager } from '../src/akuvox/session-manager.js';
import { SessionStore } from '../src/akuvox/session-store.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** A refresh response carries only a new token and refresh token — no server fields. */
const refreshResult = (token: string): LoginResult => ({
  token,
  refreshToken: `${token}-r`,
  tokenValidSeconds: 604800,
  restServer: undefined as unknown as string,
  raw: {},
});

describe('SessionManager renew', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'akuvox-mgr-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps restServer and calls the API with it after a stale refresh', async () => {
    const store = new SessionStore(dir);
    store.write({ token: 'old', refreshToken: 'old-r', tokenValidSeconds: 604800, restServer: 'rest.example.com', webBackendServer: 'backend.example.com', idCode: 'ID', obtainedAt: '2026-01-01T00:00:00Z' });

    const cloud = {
      refresh: vi.fn(async () => refreshResult('new')),
      listDevices: vi.fn(async () => []),
    } as unknown as AkuvoxCloud;

    const manager = new SessionManager(cloud, store, silent);
    await manager.listDevices();

    expect(cloud.refresh).toHaveBeenCalledWith('old-r', 'old');
    expect(cloud.listDevices).toHaveBeenCalledWith('rest.example.com', 'new');
    expect(store.read()?.restServer).toBe('rest.example.com');
    expect(store.read()?.token).toBe('new');
  });

  it('retries once on an auth error by renewing the token', async () => {
    const store = new SessionStore(dir);
    store.write({ token: 'old', refreshToken: 'old-r', tokenValidSeconds: 604800, restServer: 'rest.example.com', idCode: 'ID', obtainedAt: new Date().toISOString() });

    const listDevices = vi.fn()
      .mockRejectedValueOnce(new AkuvoxError('listDevices failed: expired'));
    const cloud = {
      refresh: vi.fn(async () => refreshResult('new')),
      listDevices,
    } as unknown as AkuvoxCloud;
    // Second call resolves.
    listDevices.mockResolvedValueOnce([]);

    const manager = new SessionManager(cloud, store, silent);
    await expect(manager.listDevices()).resolves.toEqual([]);
    expect(cloud.refresh).toHaveBeenCalledTimes(1);
    expect(listDevices).toHaveBeenCalledTimes(2);
  });
});
