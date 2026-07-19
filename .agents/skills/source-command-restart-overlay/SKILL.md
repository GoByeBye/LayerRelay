---
name: "source-command-restart-overlay"
description: "Safely restart the overlay server (single poller, never double-polls the printer)"
---

# source-command-restart-overlay

Use this skill when the user asks to run the migrated source command `restart-overlay`.

## Command Template

For a Windows-native install, run `pwsh tools/restart-overlay.ps1`. For the documented Docker
install, run `docker compose restart overlay`. Never start another instance before the old one
has stopped: duplicate PrusaLink pollers can wedge the printer board. After restarting, verify
`http://localhost:<port>/healthz` and then `/api/state` respond.
