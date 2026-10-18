export interface RtspSource {
  /** `vrtsp_server`, e.g. "rtspsrv1.ecloud.akuvox.com:8601" (host:port). */
  vrtspServer?: string;
  /** Fallback relay host from `rtmp_server`; RTSP is served on :554 there. */
  relayHost?: string;
  mac: string;
  password: string;
}

/** The cloud relay RTSP URL for a door camera. Prefers vrtsp_server, falls back to the relay host. */
export function buildRtspUrl(source: RtspSource): string | undefined {
  const authority = source.vrtspServer || (source.relayHost ? `${source.relayHost}:554` : undefined);
  if (!authority) return undefined;
  return `rtsp://ak:${encodeURIComponent(source.password)}@${authority}/${source.mac}`;
}

/** Hide the RTSP password when a URL is logged. */
export function redactRtsp(url: string): string {
  return url.replace(/(rtsp:\/\/[^:]+:)[^@]+(@)/, '$1<redacted>$2');
}
