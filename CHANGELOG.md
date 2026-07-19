# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

## [0.1.0] - 2026-07-19

### Added

- Docker and Docker Compose packaging with a non-root, read-only runtime
- Cross-platform setup, diagnostics, syntax checks, and camera snapshot tooling
- Portable configuration and data paths with environment overrides
- Process health endpoint, public repository CI, issue forms, security policy,
  contribution guide, release checklist, configuration reference, and troubleshooting
- Write-authentication hardening for local and container deployments
- GNU AGPL v3-or-later licensing, pinned decoder provenance, and an in-app corresponding-source offer
- Authenticated Prusa Connect preview and `.bgcode` retrieval for matching active jobs
- An explicit AI-assisted development disclosure and contribution policy
- A CI gate that installs and verifies the exact tracked source archive

### Changed

- Runtime, package management, tests, CI, and containers now use Bun 1.3.14
- Default sample presentation and assets are neutral and offline-first
- Runtime state can be stored outside the source checkout
- Telemetry connectivity now expires from sample freshness instead of remaining
  online after a stalled request
- HTTP and HTTPS requests use independent wall-clock deadlines so a silent
  transport cannot permanently stall polling
- Prusa Connect asset work is serialized by active job, cancels stale downloads,
  retries incomplete descriptors, and rejects invalid `.bgcode` payloads

### Removed

- Optional YouTube control helpers that depended on code without independently
  verifiable publication provenance; credential-free VOD frame capture remains
- The legacy browser diagnostic endpoint and rotating debug log

### Security

- Docker build context excludes local credentials, state, custom assets, and scratch pages
- Configured API tokens are now required for all control writes, including loopback requests
- Tokenless native writes validate socket, Host, Origin, and fetch metadata
- Cloud asset downloads are restricted to authenticated same-origin Prusa Connect paths

[Unreleased]: https://github.com/GoByeBye/3d-livestream/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/GoByeBye/3d-livestream/releases/tag/v0.1.0
