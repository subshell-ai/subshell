---
"@internal/server": patch
---

fix(web): The in-flight input badge (issue #243) shows only inside the diagnostics state. With pane diagnostics off the terminal's overlay column renders nothing, so normal typing no longer flickers the top-right corner; with them on the HUD and the badge are placed exactly as before.
