# homebridge-akuvox-smartplus

A [Homebridge](https://homebridge.io) plugin that brings an **Akuvox SmartPlus** intercom into
Apple HomeKit through the Akuvox cloud — no extra hub, no Home Assistant.

| HomeKit accessory | Backed by |
|---|---|
| **Video doorbell** (live view + ring) | Cloud RTSP relay (UDP) + a SIP registration that receives the door call |
| **Lock** per door relay | The cloud `opendoor` API |
| **Contact sensor** ("opened") | The member door log |

It signs in with a dedicated **family-member** account and never answers the door call — it only
listens for the ring, so your phones keep ringing as before.

## Requirements

- Homebridge 2, Node 22+
- `ffmpeg` on the host (for camera snapshots and streaming)
- An Akuvox SmartPlus **family-member** account (keep your personal login for your phone)

## Install

```bash
npm install -g homebridge-akuvox-smartplus
```

Or in the Homebridge UI, search for **Akuvox SmartPlus**.

## Configure

Add the platform (UI or `config.json`). Credentials are **not** required in config — pairing takes
them interactively and stores only a session token.

```json
{
  "platforms": [
    {
      "platform": "AkuvoxSmartPlus",
      "name": "Akuvox SmartPlus",
      "region": "ecloud",
      "unlockSeconds": 5,
      "doorbell": true
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `region` | Akuvox cloud region: `ecloud` (EU/ME), `ucloud` (Americas), `scloud`, `jcloud`, `ccloud`, `rucloud` |
| `unlockSeconds` | How long the lock shows Unlocked before snapping back (the door is a momentary buzzer) |
| `doorbell` | Register on the intercom PBX for real-time ring notifications |
| `email`, `password` | Optional. Only needed for automatic full re-login if the token ever fully expires |
| `cameras` | Optional. Stream a door station from a local RTSP source (e.g. an NVR channel) instead of the Akuvox cloud, with automatic fallback to the cloud |

### Local camera source (optional)

By default the door camera streams through the Akuvox cloud relay. If the intercom is also
reachable locally — for example as a channel on an NVR — point the plugin at that RTSP URL to
get a faster, cloud-independent stream. It's tried first, and falls back to the cloud if the
local source fails. Match it to the door station by MAC (separators and case are ignored).

```json
{
  "platform": "AkuvoxSmartPlus",
  "region": "ecloud",
  "cameras": [
    {
      "mac": "0C:11:05:2A:60:95",
      "rtspUrl": "rtsp://viewer:password@192.168.1.230:554/cam/realmonitor?channel=1&subtype=1",
      "rtspTransport": "tcp"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `mac` | The door station's MAC (match is case- and separator-insensitive) |
| `rtspUrl` | Local RTSP URL for that camera. Use a low-privilege viewer account |
| `rtspTransport` | `tcp` (default) or `udp` |

## Pair (one time)

The first sign-in needs a code emailed to the account:

```bash
akuvox-pair
```

Enter the email, password and the emailed code when prompted, then restart Homebridge. The plugin
keeps itself signed in afterwards by refreshing its token.

## How it works

```
Apple Home ── Homebridge ── homebridge-akuvox-smartplus ──HTTPS──► Akuvox cloud
                             ├ Lock            → opendoor
                             ├ Video doorbell  → SIP INVITE (ring) + RTSP (UDP) video
                             └ Contact sensor  → member door log (polled)
```

## Credits

Login/unlock/event protocol was observed from the SmartPlus app and informed by the
[nimroddolev/akuvox](https://github.com/nimroddolev/akuvox) Home Assistant integration (MIT).

## License

MIT
