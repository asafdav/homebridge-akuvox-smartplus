# Akuvox SmartPlus cloud protocol (EMEA, app VBell 7.51)

Observed from the SmartPlus iOS app. Hosts are for the `ecloud` region.

## Hosts

| Role | Host |
|---|---|
| Gate | `https://gate.ecloud.akuvox.com:8600` |
| REST | `https://rest.ecloud.akuvox.com:8443` (`rest_server_https` from login) |
| Web logs | `https://backend.ecloud.akuvox.com` (`web_backend_server` from login) |
| Images | `akcs-ecloud-pic-bucket.s3.dualstack.eu-central-1.amazonaws.com` (signed `picUrl`) |

App requests send `User-Agent: VBell/7.51.3 (iPad; iOS 26.6; Scale/2.00)` and an `x-auth-token` header
(empty before login, the session token after).

## Login

```
GET  gate/login?user=<U>&passwd=<md5hex(md5hex(password))>[&id_code=<trusted device id>]   api-version 7.33
       U = username with letters and digits shifted +3; '+' and '@' sent unescaped
     → datas.is_need_two_factor_auth, two_factor_auth_temp_token, rest_server_https, web_backend_server

POST rest/apprest/v2/send_two_factor_authentication_code   api-version 7.1, form
       account_type=enduser, login_account=<username>, two_factor_auth_temp_token
     → code emailed to the account

POST gate/enduser/enduser_verify_code   api-version 7.33, JSON {verify_code, user: <username>}
     → datas.token, refresh_token, token_valid (seconds), two_factor_auth_idcode (36 chars),
       rest_server_https, web_backend_server, rtmp_server, vrtsp_server, vrtsps_server
```

## Staying logged in

| Path | Request | Result |
|---|---|---|
| Refresh | `POST gate/refresh_token` api-version **6.8**, JSON `{refresh_token}`, `x-auth-token: <token>` | new `token` + `refresh_token`; the old token stops working at once |
| Re-login | `GET gate/login?…&id_code=<two_factor_auth_idcode>` | full token without the email code |

Other api-versions get the plain-text reply `http req version is out of request`.

## Session calls (token in `?token=` and `x-auth-token`)

| Call | Request | Notes |
|---|---|---|
| Devices | `GET rest/userconf?token=` api-version 7.13 | `dev_list[]`: `mac`, `location`, `rtsp_pwd`, `rtsp_nonce`, `camera_num`, `relay[]` (`relay_id`, `door_name`, `enable`) |
| Unlock | `POST rest/opendoor?token=` api-version 7.1, form `mac`, `relay`, `trace_id` | `trace_id`: 22-char random id. Success: `result 0`, `datas.is_need_wait_response` |
| Door log | `GET backend/web-server/v4/smartplus/community/log/member/getDoorLog?row=&page=&_t=<epoch ms>` | `x-cloud-version: 6.4`, `Origin: https://ecloud.akuvox.com` |
| Call log | `GET backend/…/log/member/getCallLog?row=&page=&_t=` | same headers |
| Capture / motion logs | `…/log/member/getCaptureLog`, `…/getMotionLog` | same headers |

Web log responses use `{code: 0, msg, data: {list: [...]}}`.

## Events

| Event | Source | Match |
|---|---|---|
| Doorbell ring | `getCallLog` | `isCallee && isGroupCall`, keyed by `id`, time `startTime` |
| App unlock | `getDoorLog` | `captureType: remoteOpenDoor`, `response: success` |
| PIN unlock | `getDoorLog` | `captureType: localKeyUnlock` |

Door-log rows carry `captureTime`, `relayName`, `initiator`, `lockAction`, `picUrl`, `smallPicUrl`, `id`.

## Video

| URL | Transport | Result |
|---|---|---|
| `rtsp://ak:<rtsp_pwd>@<vrtsp_server>/<MAC>` | UDP | H.264 Baseline 640x480 30 fps |
| `rtsp://ak:<rtsp_pwd>@<rtmp_server host>:554/<MAC>` | UDP | same stream |
| either, or `rtsps://…@<vrtsps_server>/<MAC>` | TCP | refused (`Invalid data`) |

`rtsp_pwd` is the door unit's entry in `userconf`; relay hosts come from login or `gate/servers_list`.
The door unit's own LAN RTSP (`/live/ch00_0`) does not accept these credentials.
