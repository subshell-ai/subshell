---
"@internal/server": minor
"@internal/desktop-server": minor
"@internal/docs": patch
---

Add full instance backup and restore as a single archive with optional password encryption. Server Settings creates downloads and prepares restores; the CLI and desktop assistant apply them offline with recovery after interruption, failed-boot rollback, migration choices, and optional administrator password recovery. Preserve database-only update snapshots and label legacy database-only restores explicitly.
