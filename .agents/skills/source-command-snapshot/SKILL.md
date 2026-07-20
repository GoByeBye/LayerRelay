---
name: "source-command-snapshot"
description: "Capture a fresh RTSP frame from the printer camera and describe what's on the bed"
---

# source-command-snapshot

Use this skill when the user asks to run the migrated source command `snapshot`.

## Command Template

Run `bun tools/snapshot.mjs <scratchpad-image-path>` and wait for it to
exit successfully. Then read the newly written image and briefly describe the current state
of the print/printer. This is the uncompressed, no-delay camera feed; if capture fails, report
the error instead of reusing an older image.
