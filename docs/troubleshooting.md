# Troubleshooting

For a native install, start with `bun run doctor`. Add
`-- --require-running` when the service is expected to be up, or
`-- --url http://host:port` to check another address. For Docker, run the doctor
inside the container so it checks the bundled FFmpeg and staged configuration:

```sh
docker compose exec --user bun:bun overlay bun run doctor -- --require-running
```

## Configuration errors

- **No configuration found:** run `bun run setup` or copy
  `config.example.json` to the path named by `CONFIG_PATH`.
- **Placeholder password:** replace the example value; the server refuses to
  start with it so it cannot silently poll with known-bad credentials.
- **Invalid JSON:** use a JSON-aware editor with `config.schema.json`. JSON does
  not allow comments or trailing commas.
- **Existing config was not changed:** intentional—setup never overwrites
  credentials. Edit or remove the file yourself if you want to recreate it.

## Printer is offline

Check that `printerHost` is a hostname/IP without a URL scheme and that the host
running Bun or Docker can reach it. The authoritative runtime fields are
`online` and `staleSec` from `/api/state`; `updatedAt` is the response time, not
proof of a fresh printer read.

Avoid running two overlay instances for the same printer. Each instance polls
PrusaLink independently and may create an additional RTSP reader.

## Camera is unavailable

Run the native or container doctor above to verify the relevant FFmpeg install
when the relay is enabled, then inspect `/api/camera/status`. Prefer an IP
address over an mDNS `.local` name in Docker Desktop. The relay uses RTSP over
TCP and starts only when a viewer subscribes.

RTSP URLs can be visible in local process arguments. Use a dedicated read-only
camera account and avoid shared hosts where other users can inspect processes.

## Write tools return HTTP 401

When `apiToken` is set, export the same value as `OVERLAY_API_TOKEN` before using
`tools/announce.mjs` or `tools/overlay-message.mjs`. Also set `OVERLAY_URL` when
the server is not at `http://127.0.0.1:8787`. Set both variables when Compose's
`OVERLAY_PORT` changes; an explicit destination never inherits a token from a
local config file.

Docker requests cross a network bridge, so tokenless loopback convenience does
not apply even when the published host URL says `localhost`.

## Port is already in use

Stop the other process or choose another `port`. On Windows,
`tools/restart-overlay.ps1` identifies the listener and refuses to stop a process
that is not this overlay. Container users can change `OVERLAY_PORT` without
changing the internal port.

## Docker does not start

- Create `config.json` first; Compose deliberately refuses to create a missing
  bind-mount source.
- Keep it owner-only (`chmod 600 config.json`) on macOS/Linux. The container
  bootstrap securely stages it without requiring host UID 1000 or an ACL.
- Confirm Docker Desktop is using Linux containers on Windows.
- Run `docker compose config` to validate local overrides.
- Inspect `docker compose logs overlay` and `docker compose ps`.
- Do not remove the `overlay-data` volume unless losing cached state and rotated
  cloud refresh tokens is intentional.

See [docs/docker.md](docker.md) for networking, mounts, and remote-access details.
