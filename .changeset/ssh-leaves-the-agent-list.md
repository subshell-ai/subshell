---
"@subshell-ai/plugin-api": minor
"@subshell-ai/plugin-ssh": patch
"@internal/server": patch
"@internal/node": patch
---

The New subshell Agent list no longer offers SSH, on web and on mobile. A pick there carries no destination, so it died at ssh's usage prompt; the SSH terminal tab's connect form is the real door, and it keeps working as before.

Plugins now say this about themselves: a `pickable: false` in the manifest's `subshell` block keeps a plugin out of the launch pickers while leaving it launchable by id. The picker holds no id list; the SSH plugin carries the declaration.
