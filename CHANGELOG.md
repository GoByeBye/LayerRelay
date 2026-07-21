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
  count/presence/type, persistent settings, and optional FilamentColors.xyz
  type-ahead suggestions

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

### Removed

- Non-core integrations, presentation controls, and media helpers
- Obsolete diagnostics and compatibility settings

### Security

- Docker build context excludes local credentials, state, and scratch pages
- Cloud asset downloads are restricted to authenticated same-origin Prusa Connect paths
- Browser configuration writes are limited to the non-secret tool inventory,
  use same-origin JSON requests, and never expose or rewrite operator credentials

[Unreleased]: https://github.com/GoByeBye/LayerRelay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/GoByeBye/LayerRelay/releases/tag/v0.1.0
