---
"@internal/server": minor
---

Subshells: the row action menu gains Switch preset. The dialog picks another preset of the pane's own harness (or none) and restarts with it; a running pane is revived from the new one. The restart route takes an optional `presetId`, validated before anything is killed, audited as `subshell.preset_switch`. The `@internal/backend-errors` `INVALID_PRESET` addition rides this changeset.
