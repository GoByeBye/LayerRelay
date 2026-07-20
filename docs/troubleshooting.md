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

RTSP URLs can be visible in local process arguments. Buddy3D's documented local
feed is `rtsp://<camera-ip>/live`: it has no credentials to hide, but it is
unencrypted and unauthenticated, so keep the camera and relay on a trusted LAN.
For cameras that do support authentication, use a dedicated low-privilege account
and avoid shared hosts where other users can inspect processes.

## Prusa Connect is unavailable

Run `bun run doctor` and confirm that both `connectPrinterUuid` and
`connectRefreshToken` are configured. The service keeps working from PrusaLink
when Connect is unavailable, but exact INDX active-tool and richer live telemetry
can be missing. See the [Prusa Connect setup and recovery guide](prusa-connect.md).

Do not test one rotating refresh token in multiple browsers or overlay instances.
If the token has become invalid, stop the overlay before replacing the seed and
renaming the persisted `DATA_DIR/connect-token.json`; otherwise the persisted
rotated token continues to take precedence over `config.json`.

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
