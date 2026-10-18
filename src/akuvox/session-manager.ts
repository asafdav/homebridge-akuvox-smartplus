import { AkuvoxCloud, AkuvoxError, type LoginResult } from './cloud.js';
import { isStale, SessionStore } from './session-store.js';
import type { AkuvoxDevice, AkuvoxSession, DoorLogEntry } from './types.js';

export class NotPairedError extends AkuvoxError {}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Keeps a valid Akuvox token on hand, refreshing or re-logging-in as needed. */
export class SessionManager {
  private session: AkuvoxSession | undefined;

  constructor(
    private readonly cloud: AkuvoxCloud,
    private readonly store: SessionStore,
    private readonly log: Logger,
  ) {
    this.session = store.read();
  }

  get isPaired(): boolean {
    return this.session !== undefined;
  }

  /** Persist the result of a fresh login or pairing as the active session. */
  adopt(result: LoginResult, sip?: { sipUser: string; sipPassword: string }, sipServer?: string): AkuvoxSession {
    const session: AkuvoxSession = {
      token: result.token,
      refreshToken: result.refreshToken,
      tokenValidSeconds: result.tokenValidSeconds,
      idCode: result.idCode ?? this.session?.idCode,
      restServer: result.restServer ?? this.session?.restServer ?? '',
      webBackendServer: result.webBackendServer ?? this.session?.webBackendServer,
      rtspRelay: result.rtspRelay ?? this.session?.rtspRelay,
      vrtspServer: result.vrtspServer ?? this.session?.vrtspServer,
      sipUser: sip?.sipUser ?? this.session?.sipUser,
      sipPassword: sip?.sipPassword ?? this.session?.sipPassword,
      sipServer: sipServer ?? this.session?.sipServer,
      obtainedAt: new Date().toISOString(),
    };
    this.session = session;
    this.store.write(session);
    return session;
  }

  private current(): AkuvoxSession {
    if (!this.session) throw new NotPairedError('No Akuvox session. Run `akuvox-pair` once to sign in.');
    return this.session;
  }

  private async renew(): Promise<AkuvoxSession> {
    const s = this.current();
    try {
      this.log.info('Refreshing Akuvox token');
      return this.adopt(await this.cloud.refresh(s.refreshToken, s.token));
    } catch (error) {
      this.log.warn(`Token refresh failed (${(error as Error).message}); trying trusted re-login`);
    }
    if (s.idCode) {
      return this.adopt(await this.cloud.reloginWithIdCode(s.idCode));
    }
    throw new NotPairedError('Session expired and cannot be renewed. Run `akuvox-pair` again.');
  }

  private async token(): Promise<AkuvoxSession> {
    const s = this.current();
    return isStale(s) ? this.renew() : s;
  }

  /** Run an authenticated call, renewing the token once if the server rejects it. */
  private async withAuth<T>(fn: (s: AkuvoxSession) => Promise<T>): Promise<T> {
    let s = await this.token();
    try {
      return await fn(s);
    } catch (error) {
      if (!(error instanceof AkuvoxError)) throw error;
      this.log.warn(`Authenticated call failed (${error.message}); renewing token and retrying`);
      s = await this.renew();
      return fn(s);
    }
  }

  listDevices(): Promise<AkuvoxDevice[]> {
    return this.withAuth((s) => this.cloud.listDevices(s.restServer, s.token));
  }

  openDoor(mac: string, relayId: string): Promise<void> {
    return this.withAuth((s) => this.cloud.openDoor(s.restServer, s.token, mac, relayId));
  }

  getDoorLog(rows?: number): Promise<DoorLogEntry[]> {
    return this.withAuth((s) => {
      if (!s.webBackendServer) throw new AkuvoxError('no web backend server in session');
      return this.cloud.getDoorLog(s.webBackendServer, s.token, rows);
    });
  }
}
