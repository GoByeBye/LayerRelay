# 3d-livestream overlay

A local OBS overlay for a **Prusa CORE One + INDX 8-tool toolchanger**. Shows the current
print with a live thumbnail, progress, remaining time, nozzle temperature, the current tool
in use, and how many tool swaps have happened so far.

The printer's PrusaLink API does **not** expose the active tool or swap count (the INDX isn't
surfaced as an MMU), so the server downloads the print's `.bgcode` once, decodes it in pure JS
(Heatshrink + MeatPack), builds a `progress% → {tool, swaps}` timeline, and maps the live
progress onto it. Swap counting is validated against the file's own `total toolchanges` metadata.

## Setup

```bash
npm install
# edit config.json if your printer IP / PrusaLink password differ
npm start
```

Then open **http://localhost:8787/** — that's the overlay.

`config.json`:
```json
{
  "printerHost": "192.168.1.51",
  "username": "maker",
  "password": "…",          // PrusaLink password (Settings → Network → PrusaLink)
  "port": 8787,
  "pollIntervalMs": 2000,
  "toolCount": 8
}
```

## OBS setup

1. Add a **Browser** source.
2. URL: `http://localhost:8787/`
3. Width **400**, Height **230** (the card sits in the top-left with a 16px margin).
4. The page background is transparent — it composites straight over your video.
5. Recommended: tick **"Refresh browser when scene becomes active"** for easy recovery.

## How it works

| File | Role |
|------|------|
| `server.js` | Polls PrusaLink (`/api/v1/status`, `/api/v1/job`) via HTTP Digest auth, downloads + analyzes the print's bgcode once per job, serves `/api/state`, `/api/thumbnail`, and the overlay. |
| `digest.js` | Minimal HTTP Digest auth client (Node has none built in). |
| `bgcode.js` | Pure-JS `.bgcode` decoder: container iteration + Heatshrink 11/4 & 12/4 + MeatPack unbinarize. Ported from [prusa3d/libbgcode](https://github.com/prusa3d/libbgcode). |
| `toolswaps.js` | Builds the tool-change timeline from decoded G-code and maps live progress → current tool + swaps done. |
| `public/overlay.html` | Self-contained transparent overlay (no external requests). |
| `test-decode.js` | Diagnostic: `node test-decode.js <file.bgcode>` prints decode + timeline stats. |

`/api/state` shape:
```json
{
  "state": "PRINTING",
  "name": "3DBenchy H2C Multi Color Test Print",
  "thumbnailUrl": "/api/thumbnail",
  "progress": 32,
  "timeRemainingSec": 9960,
  "timeElapsedSec": 14827,   // seconds spent printing so far (PrusaLink time_printing)
  "nozzleTemp": 255, "nozzleTarget": 255,
  "currentTool": 4,     // 0-based tool index (as in the G-code)
  "toolLabel": 5,       // 1-based label (as shown on the printer UI)
  "material": "PETG",   // filament for the current tool
  "swapsDone": 256, "swapsTotal": 654,
  "swapping": false
}
```

## Notes

- **Local bgcode fallback:** PrusaLink sometimes won't serve a print's file over HTTP (it can
  report `size: 0` with a dead download ref — e.g. right after an upload/reboot, or for files it
  hasn't re-indexed). Drop a copy of the `.bgcode` (same filename as the print) into any folder
  listed in `config.json` → `localBgcodeDirs`, and the server analyzes that instead. Analysis
  order per job is: disk cache → local file → printer download. You can grab a copy from the
  PrusaConnect API / your slicer output.
- The first analysis of a new print downloads the whole `.bgcode` from the printer, which is
  **slow while a print is running** (the printer reads it off USB) — up to a couple of minutes.
  During that window `swapsTotal`/`currentTool` are `null` and the overlay shows "analyzing…".
  The result is cached to `cache/` keyed by job, so a server restart mid-print is instant.
- Tools: the G-code is 0-based (`T0`–`T7`); the overlay shows them 1-based (`T1`–`T8`) to match
  the printer UI. `currentTool` in the API stays 0-based (used to index `material`); `toolLabel` is
  the 1-based display value.
- Material per tool comes from the bgcode `filament_type` metadata (0-indexed by tool).
- **Waste** is the filament purged during toolchanges, computed from the g-code: the sum of
  extrusion inside PrusaSlicer's `;FLUSH_START/END` (color flush) and `;EXCLUDE_E_START/END`
  (tool-load prime) blocks, converted to grams via filament diameter/density. Shown as
  done / total (climbs as swaps happen). To count the flush only (≈60% of that), drop the
  `EXCLUDE_E` blocks in `buildTimeline` (`toolswaps.js`).
- **Total filament** for the print comes from the slicer's `total filament used [g]` metadata,
  shown in the progress row (`20% · 176 g · elapsed 4h07m / 9h35m`).
- Tool-swap "done" count is exact: it counts tool changes whose slicer progress ≤ live progress,
  disambiguating same-percent buckets with the live remaining-time estimate.
- `config.json` (credentials) and `cache/` are gitignored.

## Resilience / disconnection

PrusaLink runs on the printer's resource-constrained Buddy board and can become **temporarily
unresponsive during heavy prints** (lots of tool changes / motion). This does **not** stop the
print — only the web API pauses. The overlay handles it:

- The server polls without overlapping requests and backs off while the printer is unreachable.
- When the feed goes stale (`online:false` / `staleSec` climbs), the overlay **grays out and dims
  the last-known data (kept visible, not hidden)** and shows a red "Printer disconnected · mm:ss"
  banner. The countdown freezes.
- It **auto-recovers** the moment the printer answers again — no restart needed.
- The last-good frame is persisted to `cache/laststate.json`, so restarting the server while the
  printer is down still shows the (grayed) last frame instead of an empty card.

`/api/state` exposes `online` (bool) and `staleSec` (seconds since last successful printer read).
