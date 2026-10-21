---
"@internal/server": patch
---

Removing a workspace's last tab now retires the workspace instead of
refusing, matching how closing a subshell already behaved. The pane's
subshell keeps running; it just no longer sits in a workspace. Tab close
buttons and the rail's drag-out are enabled for the final tab, and the page
that lost its workspace lands somewhere sensible.
