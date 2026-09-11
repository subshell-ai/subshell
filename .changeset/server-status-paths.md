---
"@internal/server": patch
---

`subshell-server status --json` now reports `paths` (dataDir, database, logsDir, nodeArtifacts) so the desktop app's reset deletes exactly what it shows.
