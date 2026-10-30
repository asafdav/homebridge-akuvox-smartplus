# Handoff: stream the intercom camera over the LAN instead of the Akuvox cloud

## Goal
`homebridge-akuvox-smartplus` (this repo, v0.3.1, deployed on the Pi) streams the gate
intercom's camera through the Akuvox cloud relay. Add a **local RTSP source, tried first,
with automatic fallback to the cloud**, and point it at the Dahua NVR's copy of the intercom
stream. Doorbell, unlock and two-way audio must keep working unchanged.

```
today:  intercom ──► Akuvox cloud (rtspsrv1.ecloud.akuvox.com:8601, UDP) ──► Pi ──► HomeKit
new:    intercom ──► Dahua NVR ch1 (LAN, TCP) ──► Pi ──► HomeKit
                                    └─ local fails before first frame ─► cloud (as today)
```

## Environment

| Thing | Value |
|---|---|
| Repo | `~/git/homebridge-akuvox-smartplus`, `main`, TypeScript sources in `src/`, vitest in `test/` (`npm test`, `npm run lint`) |
| Pi | `ssh homebridge` (192.168.1.191, wired; user `asafdav`, passwordless sudo). Debian, Pi 5 |
| Homebridge | 2.1.0, node `/opt/homebridge/bin/node` (not on PATH), storage `/var/lib/homebridge` |
| Config / log | `/var/lib/homebridge/config.json`, `/var/lib/homebridge/homebridge.log` (owned by `homebridge`, read with sudo) |
| This plugin | child bridge "Akuvox SmartPlus", port 51830; door station MAC `0C11052A6095` |
| Other bridges | LG ThinQ (child), SmartThings (main bridge). Do not disturb them |
| ffmpeg | `/usr/local/bin/ffmpeg`; no ffprobe, bc, nmap, or drawtext on the Pi |

## Local sources

| Source | URL | Status |
|---|---|---|
| **NVR ch1 (use this)** | `rtsp://<user>:<pass>@192.168.1.230:554/cam/realmonitor?channel=1&subtype=1` | Verified: H.264 Baseline 640x480 4:3 square pixels, 25 fps, keyframe every 1.2 s, ~3.5 s to first frame over TCP |
| NVR ch1 main | same with `subtype=0` | 704x576 with unknown SAR, so the current scale/pad filter letterboxes it; no benefit since HomeKit is offered at most 640x480 |
| Intercom direct | `rtsp://<ip>/live/ch00_0` on 192.168.1.212 | `401` until RTSP credentials are set in the intercom web UI (Surveillance > RTSP). Later swap, URL change only |

NVR viewer credentials (low-privilege, live/playback only) live on the Pi in
`~/.dahua-viewer` as one line `user:pass`.

## Current code path

| Concern | Location |
|---|---|
| Cloud URL builder | `src/camera/rtsp.ts` `buildRtspUrl`, `redactRtsp` |
| Cloud hosts | `src/akuvox/session-manager.ts` `getRtspInfo()` |
| Camera wiring and gate (`rtspPassword && cameraCount > 0`) | `src/accessories/camera-doorbell.ts` |
| Live stream / snapshot cache / ready timer (first `frame=` or 4 s) | `src/camera/streaming-delegate.ts` |
| Doorbell press, which forces a snapshot refresh | `camera-doorbell.ts` `ring()` → `warmSnapshot()` |
| ffmpeg args (`-rtsp_transport udp` hard-coded) | `src/camera/ffmpeg-args.ts` |
| Config type | `src/platform.ts` `AkuvoxConfig` |
| UI schema | `config.schema.json` |

## Design
1. **Config:** `cameras: [{ mac, rtspUrl, rtspTransport: 'tcp' | 'udp' (default 'tcp') }]`,
   keyed by door station MAC (match case-insensitively, ignore `:`). Mask `rtspUrl` in the
   schema form.
2. **Sources:** `StreamSource { url, transport, label: 'local' | 'cloud' }`. Build an ordered
   list, local first. Cloud keeps UDP.
3. **ffmpeg args:** `transport` becomes a parameter of `snapshotArgs` / `videoStreamArgs`.
4. **Snapshots:** try each source in order.
5. **Live:** spawn with the first source. If ffmpeg exits before the stream counts as started,
   respawn with the next one. The HomeKit callback must fire exactly once.
6. **Logs:** say which source was used (`Starting camera stream (local) from <redacted>`).
   Never log credentials.
7. **Camera creation:** still create the camera when there is a local URL but no cloud
   `rtspPassword`.
8. **Don't add** `-fflags nobuffer -flags low_delay` or a small probesize: they measured slower
   to first frame against this NVR.

## Steps
1. Branch off `main`.
2. Implement the design across `rtsp.ts`, `ffmpeg-args.ts`, `streaming-delegate.ts`,
   `platform.ts`, `camera-doorbell.ts` and `config.schema.json`.
3. Add tests, bump the version to 0.4.0, and add a README config example.
4. `npm run lint && npm test`.
5. Show the diff to the user. Ask before pushing, deploying or restarting.

## Verification

### Unit (vitest)
- Source ordering: local first; cloud only; empty.
- `-rtsp_transport tcp` / `udp` emitted per source. Update the existing "over udp" test.
- `redactRtsp` masks a Dahua URL with a query string and a percent-encoded password.
- Delegate with `spawn` mocked:
  - a failed local snapshot leads to a cloud retry;
  - a local stream exiting before `frame=` respawns on cloud, with the callback called once;
  - an exit after `frame=` does not respawn.
- MAC matching ignores case and `:`.

### On the Pi (after the user approves the deploy)
1. Back up: `sudo cp /var/lib/homebridge/config.json /var/lib/homebridge/config.json.bak-$(date +%Y%m%d-%H%M%S)`
2. Deploy:
   - `npm pack`, then `scp` the tgz to `/tmp`.
   - `sudo -u homebridge env PATH=/opt/homebridge/bin:$PATH /opt/homebridge/bin/npm install /tmp/<tgz> --prefix /var/lib/homebridge --no-save --no-audit --no-fund`
3. Add the `cameras` entry to the `AkuvoxSmartPlus` platform. Build the URL **inside the remote
   shell** from `~/.dahua-viewer`, URL-encoding user and password with python3
   `urllib.parse.quote(..., safe="")`, and write it with a node/jq edit. Never echo it.
4. `sudo systemctl restart homebridge`.
5. Log shows `Starting camera stream (local)`, and no fallback or snapshot-failure lines.
6. While a live view is open:
   - `ps -eo args | grep [f]fmpeg | sed "s#rtsp://[^@]*@#rtsp://***@#g"` shows `-rtsp_transport tcp -i rtsp://***@192.168.1.230`;
   - `ss -tn dst 192.168.1.230:554` shows an established connection;
   - there is no connection to port 8601.
7. The NVR password does not appear in the log. Count matches inside the remote shell; never print it.
8. Fallback test: set a wrong port, confirm cloud fallback and a working view, then put the URL back.
9. LG ThinQ and SmartThings still load (log), and the other child bridges are still running.

### Home app (user)
- Live view starts in about 3–4 s, 4:3 with no bars, steady for 2 minutes or more.
- Doorbell press: the notification image is fresh. Press twice, more than 30 s apart.
- Two-way audio on answer still works.
- Unlock still works.
- Two viewers at once.

### Rollback
Remove the `cameras` entry and restart (the plugin is cloud-only again), or reinstall v0.3.1
and restore the config backup.

## Rules
- Never print, echo, or commit secrets: the NVR password, Akuvox tokens, `rtspPassword`.
  Redact when reading `config.json`. Pipe ffmpeg output through
  `sed "s#rtsp://[^@]*@#rtsp://***@#g"`.
- Don't guess or brute-force the intercom password.
- Back up `config.json` before any change. Confirm with the user before restart or deploy.
- Verify with real runs on the Pi, not by reasoning.
- A parallel task is adding the six Dahua cameras as a separate `homebridge-camera-ffmpeg`
  child bridge. Don't touch that bridge's config.
