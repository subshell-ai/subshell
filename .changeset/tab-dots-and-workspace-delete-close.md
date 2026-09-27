---
"@internal/server": patch
---

Workspace tabs now carry the rail's status dot, both the dense desktop tabs and the touch strip: working blinks, waiting, dead and offline all speak the same state language the rows and cells use, read from the same live cache. And deleting the workspace you are STANDING on now closes out: from the sidebar (or anywhere else) the page drops to the subshell view the pane's row still deserves, instead of rendering the dead workspace's cached detail forever.
