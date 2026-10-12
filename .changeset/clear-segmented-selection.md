---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Make selected tabs and segmented choices clearly visible throughout the web interface, including Terminal / Desktop App. Choices retain their original icons with the stronger selected highlight. Workspace tabs use the same selected treatment on phones and in tiled layouts, including unfocused groups.

Use the same clear selected state for desktop setup choices and mobile tabs, agent, preset, and node choices, preserving their icons and accessibility states.

Keep dialogs and modal sheets open when clicking outside them across the dashboard, node dashboard, and desktop apps. Close them through an explicit Close, Cancel, or Done control.
