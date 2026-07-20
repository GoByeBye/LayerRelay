# Maintenance tools

LayerRelay keeps only the maintenance helpers needed for the overlay itself:
camera snapshots, guarded restarts, and the Prusa Connect credential handoff.

## Commands

| Command | Purpose |
|---|---|
| `bun tools/snapshot.mjs <out.jpg> [rtspUrl]` | Capture one full-resolution printer-camera frame. When the URL is omitted, the helper reads `cameraRtspUrl` from the private configuration. |
| `pwsh -NoProfile -File tools/restart-overlay.ps1` | Run checks, tests, and the isolated smoke test; then safely replace only the recognized overlay process and verify `/api/state`. |

The snapshot helper requires Bun and FFmpeg. The restart helper requires
PowerShell 7 and Bun. Both use the ignored `config.json` by default; select an
external configuration with `CONFIG_PATH` or `LAYER_RELAY_CONFIG`.

## Prusa Connect credential handoff

[`copy-connect-token.js`](copy-connect-token.js) is a browser-console helper for
the manual OAuth handoff documented in the
[Prusa Connect setup guide](../docs/prusa-connect.md). Review the complete helper,
then paste it into the developer console while signed in at
`https://connect.prusa3d.com/`. It reads the refresh token from that exact
origin's Local Storage and prints it once without transmitting the value. The
console output is the credential; copy it, then clear the console and clipboard.

This is not a Bun command. Do not run it in a normal terminal, share its displayed
value, or reuse the resulting rotating token chain in multiple clients.
