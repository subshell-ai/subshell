---
"@internal/server": patch
"@internal/docs": patch
---

fix(web): The preset list's launch-command preview prints names as names. Keys, the command and flag tokens are never quoted; env values carry quotes only where a shell would split or expand them; a flag's CLI-arg value prints verbatim, so quotes there are the ones the person typed; and a flag without a value no longer contributes an empty '' token. The Presets docs page states the rule alongside the editor and row previews, which now share one quotifier.
