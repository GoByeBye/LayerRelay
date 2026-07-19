# 3d-livestream v0.1.0

This is the first supported public source release of the self-hosted Prusa
camera dashboard and OBS overlay. Installation is supported from a Git checkout
or a locally built Docker Compose deployment; package-registry and container
registry publication remain disabled.

## Highlights

- One dashboard serves a full 1080p camera view or a transparent lower third.
- Local PrusaLink telemetry is combined with optional Prusa Connect and Netatmo
  data while keeping printer communication read-only.
- `.bgcode` analysis provides tool, swap, layer, purge, and remaining-time
  timelines from a local file, Prusa Connect, or the printer.
- Bun 1.3.14 powers the runtime, dependency installation, tests, setup,
  diagnostics, CI, and container image.
- The supplied Compose deployment defaults to a loopback-only published port,
  an unprivileged process, a read-only root filesystem, and an explicit
  corresponding-source offer.
- The repository includes AGPL licensing, third-party provenance, an
  AI-assisted development disclosure, security guidance, and contribution rules.

## Breaking changes from pre-release development

- Node.js and npm are no longer supported. Remove `node_modules`, install Bun
  1.3.14, and run `bun ci`.
- Platform-specific setup wrappers were replaced by the cross-platform
  `bun run setup` command.
- The legacy `?diag=1` browser mode, `/api/debug` endpoint, and rotating debug
  log were removed. `debugMaxBytes` is accepted only as an ignored legacy setting.

## Upgrade

1. Stop the existing overlay process so two printer pollers cannot overlap.
2. Update the checkout to the `v0.1.0` tag.
3. Remove the old dependency directory and run `bun ci`.
4. Run `bun run doctor`, then start with `bun run start` or rebuild the Docker image.
5. On Windows, `pwsh tools/restart-overlay.ps1` performs the checks and guarded
   single-process restart after Bun dependencies are installed.

Existing `config.json` files remain compatible. The deprecated `debugMaxBytes`
key may be removed at any time because it no longer has an effect.

## Security-relevant changes

- Control writes require the configured bearer token. Without one, writes
  require a loopback socket and loopback Host; browser requests must additionally
  be same-origin.
- Printer and cloud responses have size limits and wall-clock deadlines.
- Prusa Connect asset URLs are restricted to authenticated same-origin API paths.
- Cloud preview and `.bgcode` work follows the active job, cancels stale work,
  retries incomplete asset descriptors, and rejects non-G-code payloads.
- Runtime configuration, tokens, cached state, camera frames, and custom assets
  are excluded from Git and the Docker build context.
- CI scans full Git history for secrets and verifies the tracked source archive
  before exercising the hardened container.

## Known limitations

- Primary hardware coverage is a Prusa CORE One with an INDX toolchanger. Other
  PrusaLink printers need community testing.
- Prusa Connect support uses undocumented browser endpoints and requires an
  already-managed compatible refresh token; no OAuth bootstrap is included.
- The integrated camera relay requires FFmpeg and exposes sensitive imagery to
  every client that can reach the read API.
- Public internet exposure is not a supported default. Use an authenticated
  reverse proxy and host firewall if the loopback-only binding is changed.
- Package registries are not a supported installation channel.

Before tagging or publishing, complete [the public release checklist](release-checklist.md)
and require every CI job to pass on the exact release commit.
