# Bambu Lab LAN monitoring

LayerRelay can read a Bambu Lab printer's local MQTT telemetry and show it in
the dashboard and OBS overlay. This integration is experimental. Its automated
tests use synthetic protocol fixtures; no real printer or firmware combination
has been verified by this change.

The initial target is the legacy telemetry shape used by X1, P1, and A1 series
printers. Field availability varies by model and firmware. Do not assume that
newer multi-nozzle machines or every AMS variant expose the same fields.

## Setup

1. Give the printer a stable LAN IP address or hostname.
2. Enable local MQTT access on the printer. Use LAN Only Mode and, where the
   model and firmware offer and require it, Developer Mode. Menu names vary.
   Read Bambu Lab's [LAN Only Mode guide](https://wiki.bambulab.com/en/knowledge-sharing/enable-lan-mode)
   and [Developer Mode guide](https://wiki.bambulab.com/en/knowledge-sharing/enable-developer-mode).
3. Read the printer serial number and LAN access code from the printer's
   settings. Use the printer serial, not an AMS serial number.
4. Run `bun run setup` and choose Bambu Lab, or create the ignored `config.json`
   with these settings:

```json
{
  "printerType": "bambu",
  "printerHost": "192.168.1.100",
  "bambuSerial": "YOUR_PRINTER_SERIAL",
  "bambuAccessCode": "YOUR_LAN_ACCESS_CODE"
}
```

Then run `bun run doctor` and `bun run start`. Open
<http://localhost:8787/> for the dashboard or <http://localhost:8787/overlay>
for the transparent overlay. The same [OBS setup](../README.md#obs-setup)
applies to both printer types.

Keep the access code in the ignored configuration file or the documented
[environment override](configuration.md). It is a credential with authority
beyond monitoring, even though LayerRelay only requests telemetry. It is never
included in the browser's state response. PrusaLink credentials and Prusa
Connect tokens are not required in Bambu mode.

## What it displays

When the printer reports them, LayerRelay displays:

- Print state, job name, progress, remaining time, and finish clock
- Nozzle, bed, and chamber temperatures and available temperature targets
- Current and total layer counts, and speed override percentage
- AMS slot inventory, material name, colour, and loaded state
- The currently selected AMS filament slot, or external spool
- Last-known telemetry during a disconnect, with stale/offline status
- A finished-job summary through the existing job lifecycle and persistence path

Tool numbers in LayerRelay are 1-based display labels. AMS slots represent
filament sources, not separate hotends. The underlying API keeps `currentTool`
0-based. Inventory can be edited through **Dashboard > Tools & filament**;
these edits change LayerRelay's display settings only.

Wire fields have different units from some Prusa fields. In particular,
`mc_remaining_time` is minutes and is converted to seconds; `mc_percent` is a
percentage. Partial status messages preserve previously reported values instead
of clearing temperatures or job details whenever a field is omitted.

The integration does not log in to Bambu Cloud or download print files over
FTP. It does not extract 3MF thumbnails, analyse Bambu G-code, estimate purge
waste, or generate a future tool-change timeline. Missing values remain
unavailable; Prusa-specific BG-code analysis is not applied to Bambu jobs.

## Camera

The existing shared FFmpeg relay can use an explicitly configured RTSP or
RTSPS URL. On a model that offers the conventional Bambu Lab RTSPS stream,
enable LAN live view and configure a URL such as:

```json
{
  "cameraRtspUrl": "rtsps://bblp:YOUR_LAN_ACCESS_CODE@192.168.1.100:322/streaming/live/1"
}
```

This is model-specific, not a universal Bambu camera URL. Check the stream
offered by your model and firmware. The native TLS/JPEG camera transport used
by P1 and A1 printers on port 6000 is not supported by the RTSP relay. An
external RTSP camera is another option. Telemetry works without any camera.

The configured camera URL and its credential stay on the server. The browser
receives the relayed images. Keep `listenHost` on loopback unless the dashboard
is intentionally shared; anyone able to read its API can view enabled camera
feeds. FFmpeg is required for camera relay, not for MQTT telemetry.

## Connection and security boundary

The server uses one MQTT 3.1.1 connection over TLS to `printerHost:8883`, with
username `bblp` and the configured LAN access code as the password. It subscribes
only to `device/<serial>/report`. After subscribing, it publishes a
`pushing.pushall` request on `device/<serial>/request` to request a full status
snapshot. Subsequent telemetry arrives on the same connection.

The snapshot request is a MQTT publish, so the integration is not strictly a
subscribe-only client. It requests information; it does not start, pause, stop,
upload, heat, move, calibrate, or change printer settings. There is no general
printer-command API in LayerRelay.

Bambu printers use a local certificate that may not chain to a public CA. The
Bambu MQTT client accepts that certificate with `rejectUnauthorized: false`
for this connection only. Traffic is encrypted, but the server does not
authenticate the printer certificate. Use the configured host on a trusted
LAN; do not expose the printer's MQTT port to the internet. This does not change
TLS validation for LayerRelay's HTTPS requests to other services.

Bambu Lab states that status pushes remain available under its authorization
controls, while the ability to send unsigned requests or access cameras depends
on printer mode and firmware. Developer Mode is an explicit printer setting;
LayerRelay never changes it or bypasses authorization. See Bambu Lab's
[authorization-control explanation](https://blog.bambulab.com/firmware-update-introducing-new-authorization-control-system-2/)
and [third-party integration update](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/).

## Static Pages and troubleshooting

The native LayerRelay server handles MQTT. The static Pages dashboard can read
that server through its existing bridge mode after `apiReadAllowedOrigins` is
configured. It cannot connect directly to a printer's raw TLS MQTT socket, and
the Prusa Connect cloud panel is specific to Prusa.

If no data arrives, check that the host is reachable on port 8883, the serial
and access code match the printer, and LAN/Developer settings permit MQTT
requests. A successful TCP connection alone does not prove that authentication,
subscription, or telemetry succeeded. Restart LayerRelay after changing
credentials. A connected but silent printer eventually becomes stale/offline;
the dashboard should not continue presenting an old sample as live.

When reporting compatibility, include only the model, firmware version, LAN
and Developer Mode settings, and sanitized field examples. Do not include the
access code, private camera URLs, or unsanitized configuration files.

## Protocol references

The adapter is an original implementation. Field names and units were checked
against Bambu Lab's public Bambu Studio sources at revision
[`56a57d00a591360cf41bf21383915ee5bf357be5`](https://github.com/bambulab/BambuStudio/tree/56a57d00a591360cf41bf21383915ee5bf357be5),
including
[`DeviceManager.cpp`](https://github.com/bambulab/BambuStudio/blob/56a57d00a591360cf41bf21383915ee5bf357be5/src/slic3r/GUI/DeviceManager.cpp),
[`DevExtruderSystem.cpp`](https://github.com/bambulab/BambuStudio/blob/56a57d00a591360cf41bf21383915ee5bf357be5/src/slic3r/GUI/DeviceCore/DevExtruderSystem.cpp),
and [`DevFilaSystem.cpp`](https://github.com/bambulab/BambuStudio/blob/56a57d00a591360cf41bf21383915ee5bf357be5/src/slic3r/GUI/DeviceCore/DevFilaSystem.cpp).
These are implementation references rather than a supported vendor API
contract; firmware changes can alter compatibility.
