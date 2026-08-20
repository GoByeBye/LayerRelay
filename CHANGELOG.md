# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Docker and Docker Compose packaging with a non-root, read-only runtime
- Cross-platform setup, diagnostics, syntax checks, and camera snapshot tooling
- Portable configuration and data paths with environment overrides
- Process health endpoint, public repository CI, issue forms, security policy,
  contribution guide, configuration reference, and troubleshooting
- GNU AGPL v3-or-later licensing, pinned decoder provenance, and an in-app corresponding-source offer
- Authenticated Prusa Connect preview and `.bgcode` retrieval for matching active jobs
- An origin-locked browser-console helper that displays the dedicated Prusa
  Connect refresh token once without transmitting it
- An original README banner with its AI-generation prompt, processing, checksum,
  and license provenance recorded in the source tree
- An explicit AI-assisted development disclosure and contribution policy
- A CI gate that installs and verifies the exact tracked source archive
- A dashboard tool-and-filament editor with Prusa Connect-derived automatic
  inventory, independent count/presence/name/colour overrides, Auto reset for
  count/presence/type/colour, persistent settings, and local type-ahead over a
  normalized OpenPrintTag suggestion index loaded by `openprinttag-index.js`
- A static GitHub Pages build of the dashboard with demo, local-file analysis,
  live-bridge, and serverless Prusa Connect cloud modes, deployed from
  `dist/pages` by a dedicated Pages workflow and documented in
  `docs/static-hosting.md`
- An in-browser ESM port of the `.bgcode` container decoder, timeline
  analysis, thumbnail extraction with QOI support, and filament suggestions
  under `pages/app/`
- A serverless cloud mode for the static build that refreshes a Prusa account
  token in the browser and subscribes to the printer's retained Prusa Connect
  MQTT topics over a WebSocket, with no LayerRelay server and no project backend
  anywhere in the path
- A dependency-free MQTT 3.1.1 client, rotation-safe token handling with a
  cross-tab refresh lock, and a topic-to-state mapper under `pages/app/`
- Documentation of which cloud-mode fields arrive live over MQTT, which need a
  `.bgcode` dropped onto the page, why there is no camera in that mode, and how
  to recover a refresh-token chain broken by a second consumer
- A deterministic `.bgcode` builder that generates the published demo print
  and binary test fixtures at build and test time
- An `apiReadAllowedOrigins` allowlist that grants listed browser origins
  cross-origin read access to the `/api` endpoints
- Live camera video in cloud mode over Prusa Connect's WebRTC path, negotiated
  directly from the browser with no server, using a camera token pasted into
  the panel. Enabling WebRTC on a camera turns its RTSP server off, so the page
  only ever consumes an already-streaming camera and never changes the setting

### Changed

- Runtime, package management, tests, CI, and containers now use Bun 1.3.14
- The overlay surface is focused on printer, camera, job, tool, and room telemetry
- Runtime state can be stored outside the source checkout
- Telemetry connectivity now expires from sample freshness instead of remaining
  online after a stalled request
- HTTP and HTTPS requests use independent wall-clock deadlines so a silent
  transport cannot permanently stall polling
- Prusa Connect asset work is serialized by active job, cancels stale downloads,
  retries incomplete descriptors, and rejects invalid `.bgcode` payloads
- Startup loads the last valid OpenPrintTag snapshot, refreshes missing or stale
  data in the background, and serves synchronous local searches without
  persisting picker queries
- Local filament type-ahead uses a 100 ms input debounce for near-realtime
  suggestions

### Removed

- Non-core integrations, presentation controls, and media helpers
- Obsolete diagnostics and compatibility settings

### Security

- Docker build context excludes local credentials, state, and scratch pages
- Cloud asset downloads are restricted to authenticated same-origin Prusa Connect paths
- Browser configuration writes are limited to the non-secret tool inventory,
  use same-origin JSON requests, and never expose or rewrite operator credentials
- Cross-origin `/api` reads and the image-route `Cross-Origin-Resource-Policy`
  relaxation stay disabled until `apiReadAllowedOrigins` is configured
- The static build's cloud mode keeps the visitor's own Prusa refresh token in
  their browser, sends it only to `account.prusa3d.com`, accepts it from the
  control panel rather than a query parameter, never renders it back, and never
  stores, logs, or displays the account email or name

[Unreleased]: https://github.com/GoByeBye/LayerRelay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/GoByeBye/LayerRelay/releases/tag/v0.1.0
