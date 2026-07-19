# 3d-livestream camera dashboard and overlay

A self-hosted OBS browser dashboard for Prusa printers. It combines a printer
camera feed, local PrusaLink telemetry, optional Prusa Connect telemetry,
decoded `.bgcode` timelines, and optional Netatmo room temperature. The same
page can run as a full 1080p dashboard or a transparent lower-third overlay.

The project is developed against a **Prusa CORE One with an INDX toolchanger**.
Basic telemetry should be useful with other PrusaLink printers, but their state,
camera, and G-code behavior still needs community testing.

The service is display-only: it reads printer APIs with `GET` requests and has no
pause, stop, movement, temperature, or upload controls.

## What it shows

- The printer camera, relayed from RTSP through one shared local MJPEG fanout
- Print name and thumbnail, lifecycle state, progress, remaining time, and finish clock
- Nozzle, bed, chamber, and room temperatures
- Active tool, configured spool name/colour, and the next tool change
- Layer, speed, flow, hotend fan, tool-swap count, purge waste, and filament estimate
- Tool-change ticks on the progress bar, decoded from the active `.bgcode`
- A persistent operator banner and a short auto-host announcement feed
- Last-known values during a printer or cloud outage, visibly marked as stale/offline
- A persisted finished-job summary that survives an OBS browser refresh
- Non-print printer activity instead of a false READY/PRINTING state while the
  machine is calibrating, self-testing, homing, handling filament, or servicing itself

## Quick start

Requirements: [Bun](https://bun.com/docs/installation) 1.3.14 or newer in the
1.x line and a reachable PrusaLink endpoint. FFmpeg is required only when the
integrated RTSP camera relay is enabled.

Clone the repository and enter its directory first:

```sh
git clone https://github.com/GoByeBye/3d-livestream.git
cd 3d-livestream
```

Use the same setup flow on Windows, macOS, and Linux:

```sh
bun ci
bun run setup
bun run doctor
bun run start
```

Setup creates the ignored `config.json` without overwriting an existing one and
generates a random write API token. In an interactive terminal it asks for the
PrusaLink host, username, password, optional RTSP URL, and tool count.

Open <http://localhost:8787/> after startup. For a container install, use the
[Docker guide](docs/docker.md); Compose publishes the service on host loopback
by default.

## Configuration

`config.example.json` is the safe starting point, and `config.schema.json`
documents the complete configuration shape for editors and validation. At
minimum, set `printerHost`, `username`, and `password`.

The main settings are:

| Setting | Purpose |
|---|---|
| `listenHost` / `port` | Local HTTP listener. Keep `127.0.0.1` unless another machine must read the overlay. |
| `pollIntervalMs` | Local PrusaLink cadence. `2000` is the safe default for the printer's Buddy board. |
| `sourceCodeUrl` | Corresponding-source URL offered in the dashboard and HTTP `Link` header. Modified deployments must point it at their exact source. |
| `overlayHost` | Announcement-host identity: fallback avatar text, display name, badge, conditional `modeBadge`, and an optional same-origin custom icon. |
| `toolCount` / `toolSlots` | Number of INDX docks and the currently loaded spool name/colour per 1-based slot. |
| `localBgcodeDirs` | Folders searched for a matching `.bgcode` before downloading it from the printer. |
| `printNameOverrides` | Optional exact `jobKey` to display-name map for slicer files that expose only placeholders such as `Merged`. |
| `connect*` | Optional Prusa Connect UUID, refresh token, and poll cadence. |
| `netatmo*` | Optional station credentials and room-temperature poll cadence. |
| `cameraRtspUrl` | Server-side RTSP source for the shared camera relay and snapshot helper. It is never sent to the browser. |
| `cameraStreamEnabled` | Enables the relay. When omitted, a configured `cameraRtspUrl` enables it automatically; set `false` to disable it. |
| `cameraFfmpegPath` | FFmpeg executable name or path. Defaults to `ffmpeg` on `PATH`. |
| `cameraStreamFps` / `cameraStreamWidth` / `cameraStreamJpegQuality` | MJPEG frame rate, output width, and encoder quality. Defaults are `24`, `1920`, and `5`. |
| `cameraStreamThreads` | Decoder/filter/encoder thread cap. Defaults to `4`, avoiding FFmpeg's large auto-thread buffer footprint while sustaining 1080p24. |
| `cameraStreamKillGraceMs` | Grace period before a stuck FFmpeg worker is force-stopped. Defaults to `3000` ms. |
| `cameraStreamIdleMs` / `cameraStreamStallMs` | Delay before an unused relay stops and the no-frame watchdog restarts it. Defaults are `10000` and `20000` ms. |
| `analysisCacheMaxEntries` / `analysisCacheMaxBytes` | Retention limits for per-print analysis JSON. Defaults are 100 jobs and 64 MiB; camera frames are never stored there. |
| `automationLeaseMs` | Lifetime of the fail-closed `AUTO MODE` heartbeat. Defaults to 45 seconds and is not restored after restart. |
| `apiToken` | Bearer token for write endpoints. When configured, it is required for local and remote writes; setup generates one automatically. |

Do not commit `config.json` or `cache/`: they contain credentials, rotating cloud
tokens, and live state. Both paths are gitignored and excluded from Docker builds.
Custom runtime locations and container environment overrides are documented in
[docs/configuration.md](docs/configuration.md).

## OBS setup

For a new integrated dashboard, add one **Browser** source with URL
`http://localhost:8787/`, Width **1920**, and Height **1080**. Enable **Refresh
browser when scene becomes active**. The server opens one upstream RTSP reader
and fans its MJPEG output out to every connected browser, so OBS refreshes or
multiple local previews do not create extra camera sessions.

### Migrating an active scene safely

If OBS already has a Media Source reading the RTSP URL directly, use this order:

1. Leave the existing Browser Source at **1920 × 420** while checking that its
   telemetry still works.
2. **Disable the old RTSP Media Source.** Do this before changing the Browser
   Source size.
3. Set the Browser Source URL to `http://localhost:8787/` and resize it to
   **1920 × 1080**.
4. Confirm that the integrated camera is live, then remove the disabled Media
   Source when convenient.

That order is important: resizing the Browser Source enables its integrated
camera, so disabling the old Media Source first ensures the camera never has two
upstream RTSP readers.

An existing **1920 × 420** Browser Source automatically remains the transparent,
camera-free lower third. `/overlay` and `/?camera=0` explicitly select that mode;
`/?camera=1` forces the camera on regardless of viewport height. The normal card
remains exactly 250 px tall and is anchored to the bottom. The measured worst
case—message and auto-host feed together—is about 409 px tall, so a 420 px source
keeps both rows visible without moving the lower stats or clipping them. A 250 px
source is sufficient only when those optional rows are unused.

Room temperature is hidden initially and is toggled independently in each
Browser Source through the dashboard controls. That preference is stored in the
browser profile. Use `?room=1` or `?room=0` to force it shown or hidden for a
specific source.

Optional query parameters:

- `?camera=1` forces the integrated camera; `?camera=0` forces transparent overlay mode.
- `?room=1` or `?room=0` overrides the per-browser room-temperature preference.
- `?controls=0` hides the auto-fading dashboard controls; `?controls=1` forces them on.
- `?bed=true` replaces the title with the overnight away message while keeping telemetry live.
- `?bed=true&bedmsg=...` supplies a custom away message.

### Calibration and maintenance activity

Prusa firmware reports built-in calibration, self-test, preheat, cold-pull,
filament, and maintenance workflows through one coarse `BUSY` state. The overlay
therefore always detects that a non-print operation is active and shows a dedicated
activity card instead of `READY`. It uses a specific label only when an upstream
state, title, or operation field names the task; otherwise it honestly says
`Printer busy`. It never guesses a calibration type from temperatures or movement.

## How the tool and layer timeline works

PrusaLink does not expose the INDX active tool or swap count as an MMU. For each
new job, the server obtains the `.bgcode` from the first applicable source:

1. A matching analysis in `cache/`
2. A matching file in `localBgcodeDirs`
3. An authenticated Prusa Connect download or a printer download, depending on
   which matching remote descriptor is available for that job

`bgcode.js` decodes the container in pure JavaScript (Heatshrink + MeatPack), and
`toolswaps.js` builds progress-to-tool, swap, layer, remaining-time, and purge
timelines. Results are cached by job and decoder version. Local copies are best
for the Buddy board because a printer download can be slow during a busy print.

G-code tools are 0-based (`T0`-`T7`); the API keeps `currentTool` 0-based while
`toolLabel` and configured `toolSlots` use the printer UI's 1-based labels.

Purge waste is the extrusion inside PrusaSlicer's `FLUSH` and `EXCLUDE_E` blocks,
converted to grams using the file's filament diameter and density. The live
filament readout is explicitly marked as an estimate because print progress is
not an extrusion timeline.

## Runtime and API

| File | Role |
|---|---|
| `server.js` | Poll orchestration, state merging, persistence, HTTP API, and static files |
| `camera-stream.js` | One-upstream RTSP-to-MJPEG relay, client fanout, and FFmpeg lifecycle |
| `digest.js` | PrusaLink HTTP Digest client |
| `prusaconnect.js` | Optional Prusa Connect OAuth and telemetry mapping |
| `netatmo.js` | Optional Netatmo OAuth and station mapping |
| `bgcode.js` | `.bgcode` container and G-code decoder |
| `toolswaps.js` | Tool/swap/layer/waste timeline builder |
| `public/overlay.html` | Self-contained overlay UI with no third-party requests |
| `tools/` | Safe restart, snapshot, message, announcement, and stream helpers |

Read endpoints:

- `GET /healthz` — process liveness only; printer and camera outages do not fail it
- `GET /source` — redirects to the configured corresponding source for the running deployment
- `GET /api/state` — merged live state, connectivity, tool inventory, configurable `overlayHost`, optional feed/message, and completed job
- `GET /api/camera.mjpeg` — long-lived shared MJPEG printer-camera stream
- `GET /api/camera.jpg` — latest complete camera frame as a single JPEG
- `GET /api/camera/status` — camera relay state, viewer count, frame age, configured/measured FPS, JPEG byte rate, restart timing, and credential-safe errors
- `GET /api/automation/status` — current fail-closed automation lease state
- `POST`/`DELETE /api/automation/heartbeat` — refresh or clear the `AUTO MODE` lease; intentional writes include `X-Automation-Heartbeat: 1`
- `GET /api/jobmap` — swap tick percentages for the active analyzed job
- `GET /api/thumbnail?j=<jobKey>` — thumbnail guarded against cross-job reuse
- `GET /api/message` and `GET /api/announce` — current operator content

Control writes are `POST`/`DELETE /api/message`, `POST`/`DELETE /api/announce`,
and the automation heartbeat. When `apiToken` is configured, they require
`Authorization: Bearer <apiToken>`. Without a token, writes require a loopback
socket and loopback Host; browser requests must additionally be same-origin.
Docker and reverse-proxy deployments should always configure a token; setup does
this automatically.
Operator tools read `OVERLAY_API_TOKEN` when set.

Keep `listenHost` at `127.0.0.1` for a local OBS setup. Binding to a LAN address
makes the dashboard and read APIs—including the live camera relay—reachable by
other hosts; `apiToken` protects write endpoints, not these reads. Restrict the
port with the host firewall or an authenticated reverse proxy. The RTSP URL
remains server-side, but the relayed images are still sensitive.

## Resilience

- Poll loops self-schedule and back off instead of stacking intervals.
- Local telemetry remains authoritative when Prusa Connect is unavailable.
- Last state, completed job, analysis, messages, announcements, and rotating OAuth
  tokens are written atomically and can recover from a backup.
- A disconnected overlay keeps the last-known frame visible and freezes countdowns.
- Analysis and thumbnail failures back off; a late analysis from an old job is not
  allowed to replace the current job.
- Camera viewers share one FFmpeg/RTSP upstream. The relay starts on demand, drops
  frames for slow clients instead of buffering without bound, and retries a lost
  camera connection with backoff.
- Camera JPEGs remain in RAM only: FFmpeg writes to stdout, the relay keeps one latest
  frame, browsers receive `no-store`, and no recording or frame cache is created.
- `AUTO MODE` is shown only while `/api/automation/heartbeat` is being refreshed. It
  cannot be activated by configuration, printer state, or persisted announcements.
- Per-print analysis JSON is pruned by count and total size.
- `tools/restart-overlay.ps1` preflights the Bun checks, tests, and isolated smoke
  test before stopping only the server on the configured port. It then waits for
  the port to clear, starts one hidden process, and verifies `/api/state`.

## Operations

```powershell
pwsh tools/restart-overlay.ps1
bun tools/snapshot.mjs C:\tmp\printer.jpg
bun tools/overlay-message.mjs set "Back shortly"
bun tools/overlay-message.mjs clear
bun tools/announce.mjs add "Layer 120 is down and the surface looks clean."
bun tools/announce.mjs add --auto "I am actively watching the next tool change."
bun tools/announce.mjs auto-pulse
bun tools/announce.mjs auto-status
bun tools/announce.mjs auto-stop
bun tools/announce.mjs list
bun tools/announce.mjs clear
```

The restart helper is Windows-specific; container users should run
`docker compose restart overlay`. Set `OVERLAY_URL` when the server is not at
`http://127.0.0.1:8787`, and `OVERLAY_API_TOKEN` when `apiToken` is configured.
See `tools/README.md` for snapshot, VOD-frame, and platform notes.

The optional `.agents/skills/` files are intentionally public, credential-free
Codex command wrappers for the safe restart and camera-snapshot workflows. They
delegate to the documented tools and are excluded from Docker builds.

## Verification

```sh
bun run check
bun test
bun run smoke
bun run doctor -- --require-running
```

The test suite covers camera fanout/backpressure/recovery, dashboard mode and room
preferences, material metadata, tool/layer/purge timeline mapping, persistence,
request deadlines, telemetry freshness, and Prusa Connect's telemetry and
authenticated asset boundaries.

## Contributing, security, and release status

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes and
[SECURITY.md](SECURITY.md) for private vulnerability reports. The
[public release checklist](docs/release-checklist.md) covers clean-clone,
secret-scan, provenance, CI, and repository-setting gates. Release highlights,
upgrade steps, and known limitations are in the
[v0.1.0 release notes](docs/release-notes-v0.1.0.md).

The repository is licensed under the
[GNU Affero General Public License v3 or later](LICENSE). `bgcode.js` includes a
JavaScript port of [Prusa's libbgcode](https://github.com/prusa3d/libbgcode);
[NOTICE.md](NOTICE.md) records the pinned provenance, dated modifications, and
the full MeatPack and heatshrink notices. It also contains the project's
[AI-assisted development disclosure](NOTICE.md#ai-assisted-development).

Remote users can open **Source & AGPL license** from the dashboard controls or
visit `GET /source`. Operators who deploy a modified build must set
`sourceCodeUrl` or `SOURCE_CODE_URL` to the corresponding source for that exact
version; Docker deployments use `SOURCE_CODE_URL`, which takes precedence over
the mounted JSON configuration. Package-registry publication remains disabled
with `private: true`; supported installation paths are a Git checkout or Docker.
