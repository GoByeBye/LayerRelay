# Static GitHub Pages hosting

LayerRelay's normal deployment is a local Bun server. The repository also
builds a static version of the same overlay page that runs entirely in the
browser and is hosted on GitHub Pages. The static page stores no credentials
and never contacts a printer.

The published page has three modes, selected from a control panel in the
top-right corner:

| Mode | Data source | Network requests |
|---|---|---|
| Demo | A deterministic demo `.bgcode` generated at build time, replayed as a simulated print | The page's own assets and the optional OpenPrintTag snapshot |
| Your file | A `.bgcode` or `.gcode` file dropped onto the page, decoded and replayed locally | Same as demo; the dropped file never leaves the browser |
| Live server | A LayerRelay server you run yourself | `/api` reads, and optional tool-settings writes, to that one server |

The panel remembers the mode, playback speed, and bridge URL in browser
storage. The `?mode=`, `?speed=`, and `?bridge=` query parameters override the
stored values, and `?controls=0` hides the panel.

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
Live data therefore always flows through a server that adds CORS headers, and
LayerRelay's own server is that server.

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
- No secret ever reaches the static page. Printer credentials, RTSP URLs, and
  cloud tokens stay inside the server process. The page keeps only its mode,
  speed, bridge URL, simulated tool settings, and the cached OpenPrintTag
  snapshot in browser storage.

## Browser support

The static build targets Chrome and Edge 103, Firefox 113, and Safari 16.4 or
newer. The floor follows from `DecompressionStream('deflate-raw')`, which
landed in Chrome 103 (June 2022), Firefox 113 (May 2023), and Safari 16.4
(March 2023), per
[MDN's browser-compat-data](https://github.com/mdn/browser-compat-data).
Nothing in the build uses workers or `SharedArrayBuffer`, so no
cross-origin-isolation headers are needed. The Local Network Access notes
above apply only to live mode in current Chrome, Edge, and Firefox versions.

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
| No camera in demo and file modes | Expected: the static build has no camera source | Use live mode for the camera panels |
| Filament suggestions are unavailable | OpenPrintTag could not be fetched or is still loading | Manual names and colours keep working; the page retries on the next load |
