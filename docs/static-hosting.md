# Static GitHub Pages hosting

LayerRelay's normal deployment is a local Bun server. The repository also
builds a static version of the same overlay page that runs entirely in the
browser and is hosted on GitHub Pages. The static page never contacts a
printer. Three of its four modes hold no credentials at all. The fourth, cloud
mode, keeps the printer owner's own Prusa Connect credentials inside that one
browser and sends them only to Prusa's own services.

The published page has four modes, selected from a control panel in the
top-right corner:

| Mode | Data source | Network requests |
|---|---|---|
| Demo | A deterministic demo `.bgcode` generated at build time, replayed as a simulated print | The page's own assets and the optional OpenPrintTag snapshot |
| Your file | A `.bgcode` or `.gcode` file dropped onto the page, decoded and replayed locally | Same as demo; the dropped file never leaves the browser |
| Live server | A LayerRelay server you run yourself | `/api` reads, and optional tool-settings writes, to that one server |
| Prusa Connect | Your own Prusa Connect account, read directly by the browser with no server in between | Token refreshes to `account.prusa3d.com` and an MQTT-over-WebSocket subscription to `mqtt.prusa3d.com` |

The panel remembers the mode, playback speed, and bridge URL in browser
storage. The `?mode=`, `?speed=`, and `?bridge=` query parameters override the
stored values, and `?controls=0` hides the panel. Cloud-mode credentials are
typed into the panel and nowhere else: no query parameter carries a refresh
token or a printer UUID, and neither value is ever put into a URL.

## What runs in the browser

Everything the demo and file modes show is computed client-side:

- `.bgcode` container decoding: Deflate blocks through the browser's built-in
  `DecompressionStream`, Heatshrink and MeatPack in pure JavaScript. This is a
  port of the server decoder `bgcode.js`; provenance is recorded in
  [NOTICE.md](../NOTICE.md).
- Tool, swap, layer, remaining-time, and purge waste timelines, ported from
  `toolswaps.js`.
- Thumbnail extraction for embedded PNG, JPG, and QOI thumbnails. QOI is
  decoded in JavaScript because browsers do not decode it natively.
- Filament suggestions from the public
  [OpenPrintTag database](https://database.openprinttag.org/) snapshots. The
  database serves them with permissive CORS headers, so the page fetches them
  directly, caches them in browser storage for 24 hours, and searches locally.
- A simulated replay that produces the same telemetry fields the live server
  serves, so the overlay renders as it would during a real print.

The build injects a content security policy that limits script sources to the
page's own origin and its inline code; there are no third-party scripts or
frameworks.

## Enabling GitHub Pages

Pages must be enabled once per repository before the first deploy: open
**Settings > Pages** and set **Build and deployment > Source** to
**GitHub Actions**
([publishing-source documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)).
If the workflow runs before that setting is flipped, the deploy job fails with
an error that links to the settings page; re-run the workflow after enabling.

The workflow at [.github/workflows/pages.yml](../.github/workflows/pages.yml)
builds the site with Bun and deploys it on every push to `master`, plus on
manual dispatch. It publishes `dist/pages`, which is the same output as a
local build:

```sh
bun ci
bun run build:pages
```

The build transforms `public/overlay.html` into `dist/pages/index.html`,
bundles the browser code into `lr-static.js`, and generates
`dist/pages/demo.bgcode`. No binary assets are committed; the demo file is
produced by the build. A project site is served at
`https://<owner>.github.io/<repository>/`. The part that matters for the live
bridge later is the origin, `https://<owner>.github.io`, without the
repository path.

GitHub Pages caps published sites at 1 GB with a soft monthly bandwidth limit
of 100 GB, and deployments time out after 10 minutes
([Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)).
The static build output is a few hundred kilobytes and nowhere near these limits.

## Why the page cannot poll the printer directly

A GitHub Pages site is a normal public web origin, so the browser's
Same-Origin Policy governs every request the page makes. Reading a
cross-origin response requires the server to opt in with CORS headers, and
Prusa's Buddy firmware, which serves PrusaLink on the CORE One, does not:

- Its embedded web server never emits an `Access-Control-*` header; the
  response-header writer knows only `Content-Type`, `Connection`,
  `Content-Length`, `Transfer-Encoding`, and `ETag`
  ([lib/WUI/nhttp/headers.cpp](https://github.com/prusa3d/Prusa-Firmware-Buddy/blob/master/lib/WUI/nhttp/headers.cpp)).
- Its request parser recognizes only `GET`, `HEAD`, `POST`, `DELETE`, and
  `PUT`
  ([lib/WUI/nhttp/req_parser.cpp](https://github.com/prusa3d/Prusa-Firmware-Buddy/blob/master/lib/WUI/nhttp/req_parser.cpp));
  every other method, including the `OPTIONS` preflight CORS requires, is
  answered with `405 Method Not Allowed`
  ([lib/WUI/nhttp/common_selectors.cpp](https://github.com/prusa3d/Prusa-Firmware-Buddy/blob/master/lib/WUI/nhttp/common_selectors.cpp)).
- Prusa has acknowledged the missing CORS headers in
  [Prusa-Link-Web issue #391](https://github.com/prusa3d/Prusa-Link-Web/issues/391),
  open since April 2023 and still open as of August 2026.

PrusaLink also authenticates every `/api` request with Digest or an
`X-Api-Key` header. Both paths depend on working CORS: a custom header forces
a preflight, which the firmware rejects, and even a response to an
unauthenticated request stays unreadable without an
`Access-Control-Allow-Origin` header.

Nothing on the page side changes this. Local Network Access grants and
insecure-content settings only control whether a request may be sent; CORS
controls whether the response can be read, and no browser setting disables it.
Live data therefore always arrives from a host that opts in with CORS headers.
LayerRelay's own server is one such host, and that is the live bridge. Prusa's
cloud is the other: its account service answers any origin, and its MQTT broker
is reached over a WebSocket, which is exempt from CORS entirely. That is what
cloud mode uses. Neither route makes the printer itself reachable from a
browser.

## Live bridge setup

1. Run LayerRelay normally on a machine that can reach the printer, following
   the [README quick start](../README.md#quick-start).
2. Add the exact Pages origin to `apiReadAllowedOrigins` in `config.json`,
   for example `["https://<owner>.github.io"]`, then restart the server. An
   entry must be exactly an origin: scheme and host, no path, no trailing
   slash, no credentials. See the
   [configuration reference](configuration.md#core-settings).
3. Optional: to save tool settings from the static page, add the same origin
   to `toolSettingsAllowedOrigins` as well. Without it the bridge is
   read-only, and preflight responses advertise only `GET`.
4. Open the published page, choose **Live server**, enter the server URL, and
   connect. When the browser runs on the same machine as LayerRelay, use
   `http://127.0.0.1:8787`. From another machine, `listenHost` must bind a
   LAN address and the URL uses that address; review the README's warning
   about publishing the listener beyond loopback first.

## Browser permissions for a local bridge

The published page is `https://`, while the bridge URL is usually plain
`http://` on loopback or the LAN. Two separate browser mechanisms apply:

- Mixed content. Loopback addresses such as `http://127.0.0.1/` and
  `http://localhost/` count as secure origins, so a loopback bridge is not
  blocked as mixed content
  ([MDN: mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)).
- Local Network Access. Chrome 142 and Edge 143 gate requests from public
  pages to local and loopback destinations behind a one-time permission
  prompt
  ([Chrome 142 release notes](https://developer.chrome.com/release-notes/142),
  [Edge documentation](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access)).
  Expect one prompt the first time the page connects; a denied permission can
  be turned back on under **Site settings > Local network access**.
- A LAN `http://` bridge additionally relies on the granted permission
  relaxing mixed-content blocking. That relaxation applies only when the
  browser can tell before DNS resolution that the target is local: a private
  IP literal such as `http://192.168.1.20:8787` or a `.local` name
  ([Chrome LNA announcement](https://developer.chrome.com/blog/local-network-access),
  [MDN: local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access)).
  Browsers without Local Network Access block a LAN `http://` bridge from an
  `https://` page as mixed content; a loopback bridge still works there.
- Firefox is adopting the same permission model; its `LocalNetworkAccess`
  enterprise policy exists since Firefox 145
  ([policy documentation](https://firefox-admin-docs.mozilla.org/reference/policies/localnetworkaccess/)).
  Exact prompt behavior may differ between Firefox versions.

None of these grants weakens CORS: they decide whether the request is sent,
and `apiReadAllowedOrigins` still decides whether the response is readable.

## Cloud mode: live telemetry with no server

Cloud mode gives the published page live telemetry from a real print without
running LayerRelay, or anything else, anywhere. The browser authenticates to
Prusa's account service with a refresh token captured from the printer owner's
own Prusa Connect session, then subscribes to that printer's telemetry topics on
Prusa's MQTT broker over a WebSocket. There is no LayerRelay server, no project
backend, and no relay in between. The only remote hosts the page contacts in
this mode are `account.prusa3d.com` and `mqtt.prusa3d.com`.

The credentials go nowhere else. The refresh token is kept in that browser's own
local storage under `layer-relay.static.connect` and is sent to exactly one URL,
`https://account.prusa3d.com/o/token/`. The short-lived access token that comes
back is used for a single account lookup, which yields the numeric Prusa user
id, and as the password on the MQTT connection. That lookup response also
carries the account email and name; the page reads neither, stores neither, and
shows neither. The page has no backend of any kind to forward a credential to.

### One consumer per token chain

**A Prusa refresh-token chain must have exactly one consumer, and cloud mode is
a consumer. Do not give it a chain that a running LayerRelay server is already
using, and do not open the page against the same chain in two tabs.**

Prusa rotates the refresh token every time it is spent and retires the previous
one immediately. Two consumers therefore race, and whichever refreshes second
presents a token the service has already invalidated. It receives
`invalid_grant`, and that chain is dead. The only way back is capturing a new
token by hand; nothing on the page can repair a broken chain.

Cloud mode does what it can on its own side. It writes each rotated token to
storage before the new access token is used for anything, and it holds a lock in
browser storage so only one tab ever performs a refresh while the others wait
and reuse the result. That covers tabs in the same browser. It cannot see a
LayerRelay server, a second browser, another device, or a script, so the
single-consumer rule is yours to keep.

Capture a token dedicated to cloud mode, in its own private window, following
[Capture the printer UUID and refresh token](prusa-connect.md#capture-the-printer-uuid-and-refresh-token).
The rest of [Prusa Connect setup](prusa-connect.md) applies here as well, in
particular
[Before you capture a token](prusa-connect.md#before-you-capture-a-token): the
extracted value is a full web-client credential rather than a least-privilege
key, and a private window isolates the chain without narrowing what the token
can do.

### Setup

1. Capture a printer UUID and a dedicated refresh token with the guide linked
   above. Use a private window that you close afterwards, and do not reuse a
   token that a LayerRelay server, a script, or another browser already holds.
2. Open the published page and choose **Prusa Connect** in the control panel.
3. Paste the printer UUID and the refresh token, then connect. The status line
   reports the connection state and how many topics have arrived.
4. Recommended: drop the `.bgcode` file of the running print onto the page. The
   next section explains what that adds.

The panel never renders the token back once it is stored. Clearing the fields
removes both values from browser storage.

### What is live, and what needs the print file

Prusa's per-printer MQTT topics are retained, so the current state arrives in
full the moment the page subscribes and then updates continuously. It is a
smaller set than PrusaLink and the Prusa Connect API give a server. Everything
else the overlay can show comes from the print file, and the page cannot
download that file for you: Connect's own REST API under
`connect.prusa3d.com/app/` refuses a cross-origin preflight, so a browser cannot
fetch the job's `.bgcode` from it. You supply the file by dropping it onto the
page, exactly as in the "Your file" mode, and it is decoded locally and never
uploaded.

| Overlay field | Cloud-mode source |
|---|---|
| Printer state | Live, `data/state`, normalized the same way the server normalizes it |
| Online and staleness | Live, `data/online` together with the age of the last message |
| Progress percent | Live, `jobs/<id>/data/progress`, falling back to `data/job-progress` |
| Remaining time | Live, `jobs/<id>/data/time-remaining`, which is in seconds |
| Nozzle temperature and target | Live, `data/temp/nozzle/current` and `/target` |
| Bed temperature and target | Live, `data/temp/heatbed/current` and `/target` |
| Chamber temperature | Live, `data/temp/chamber/current` |
| Z height | Live, `data/axis-z` |
| Active tool | Live, `data/tools/active`, which is 1-based and is converted for the 0-based field |
| Loaded material | Live, `data/material` |
| Activity card | Live, from the `dialog` topic, whenever it carries a title or text |
| Print name | Needs the dropped file |
| Thumbnail | Needs the dropped file |
| Layer, current and total | Needs the dropped file |
| Tool changes, done and total | Needs the dropped file |
| Purge waste, done and total | Needs the dropped file |
| Next tool and time to the next change | Needs the dropped file |
| Per-tool filament types | Needs the dropped file |
| Filament weight | Needs the dropped file |
| Chamber target | Not published by the broker; the field stays empty |
| Print speed, flow, and fan speeds | Not published by the broker; the fields stay empty |
| Elapsed time | Not published by the broker; the field stays empty |
| Camera and nozzle views | Not available; see below |
| Room and outdoor sensors | No source in cloud mode; those readings come from a server-side Netatmo integration, and the fields stay empty |

Two details are worth knowing. Per-tool nozzle temperatures do exist on the
broker under `data/tools/<n>/temp/nozzle/`, but they are published around tool
changes rather than continuously, so they are not a dependable substitute for
the main nozzle reading. And the job name is not published at all, which means
nothing on the page can confirm that the file you dropped is the file the
printer is running. If they do not match, the file-derived rows above will be
confidently wrong. Drop the file for the job that is printing, and drop the new
one when the job changes.

### Why there is no camera in cloud mode

There is no camera in cloud mode. This is a hard limit, not an unfinished
feature.

- A LAN camera feed is RTSP, and a browser cannot speak RTSP. A page has no raw
  socket API at all, only the fetch and WebSocket abstractions the browser
  offers. WebAssembly does not change this: it runs inside the same sandbox and
  reaches the network through the same JavaScript APIs, so an RTSP client
  compiled to WebAssembly still has no socket to open. Transcoding RTSP is
  precisely what LayerRelay's server is for.
- Prusa Connect does keep camera stills, but its REST API is closed to browsers
  on other origins. A preflight to those paths answers 404 with no CORS headers,
  so an `Authorization` header can never be sent, and passing a valid token in
  the query string is answered with 401. Both were measured against the live
  service with a working token, so this is a confirmed negative rather than an
  assumption.
- Prusa's camera WebRTC configuration endpoint is open to other origins and does
  return connection parameters. The signaling path it points at was never
  exercised, so nothing here claims a browser can obtain a stream through it. It
  is mentioned only so the point above is not read as a complete survey. Cloud
  mode has no camera.

The camera and nozzle panels therefore report the same disabled state they do in
the demo and file modes.

### When the token chain breaks

A refresh answered with `invalid_grant` means the stored token has already been
retired, nearly always because another consumer spent it. The page says so
specifically and stops retrying rather than burning further attempts. The
server-side procedure in
[Rotation, backups, and recovery](prusa-connect.md#rotation-backups-and-recovery)
does not apply, because a browser has no `DATA_DIR` and no persisted token file
to restore. Recover like this instead:

1. Find the other consumer and stop it, or decide that cloud mode gets a chain
   of its own.
2. Clear the stored credentials in the panel.
3. Capture a fresh refresh token in a new private window with the guide linked
   above.
4. Paste it into the panel and connect again.

If a LayerRelay server uses the same Prusa account, give it and cloud mode
separate chains captured in separate private windows. That is the only
arrangement in which both keep working.

## Security tradeoffs

- `apiReadAllowedOrigins` defaults to empty, which keeps every `/api` response
  same-origin as before. With origins listed, `/api` reads answer those exact
  origins with CORS headers and expose the `ETag` header for the settings
  flow; other origins receive no CORS headers.
- Image and stream routes (`/api/thumbnail`, `/api/camera.mjpeg`,
  `/api/camera.jpg`, `/api/nozzle.mjpeg`, `/api/nozzle.jpg`) are consumed
  through `<img>` elements, whose requests carry no `Origin` header, so
  per-origin gating is impossible there. While the allowlist is non-empty,
  these routes send `Cross-Origin-Resource-Policy: cross-origin` instead of
  `same-origin`. Any website opened in a browser that can reach the listener
  can then embed those images. Keep the listener on loopback or behind a
  firewall, and keep the allowlist empty when the static page is not in use.
- Cross-origin writes stay narrow: only the non-secret tool inventory and the
  timelapse interval, and only for origins in `toolSettingsAllowedOrigins`.
  Tool inventory writes additionally require a matching `If-Match` revision;
  the timelapse interval takes a bounded integer with no revision check.
- No LayerRelay secret reaches the static page. A server's printer credentials,
  RTSP URLs, and Prusa Connect token stay inside the server process, and the
  live bridge exposes none of them. In demo, file, and live modes the page keeps
  only its mode, speed, bridge URL, simulated tool settings, and the cached
  OpenPrintTag snapshot in browser storage.
- Cloud mode is the one exception, and the credential there is the visitor's
  own. The refresh token and printer UUID typed into the panel are held in that
  browser's local storage, are sent only to `account.prusa3d.com`, and reach no
  LayerRelay server and no third party. The short-lived access token derived
  from the refresh token additionally serves as the MQTT password to
  `mqtt.prusa3d.com`. The numeric Prusa user id is cached; the account email and
  name are never stored, logged, or displayed. Anyone with access to that
  browser profile can read the stored token, so treat the machine the way you
  would treat one holding `config.json`.
- The injected content security policy permits outbound `https:` and WebSocket
  connections broadly, so it is not what confines the token. What confines it is
  that the page has no backend, ships no third-party code, and sends the refresh
  token to one hard-coded URL.

## Browser support

The static build targets Chrome and Edge 103, Firefox 113, and Safari 16.4 or
newer. The floor follows from `DecompressionStream('deflate-raw')`, which
landed in Chrome 103 (June 2022), Firefox 113 (May 2023), and Safari 16.4
(March 2023), per
[MDN's browser-compat-data](https://github.com/mdn/browser-compat-data).
Nothing in the build uses workers or `SharedArrayBuffer`, so no
cross-origin-isolation headers are needed. The Local Network Access notes
above apply only to live mode in current Chrome, Edge, and Firefox versions.

Cloud mode needs nothing beyond that floor. `WebSocket` and `localStorage` are
much older than it, and `BroadcastChannel`, which shares a freshly refreshed
access token between tabs, is optional: without it the tabs still coordinate
through the storage lock. Local Network Access does not apply to cloud mode at
all, because both hosts it contacts are public and reached over TLS.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| The deploy job fails and mentions enabling GitHub Pages | The Pages source is not set | Set **Settings > Pages > Source** to **GitHub Actions**, then re-run the workflow |
| Live connect fails and DevTools shows a CORS error | The Pages origin is missing from `apiReadAllowedOrigins` or is not an exact origin match | Add the exact origin, restart the server, reload the page |
| Local requests fail in Chrome/Edge with no prompt | Local Network Access was denied earlier | Re-allow it under **Site settings > Local network access** and reload |
| A LAN `http://` bridge is blocked as mixed content | The browser lacks Local Network Access, or the hostname is not a private IP literal or `.local` name | Use Chrome 142+/Edge 143+ with the server's IP literal, or browse on the server machine via `http://127.0.0.1:8787` |
| Saving tool settings fails and DevTools reports that `PUT` is not an allowed method | The origin is only in `apiReadAllowedOrigins`, so the preflight advertises `GET` alone and the browser blocks the write before it is sent | Add it to `toolSettingsAllowedOrigins` as well and restart |
| Saving tool settings fails with `409` | The settings changed since the last load | Reload and retry with the fresh `ETag` |
| Camera, nozzle, or thumbnail images stay empty in live mode | `apiReadAllowedOrigins` is empty, so image routes still send `Cross-Origin-Resource-Policy: same-origin` | Configure the allowlist; the relaxation activates while it is non-empty |
| No camera in demo, file, and cloud modes | Expected: a browser cannot open an RTSP feed and Prusa Connect's stills are behind a REST API that refuses cross-origin requests | Use live mode for the camera panels |
| Cloud mode fails at once and reports an invalid token | The refresh-token chain was spent by another consumer, so the stored token is already retired | Stop the other consumer, capture a fresh token in a private window, and re-enter it; see [When the token chain breaks](#when-the-token-chain-breaks) |
| Cloud mode is live but the thumbnail, layers, swaps, and waste stay empty | No print file is loaded; those come from the `.bgcode`, which the page cannot download from Connect | Drop the running job's `.bgcode` onto the page |
| Cloud mode shows layer or swap counts that do not match the print | The dropped file is not the file being printed, and the job name is not published so the page cannot detect the mismatch | Drop the correct file for the current job |
| Speed, flow, fan, elapsed time, or the chamber target stay empty in cloud mode | Expected: the broker does not publish them | Use the live bridge when those fields matter |
| Filament suggestions are unavailable | OpenPrintTag could not be fetched or is still loading | Manual names and colours keep working; the page retries on the next load |
