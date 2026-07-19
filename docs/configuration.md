# Configuration reference

The server reads an ignored JSON file and then applies selected environment
overrides. `config.schema.json` is the machine-readable source for supported
fields. Editors that understand JSON Schema can use the `$schema` entry in
`config.example.json` for completion and validation.

Run `bun run setup` to create `config.json` without overwriting an existing file,
then run `bun run doctor` after editing it. Treat the file as a secret: it may
contain printer, camera, cloud, and write-API credentials.

Setup will not create a differently named credential file inside the checkout,
because only `config.json` has the repository's guaranteed ignore rules. For a
custom setup target, set `CONFIG_PATH` or `LIVESTREAM_CONFIG` to an absolute path
outside the repository. The runtime can still read an existing relative custom
path when an operator has deliberately managed its exclusion and permissions.

## Runtime paths and environment overrides

| Environment variable | JSON equivalent | Purpose |
|---|---|---|
| `CONFIG_PATH` | — | Configuration path; relative paths resolve from the repository/application root. Default: `config.json`. |
| `DATA_DIR` | — | Writable state/cache directory. Default: `cache`. |
| `LISTEN_HOST` | `listenHost` | HTTP bind address. Docker sets `0.0.0.0`; native installs default to `127.0.0.1`. |
| `PORT` | `port` | HTTP port, from 1 through 65535. Default: `8787`. |
| `PRINTER_HOST` | `printerHost` | PrusaLink hostname or IP address. |
| `PRINTER_USERNAME` | `username` | PrusaLink Digest username. |
| `PRINTER_PASSWORD` | `password` | PrusaLink password. |
| `CAMERA_RTSP_URL` | `cameraRtspUrl` | Private RTSP source URL. |
| `CAMERA_STREAM_ENABLED` | `cameraStreamEnabled` | Boolean camera override (`true`/`false`, `1`/`0`, `yes`/`no`). |
| `OVERLAY_API_TOKEN` | `apiToken` | Bearer token required by write endpoints when configured. |
| `SOURCE_CODE_URL` | `sourceCodeUrl` | Public corresponding source offered to remote users. Modified deployments must use their exact source revision. |

Every override also accepts a `LIVESTREAM_` prefix, for example
`LIVESTREAM_CONFIG` and `LIVESTREAM_PORT`. Environment-only deployments are
supported when all three required printer variables are present. JSON is easier
for the nested tool-slot and presentation settings.

Environment overrides take precedence over JSON. The provided Docker image and
Compose file always supply `SOURCE_CODE_URL` from image/build metadata, so set
that environment variable—not `sourceCodeUrl` in the mounted JSON—for a
modified container deployment.

## Core and presentation settings

| Setting | Type and default | Notes |
|---|---|---|
| `printerHost` | required string | Hostname or IP only, without `http://`. |
| `username` / `password` | required strings | PrusaLink credentials. `password` is sensitive. |
| `listenHost` | string, `127.0.0.1` | Keep loopback unless remote read access is deliberate. `bindHost` is a deprecated alias. |
| `port` | integer, `8787` | Local HTTP port. |
| `pollIntervalMs` | integer, `2000` | Do not aggressively lower this; the printer board is resource constrained. |
| `sourceCodeUrl` | HTTP(S) URL, project repository | Shown as the dashboard's source/license link and emitted in the HTTP `Link` header. Point modified deployments at their exact corresponding source. |
| `toolCount` | integer 1–32, `1` | Number of tool slots rendered. |
| `toolSlots` | object, `{}` | 1-based keys with `loaded`, `name`, and `#RRGGBB` `color`. |
| `printNameOverrides` | object, `{}` | Exact job-key to display-name replacements. |
| `overlayHost` | object | Optional avatar text, name, badge, automation badge, and `/assets/` icon. `iconMode` is `image` for a normal asset or `pet-atlas` for a Codex v2 8-column by 11-row sprite atlas. |
| `localBgcodeDirs` | string array, `[]` | Native filesystem folders searched before downloading a job from the printer. Container paths must be mounted explicitly. |
| `apiToken` | secret string | Setup generates 32 random bytes. When non-empty, every control write request must provide it. Without a token, writes require a loopback socket and loopback Host; browser requests must additionally be same-origin. |

## Camera settings

| Setting | Type and default | Notes |
|---|---|---|
| `cameraRtspUrl` | secret string, empty | May contain credentials and is passed to FFmpeg; use a dedicated low-privilege camera account. |
| `cameraStreamEnabled` | boolean | A URL enables the relay when this field is omitted; `false` explicitly disables it. |
| `cameraFfmpegPath` | string, `ffmpeg` | Executable name or absolute path. |
| `cameraStreamFps` | integer 1–30, `24` | Output MJPEG frame rate. |
| `cameraStreamWidth` | integer 320–3840, `1920` | Output width; aspect ratio is retained. |
| `cameraStreamJpegQuality` | integer 2–31, `5` | FFmpeg JPEG quality scale; lower is higher quality. |
| `cameraStreamThreads` | integer 1–16, `4` | Shared decoder/filter/encoder thread cap. |
| `cameraStreamIdleMs` | integer, `10000` | Delay before stopping an unused upstream reader. |
| `cameraStreamStallMs` | integer, `20000` | No-frame watchdog threshold. |
| `cameraStreamIoTimeoutMs` | integer, `15000` | RTSP socket I/O timeout. |
| `cameraStreamKillGraceMs` | integer, `3000` | Grace before a stuck FFmpeg child is force-stopped. |
| `cameraStreamRestartBaseMs` / `cameraStreamRestartMaxMs` | integers, `1000` / `15000` | Retry backoff bounds. |
| `cameraStreamMaxFrameBytes` | integer, `16777216` | Safety cap for one JPEG frame. |

## Optional cloud integrations

Prusa Connect needs `connectPrinterUuid` and `connectRefreshToken`; Netatmo needs
all three `netatmoClientId`, `netatmoClientSecret`, and `netatmoRefreshToken`
values. Refresh tokens are sensitive and rotate into `DATA_DIR`. Keep that
directory private and persistent.

| Setting | Default | Notes |
|---|---|---|
| `useConnect` | automatic | Complete credentials enable Connect unless this is `false`. This experimental integration uses Prusa Connect's browser client and undocumented web endpoints; no supported OAuth bootstrap is provided, so leave it disabled unless you already manage compatible credentials. |
| `connectPrinterUuid` | empty | Printer identifier. Avoid including it in public logs. |
| `connectClientId` | built-in public browser client ID | Optional override. The value is not a secret, but the integration may change without notice. |
| `connectRefreshToken` | empty | Sensitive rotating OAuth refresh token. |
| `connectPollMs` | `5000` | Cloud polling cadence. |
| `useNetatmo` | automatic | Complete credentials enable Netatmo unless this is `false`. |
| `netatmoClientId` / `netatmoClientSecret` / `netatmoRefreshToken` | empty | Sensitive OAuth values. |
| `netatmoPollMs` | `300000` | Station polling cadence. |

## Storage and safety limits

| Setting | Default | Purpose |
|---|---:|---|
| `analysisCacheMaxEntries` | `100` | Maximum retained job analyses. |
| `analysisCacheMaxBytes` | `67108864` | Analysis cache size cap (64 MiB). |
| `automationLeaseMs` | `45000` | Fail-closed automation presence lifetime; accepted range is 15000–300000 ms. |
| `lastStateWriteMs` | `10000` | Last-known state persistence cadence. |
| `maxPrinterJsonBytes` | `1048576` | Maximum JSON telemetry response size. |
| `maxPrinterResponseBytes` | `536870912` | Maximum binary printer response, including `.bgcode`. |

## Network boundary

Read endpoints are intentionally unauthenticated and can expose printer state,
job history, room telemetry, and live camera images. `apiToken` protects writes,
not reads. Keep native installs on `127.0.0.1`. Compose listens on all interfaces
inside the container but publishes only to host `127.0.0.1` by default.

For deliberate remote access, use a firewall or authenticated TLS reverse proxy.
Do not assume that binding the service to a LAN address makes its camera endpoint
private.
