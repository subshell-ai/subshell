---
"@internal/server": minor
"@internal/node": minor
"@internal/desktop-client": minor
"@internal/desktop-server": minor
"@internal/docs": minor
---

Add the BetterDisplay virtual display provider for macOS. Bundle a shared native display helper in both desktop apps, disabled by default and managed through a separate native settings panel. Require explicit local consent and macOS permissions, support immediate disable, and keep activation outside first-run setup and remote node/MCP controls.

Reuse the authenticated screen viewer with bounded native capture and input, retain verified display ownership for cleanup and recovery, and document activation and macOS shared-desktop limitations in node settings.

Recheck consent and permissions after native capture startup and on input, and close new displays when node policy changes during allocation.

Keep uncertain creation records separate so retries can proceed, explain vanished displays, share probe cleanup guards, and encode frames away from the helper's UI thread. Show platform-appropriate provider settings and prevent equal-version release bundles from replacing each other's helper.
