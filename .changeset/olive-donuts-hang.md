---
"@internal/server": patch
---

fix: opening the web UI on a fresh (never-registered) instance no longer
freezes the browser tab — the first-run redirect into the setup wizard
deadlocked itself in a render-phase navigation storm.
