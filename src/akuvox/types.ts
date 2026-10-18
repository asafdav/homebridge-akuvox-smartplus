export type Envelope = Record<string, unknown>;

export interface AkuvoxSession {
  token: string;
  refreshToken: string;
  tokenValidSeconds: number;
  idCode?: string;
  restServer: string;
  webBackendServer?: string;
  rtspRelay?: string;
  vrtspServer?: string;
  sipUser?: string;
  sipPassword?: string;
  sipServer?: string;
  obtainedAt: string;
}

export interface AkuvoxRelay {
  relayId: string;
  doorName: string;
  enabled: boolean;
}

export interface AkuvoxDevice {
  mac: string;
  location: string;
  /** '1' is an outdoor door station, '2' an indoor monitor. */
  devType: string;
  sip?: string;
  rtspPassword?: string;
  cameraCount: number;
  relays: AkuvoxRelay[];
}

export interface DoorLogEntry {
  id: string;
  captureTime: string;
  captureType: string;
  response: string;
  relayName: string;
  initiator: string;
  picUrl?: string;
}
