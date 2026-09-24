---
"@internal/server": minor
---

Subshells: the row action menu gains Switch preset. The dialog picks another preset of the pane's own harness (or none) and restarts with it; a running pane is revived from the new one. The restart route takes an optional `presetId`, validated before anything is killed, audited as `subshell.preset_switch`. The `@internal/backend-errors` `INVALID_PRESET` addition rides this changeset.

Menus (dropdown and the sidebar right-click, one shared primitive): rows tighten from a 44px floor to 36px — a seven-item menu no longer spends half a phone screen — and the menu box stops drawing the browser's focus ring when it opens; the highlighted item stays the keyboard cursor. Every inline failure line across the SPA and the node cards moves to the `detail` role the design system prescribes for a control's own explanation.

Follow-ups from the feature's final review ride here: a swap arriving while a restart for that subshell is in flight is refused (409 `RESTART_IN_FLIGHT`) instead of joining another caller's revival it could not direct; a restart that fails mid-flight announces its rolled-back dead state on the live feed; and both audit rows of a restart name the ACTING viewer, so a grantee's restart and preset switch are no longer attributed to the owner.
