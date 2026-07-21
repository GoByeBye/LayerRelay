# Configuration reference

The server reads an ignored JSON file and then applies selected environment
overrides. `config.schema.json` is the machine-readable source for supported
fields. Editors that understand JSON Schema can use the `$schema` entry in
`config.example.json` for completion and validation.

Run `bun run setup` to create `config.json` without overwriting an existing file,
then run `bun run doctor` after editing it. Treat the complete file as private:
it may contain printer, camera, cloud, filesystem, and identifying deployment
details.

Setup will not create a differently named credential file inside the checkout,
because only `config.json` has the repository's guaranteed ignore rules. For a
custom setup target, set `CONFIG_PATH` or `LAYER_RELAY_CONFIG` to an absolute path
outside the repository. The runtime can still read an existing relative custom
path when its exclusion and permissions are deliberately managed.

## Examples and sensitivity

`config.example.json` contains sanitized values for every supported JSON setting.

Treat credential-bearing fields as secrets: `password`, `connectRefreshToken`,
`netatmoClientId`, `netatmoClientSecret`, and `netatmoRefreshToken`. Treat
`cameraRtspUrl` as private deployment data. The
[Buddy3D local endpoint](https://help.prusa3d.com/article/buddy3d-camera_821264)
contains no embedded credential, but it is an unencrypted, unprotected live feed;
other camera URLs may contain credentials. Also sanitize identifying values such
as `printerHost`, `username`, `connectPrinterUuid`, local paths, print-name
overrides, and tool-slot names. Operational fields are not secret, but some
still reveal deployment details.

## Runtime paths and environment overrides

| Environment variable | JSON equivalent | Type and default | Sensitivity | Example | Purpose |
|---|---|---|---|---|---|
| `CONFIG_PATH` | — | path string, `config.json` | Deployment detail; file is secret | `/etc/layer-relay/config.json` | Configuration path; relative paths resolve from the application root. |
| `DATA_DIR` | — | path string, `cache` | Private runtime state | `/var/lib/layer-relay` | Writable state and analysis-cache directory. |
| `LISTEN_HOST` | `listenHost` | string, `127.0.0.1` | Deployment detail | `127.0.0.1` | HTTP bind address; Docker sets `0.0.0.0` internally. |
| `PORT` | `port` | integer 1–65535, `8787` | Non-secret | `8787` | HTTP port. |
| `PRINTER_HOST` | `printerHost` | non-empty string, required | Identifying | `192.0.2.10` | PrusaLink hostname or IP address. |
| `PRINTER_USERNAME` | `username` | non-empty string, required | Credential and identifying | `maker` | PrusaLink Digest username. |
| `PRINTER_PASSWORD` | `password` | non-empty string, required | Secret | `replace-with-your-prusalink-password` | PrusaLink password. |
| `CAMERA_RTSP_URL` | `cameraRtspUrl` | RTSP(S) URL, empty | Private; secret if credential-bearing | `rtsp://192.0.2.20/live` | Private camera source. Buddy3D uses an unencrypted, unauthenticated local feed without credentials in the URL. |
| `CAMERA_STREAM_ENABLED` | `cameraStreamEnabled` | boolean, automatic | Non-secret | `false` | Camera override (`true`/`false`, `1`/`0`, `yes`/`no`). |
| `SOURCE_CODE_URL` | `sourceCodeUrl` | HTTP(S) URL, project repository | Public | `https://github.com/GoByeBye/LayerRelay` | Corresponding source offered to remote users. Modified deployments must use their exact source revision. |

Every override also accepts a `LAYER_RELAY_` prefix, for example
`LAYER_RELAY_CONFIG` and `LAYER_RELAY_PORT`. Environment-only deployments are
supported when all three required printer variables are present. JSON is easier
for nested tool-slot settings.

The supplied container reserves canonical `CONFIG_PATH` for its staged private
copy and defaults canonical `DATA_DIR` to `/data`, so their prefixed aliases are
for native installs. Container deployments select the mounted input with
`CONFIG_SOURCE_PATH` and set canonical `DATA_DIR` only when intentionally using a
different mounted state path. Other branded overrides, including printer,
listener, port, camera, and source URL settings, work in the container.

Environment overrides take precedence over JSON. The provided Docker image and
Compose file always supply `SOURCE_CODE_URL` from image/build metadata, so set
that environment variable—not `sourceCodeUrl` in the mounted JSON—for a
modified container deployment.

## Core settings

| Setting | Type and default | Sensitivity | Example | Notes |
|---|---|---|---|---|
| `printerHost` | non-empty string, required | Identifying | `"192.0.2.10"` | Hostname or IP only, without `http://`. |
| `username` | non-empty string, required | Credential and identifying | `"maker"` | PrusaLink Digest username. |
| `password` | non-empty string, required | Secret | `"replace-with-your-prusalink-password"` | PrusaLink password. |
| `listenHost` | non-empty string, `"127.0.0.1"` | Deployment detail | `"127.0.0.1"` | Keep loopback unless remote read access is deliberate. |
| `port` | integer 1–65535, `8787` | Non-secret | `8787` | Local HTTP port. |
| `pollIntervalMs` | integer at least 250, `2000` | Non-secret | `2000` | Do not aggressively lower this; the printer board is resource constrained. |
| `sourceCodeUrl` | HTTP(S) URL, project repository | Public | `"https://github.com/GoByeBye/LayerRelay"` | Dashboard source/license link and HTTP `Link` target. Modified deployments must use their exact source. |
| `toolCount` | `null` or integer 1–32, `null` | Non-secret | `null` | `null` follows the tool inventory inferred from Prusa Connect; an integer is a manual count override. |
| `toolSettingsAllowedOrigins` | array of up to 16 exact HTTP(S) origins, `[]` | Non-secret | `["https://relay.example"]` | Extra named browser origins allowed to save tool settings. Loopback and literal IP origins are accepted automatically. Add only origins protected by your deployment boundary. |
| `toolSlots` | object, `{}` | Slot names may identify private inventory | `{"1":{"loaded":true,"name":"Example filament","color":"#ff8a3d"}}` | Slot keys are integers from 1 through 32; nested fields are below. |
| `printNameOverrides` | object of string values, `{}` | Identifying print names | `{"example.bgcode":"Demo vase"}` | Exact job-key to display-name replacements; values are at most 200 characters. |
| `localBgcodeDirs` | array of non-empty strings, `[]` | Local paths may identify a machine | `["/srv/gcode"]` | Folders searched before downloading a job from the printer; mount container paths explicitly. |

### Tool-slot settings

| Setting | Type and default | Sensitivity | Example |
|---|---|---|---|
| `toolSlots.<n>.loaded` | boolean, automatic | Non-secret | `true` |
| `toolSlots.<n>.name` | string up to 80 characters, omitted | Identifying when customized | `"Example filament"` |
| `toolSlots.<n>.color` | `#RRGGBB` string, omitted | Non-secret | `"#ff8a3d"` |

Tool-slot keys are integers from 1 through 32. Every nested field is an
independent override: when `loaded`, `name`, or `color` is omitted, that field
continues to follow Connect (or remains unknown when Connect has no value).
Setting a name or colour does not imply that the slot is loaded.

### Dashboard tool editor

The browser dashboard edits only the `toolCount` and `toolSlots` override layer;
it never reads, returns, or rewrites the credential-bearing configuration file.
The settings view shows detected Connect values, saved overrides, and the
server-resolved effective inventory separately. A successful save is validated,
applied to `/api/state` immediately, and written atomically to
`DATA_DIR/tool-settings.json`. An empty saved Auto snapshot takes precedence
over `config.json`, so clearing an override remains cleared after restart.
Keeping it under `DATA_DIR` also supports the supplied container's read-only
configuration mount and read-only root filesystem.

Connect tool keys determine the latest inferred count. Missing interior keys
stay unknown rather than being treated as empty, while explicit empty material
signals are rendered as unloaded. A successful inventory replaces the previous
count so hardware changes can shrink or grow automatically. Incomplete top-level
filament-only samples update the observed slot without collapsing an established
multi-tool count. Failed polls retain the last-known cache, scoped to the
configured printer UUID. LayerRelay never hides the currently active tool.

Settings writes accept loopback and literal-IP browser hosts by default. For a
named host or authenticated reverse proxy, add its exact browser origin (scheme,
host, and optional non-default port, with no path) to
`toolSettingsAllowedOrigins`. This explicit allowlist prevents DNS rebinding
from turning an unrelated public hostname into a local settings writer.

Text typed into a filament-name field is sent by the server through a bounded
same-origin proxy to the
public [FilamentColors.xyz API](https://github.com/itsthejoker/filamentcolors.xyz#public-api).
Small normalized results and their bounded search terms may be cached under
`DATA_DIR`; no upstream images or purchase links are stored. The catalog is
optional and can be slow, unavailable, or change independently. Manual names
and six-digit hex colours remain fully usable in every case. See
[NOTICE.md](../NOTICE.md) for attribution and license details.

## Camera settings

| Setting | Type and default | Sensitivity | Example | Notes |
|---|---|---|---|---|
| `cameraRtspUrl` | empty or RTSP(S) URL, empty | Private; secret if credential-bearing | `""` | Passed only to FFmpeg. Buddy3D uses `rtsp://<camera-ip>/live` with no authentication; keep it on a trusted LAN. For other cameras, use a dedicated low-privilege account when available. |
| `cameraStreamEnabled` | boolean, automatic | Non-secret | `false` | A non-empty URL enables the relay when omitted; `false` disables it. |
| `cameraFfmpegPath` | non-empty string, `"ffmpeg"` | A custom path may identify a machine | `"ffmpeg"` | Executable name or absolute path. |
| `cameraStreamFps` | integer 1–30, `24` | Non-secret | `24` | Output MJPEG frame rate. |
| `cameraStreamWidth` | integer 320–3840, `1920` | Non-secret | `1920` | Output width; aspect ratio is retained. |
| `cameraStreamJpegQuality` | integer 2–31, `5` | Non-secret | `5` | FFmpeg JPEG quality scale; lower is higher quality. |
| `cameraStreamThreads` | integer 1–16, `4` | Non-secret | `4` | Shared decoder/filter/encoder thread cap. |
| `cameraStreamKillGraceMs` | integer 500–10000, `3000` | Non-secret | `3000` | Grace before a stuck FFmpeg child is force-stopped. |
| `cameraStreamIdleMs` | integer 1000–300000, `10000` | Non-secret | `10000` | Delay before stopping an unused upstream reader. |
| `cameraStreamStallMs` | integer 5000–120000, `20000` | Non-secret | `20000` | No-frame watchdog threshold. |
| `cameraStreamIoTimeoutMs` | integer 3000–120000, `15000` | Non-secret | `15000` | RTSP socket I/O timeout. |
| `cameraStreamRestartBaseMs` | integer 250–30000, `1000` | Non-secret | `1000` | Initial retry backoff. |
| `cameraStreamRestartMaxMs` | integer 1000–120000, `15000` | Non-secret | `15000` | Maximum retry backoff. |
| `cameraStreamMaxFrameBytes` | integer 1048576–67108864, `16777216` | Non-secret | `16777216` | Safety cap for one JPEG frame. |

## Cloud integrations

Prusa Connect is the recommended telemetry source for CORE One/INDX because
PrusaLink does not expose the exact active tool or all of the live fields used by
the dashboard. It needs `connectPrinterUuid` and `connectRefreshToken`; without
both, the service stays on its PrusaLink fallback. Netatmo needs all three
`netatmoClientId`, `netatmoClientSecret`, and `netatmoRefreshToken` values.
Refresh tokens are sensitive and rotate into `DATA_DIR`. Keep that directory
private and persistent.

| Setting | Type and default | Sensitivity | Example | Notes |
|---|---|---|---|---|
| `useConnect` | boolean, `true` (credential-gated) | Non-secret | `true` | Complete credentials enable Connect by default. Set `false` only for an intentional PrusaLink-only deployment. |
| `connectPrinterUuid` | string, empty | Identifying | `""` | Printer identifier; remove it from public logs. |
| `connectClientId` | string, built-in public browser client ID | Non-secret | `""` | Empty keeps the built-in ID; override only when intentionally managing the experimental integration. |
| `connectRefreshToken` | string, empty | Secret | `""` | Sensitive rotating web-client OAuth token; it is not a project-issued read-only or least-privilege credential. |
| `connectPollMs` | integer at least 5000, `5000` | Non-secret | `5000` | Serialized cloud polling cadence in milliseconds; lower values are rejected. |
| `useNetatmo` | boolean, automatic | Non-secret | `false` | Complete credentials enable Netatmo unless this is `false`. |
| `netatmoClientId` | string, empty | Sensitive credential metadata | `""` | OAuth application identifier. |
| `netatmoClientSecret` | string, empty | Secret | `""` | OAuth application secret. |
| `netatmoRefreshToken` | string, empty | Secret | `""` | Sensitive rotating OAuth refresh token. |
| `netatmoPollMs` | integer at least 60000, `300000` | Non-secret | `300000` | Station polling cadence in milliseconds. |

Prusa Connect remains experimental: it uses the web client and undocumented
endpoints, so it can break when Prusa changes the site. Follow the
[Prusa Connect setup guide](prusa-connect.md) to capture a dedicated refresh
token, configure the printer UUID, understand token rotation, and recover without
running two clients against the same token chain.

## Storage and safety limits

| Setting | Type and default | Sensitivity | Example | Purpose |
|---|---|---|---|---|
| `analysisCacheMaxEntries` | integer 1–1000, `100` | Non-secret | `100` | Maximum retained job analyses. |
| `analysisCacheMaxBytes` | integer 1048576–1073741824, `67108864` | Non-secret | `67108864` | Analysis cache size cap. |
| `lastStateWriteMs` | integer at least 5000, `10000` | Non-secret | `10000` | Last-known state persistence cadence. |
| `maxPrinterJsonBytes` | integer at least 1024, `1048576` | Non-secret | `1048576` | Maximum JSON telemetry response size. |
| `maxPrinterResponseBytes` | integer at least 1024, `536870912` | Non-secret | `536870912` | Maximum binary printer response, including `.bgcode`. |

## Editor metadata

| Setting | Type and default | Sensitivity | Example | Notes |
|---|---|---|---|---|
| `$schema` | string, no runtime default | Non-secret | `"./config.schema.json"` | Editor metadata used for completion and validation. |

## Network boundary

The dashboard endpoints can expose printer state, job history, room telemetry,
and live camera images. Keep native installs on `127.0.0.1`. Compose listens on
all interfaces inside the container but publishes only to host `127.0.0.1` by
default.

For deliberate remote access, use a firewall or authenticated TLS reverse proxy.
Do not assume that binding the service to a LAN address makes its camera endpoint
private.
