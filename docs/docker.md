# Docker setup

The container runs the overlay as an unprivileged Bun process and includes
FFmpeg for the RTSP camera relay. Configuration is mounted read-only and runtime
state is kept in a named Docker volume.

## Requirements

- Docker Engine on Linux, or Docker Desktop on Windows/macOS
- Docker Compose v2 (`docker compose`)
- Network access from Docker to the printer and camera

## Quick start

Start from a cloned checkout:

```sh
git clone https://github.com/GoByeBye/LayerRelay.git
cd LayerRelay
```

First create the private configuration file. It is ignored by both Git and the
Docker build context. If Bun is already available, `bun run setup` creates it
interactively. For a Docker-only host, copy the template and edit it manually.

Windows PowerShell:

```powershell
Copy-Item config.example.json config.json
```

macOS or Linux:

```sh
cp config.example.json config.json
chmod 600 config.json
```

Edit `config.json` and set at least `printerHost`, `username`, and `password`.
Set `cameraRtspUrl` and set `cameraStreamEnabled` to `true` if the integrated
camera relay should be enabled. Alternatively, remove `cameraStreamEnabled`
from the copied template so a non-empty camera URL enables it automatically.
For complete CORE One/INDX telemetry, also follow the
[Prusa Connect guide](prusa-connect.md) and set `connectPrinterUuid` and
`connectRefreshToken`; the example already leaves the credential-gated
integration enabled.

Compose sets the container's listener to `0.0.0.0:8787`; the listener values in
the JSON file remain useful for native, non-container runs.

Build and start one overlay instance:

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f overlay
```

Open <http://localhost:8787/> or use that URL for the OBS Browser Source. The
published port is bound to host loopback by default, so it is not reachable from
other machines.

The dashboard exposes a **Source & AGPL license** link. Unmodified deployments
default to this repository. A modified deployment must set `SOURCE_CODE_URL` to
the corresponding source for the exact running revision before starting Compose.
Set `VCS_REF` to that revision as well so the image's OCI metadata and runtime
source offer identify the same code. Compose passes both values into the build;
they can be stored in the local ignored `.env` file.

## Multiple printers or checkouts

Compose derives its project name from the checkout directory. When two stacks
could have the same directory name, assign each a unique project name so their
containers, networks, and persistent token/cache volumes cannot collide:

```sh
docker compose -p printer-a up -d --build
docker compose -p printer-b up -d --build
```

Use the same `-p` value for later `logs`, `restart`, `down`, and upgrade commands.
Never scale one project above one overlay replica; each replica would poll the
same printer and open its own upstream camera reader.

## Ports and remote access

Change the host-side port without changing the container configuration:

```sh
OVERLAY_PORT=9876 docker compose up -d
```

In PowerShell, set the variable before running Compose:

```powershell
$env:OVERLAY_PORT = '9876'
docker compose up -d
```

To deliberately accept connections from the LAN, put these values in a local
`.env` file next to `compose.yaml`:

```dotenv
BIND_ADDRESS=0.0.0.0
OVERLAY_PORT=8787
```

When publishing beyond loopback, restrict the port with the host firewall or an
authenticated reverse proxy. The dashboard includes printer state and can expose
the relayed camera image.

## Configuration and persistent state

Compose mounts `./config.json` at `/config/config.json` read-only. It refuses to
create a missing host path, so a forgotten setup step fails clearly instead of
creating a directory named `config.json`.

Inside the supplied image, `CONFIG_PATH` is the fixed staged copy at
`/tmp/layer-relay/config.json`; use `CONFIG_SOURCE_PATH` only when deliberately
mounting the private input somewhere other than `/config/config.json`. `DATA_DIR`
defaults to `/data`. These two canonical container paths keep `docker exec`
diagnostics consistent; their `LAYER_RELAY_*` aliases are intended for native
installs rather than container path remapping.

The named `overlay-data` volume is mounted at `/data`. It contains cached print
analysis, last-known state, and any rotated cloud refresh tokens.
`docker compose down` preserves it. Do not use `docker compose down -v`
unless discarding that state and the persisted cloud tokens is intentional.
For Prusa Connect, the rotated token in `/data/connect-token.json` takes
precedence over the seed in `config.json`; follow the recovery procedure in the
[Connect guide](prusa-connect.md) instead of deleting the volume.

Compose derives the volume's physical name from the checkout directory or the
explicit project name. Back up `/data` before changing that name so cached state
and the current rotated Connect token can be restored deliberately.

Keep the host configuration owner-only (`0600`) on macOS/Linux. A narrowly
privileged bootstrap copies it into the container's temporary filesystem as
`root:bun` mode `0440`, makes `/data` available to the `bun` user, and then
permanently drops to that user before Tini and Bun start. This avoids host UID
assumptions and does not require an ACL or a world-readable credential file.

To make local `.bgcode` files available, add a `compose.override.yaml`:

```yaml
services:
  overlay:
    volumes:
      - type: bind
        source: ${BGCODE_DIR}
        target: /bgcode
        read_only: true
        bind:
          create_host_path: false
```

Set `BGCODE_DIR` to an absolute host path and use this container path in
`config.json`:

```json
"localBgcodeDirs": ["/bgcode"]
```

On Windows, use forward slashes in `.env`, for example
`BGCODE_DIR=C:/Users/you/Prints`.

## Printer and camera networking

Normal Docker bridge networking can reach devices on the LAN through outbound
connections. Prefer printer and camera IP addresses; mDNS names ending in
`.local`, VPN routes, and strict host firewalls may not pass through Docker
Desktop's virtual machine consistently.

If the configured service runs on the Docker host itself, use
`host.docker.internal`. Linux installations that do not define that name can add
this override:

```yaml
services:
  overlay:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Host networking is intentionally not used because its behavior differs between
Linux and Docker Desktop. The camera relay requests RTSP over TCP, so no UDP
camera port range needs to be published.

## Health and operations

The image healthcheck verifies that `/healthz` returns the expected JSON, but it does not mark
the container unhealthy when the printer or camera is offline. Inspect
`online`, `staleSec`, and `/api/camera/status` separately when diagnosing device
connectivity.

Useful commands:

```sh
docker compose ps
docker compose logs -f overlay
docker compose restart overlay
docker compose up -d --build
docker compose down
```

Run the container-aware doctor inside the image so it checks the bundled FFmpeg
and the staged configuration rather than host prerequisites:

```sh
docker compose exec --user bun:bun overlay bun run doctor -- --require-running
```

Do not use `docker compose up --scale overlay=...`. Every server instance polls
the printer independently and can open its own upstream camera connection; run
exactly one replica per printer.

The container root filesystem is read-only and `no-new-privileges` is enabled.
Under Compose, the bootstrap receives only `DAC_OVERRIDE`, `CHOWN`, `SETUID`,
and `SETGID`, then `gosu` drops to UID/GID 1000 with no effective capabilities
before unprivileged Tini and Bun start. The application uses `/data` and a
temporary `/tmp` filesystem as its writable locations. The 15-second shutdown
grace period lets Bun and its FFmpeg child exit cleanly.

The source repository's maintenance tools are intentionally outside the runtime
image. Run the PowerShell restart helper and FFmpeg snapshot helper from the host
after their prerequisites are configured. Do not add host credentials or private
camera URLs to an image.
