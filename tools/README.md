# Stream ops tools

Reusable scripts for recurring livestream chores: VOD frame selection, camera
snapshots, overlay messages, and safe server restarts.

## Prerequisites

- **Bun 1.3.14 or newer in the 1.x line** (for the API and cross-platform tools)
- **yt-dlp** and **ffmpeg** on PATH (for the media scripts)
- **PowerShell 7** (`pwsh`) for the safe overlay restart.
- **Git Bash or WSL** only for the `.sh` VOD/thumbnail helpers.
- `config.json` (gitignored) provides `port` and `cameraRtspUrl`.

## Frames

| Command | Does |
|---|---|
| `bun tools/snapshot.mjs <out.jpg> [rtspUrl]` | Cross-platform uncompressed printer-camera frame; defaults to `cameraRtspUrl`. |
| `bash tools/vod-frame.sh <videoId> <55%\|sec\|HH:MM:SS> <out.jpg>` | One frame from a VOD at a timestamp. |
| `bash tools/grab-candidates.sh <videoId> <montage.jpg> [pcts...]` | Several frames tiled side-by-side to pick the best thumbnail moment. |

Note: VOD frames are **640x360** - the only fast-seekable format. 720p/1080p are DASH-only and
too slow to seek here. For crisp thumbnails, capture live RTSP stills (1080p) during a print.

Run the `.sh` commands from a Git Bash terminal. From Windows PowerShell, invoke Git Bash
explicitly so `C:\Windows\System32\bash.exe` does not accidentally route the command to WSL:

```powershell
$bash = 'C:\Program Files\Git\bin\bash.exe'
& $bash tools/grab-candidates.sh <videoId> montage.jpg 35 58 78
& $bash tools/vod-frame.sh <videoId> 58% pick.jpg
```

## Overlay (Bun / PowerShell)

The Bun overlay tools use `OVERLAY_URL` when set and otherwise read the native
port from `config.json`. Write authentication comes from `OVERLAY_API_TOKEN`, or
automatically from `apiToken` in the same config file when `OVERLAY_URL` is not
set. An explicit remote destination always requires an explicit token so a local
credential cannot be forwarded accidentally.

| Command | Does |
|---|---|
| `bun tools/overlay-message.mjs set "text"` / `clear` | Set/clear the sticky on-screen banner. |
| `bun tools/announce.mjs add "text"` / `list` / `clear` | Post to the configurable stream-host feed (newest line shows big, previous as history). Manual posts never claim automation presence. |
| `bun tools/announce.mjs add --auto "text"` | Refresh the short automation lease and post a line; `AUTO MODE` disappears automatically unless heartbeats continue. |
| `bun tools/announce.mjs auto-pulse` / `auto-status` / `auto-stop` | Refresh, inspect, or explicitly clear the fail-closed automation lease. An active operator should pulse every 15 seconds. |
| `pwsh -NoProfile -File tools/restart-overlay.ps1` | Preflight Bun checks/tests/smoke, then safely restart the overlay server. Refuses to stop unrelated processes, prevents double polling, and succeeds only after `/api/state` is healthy. |

## Typical VOD frame selection

Run these commands in Git Bash:

```bash
bash tools/grab-candidates.sh <videoId> montage.jpg 35 58 78   # review montage.jpg, pick a %
bash tools/vod-frame.sh <videoId> 58% pick.jpg
```
