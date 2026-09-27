---
"@internal/server": patch
---

Live terminal panels no longer lose their scrollback when an app switches to the alternate screen. A panel that happened to be open when a full-screen TUI (Claude Code among them) entered its alt buffer stayed there for its whole life: no scrollbar, dead mouse wheel. The relay now strips the alt-screen toggles on the way to the browser, the way it already strips the synchronized-output markers, and the pane logs on disk stay byte-raw.
