---
"@internal/server": patch
"@internal/desktop-server": patch
---

The sidebar's narrow icon rail is gone, and the panel is now the whole
sidebar. Its section cells dock as a centered icon-button bar at the panel's
bottom: Workspaces and Settings are links, Subshell for Mobile opens the
install dialog, and Account opens the profile card, its trigger keeping the
amber update dot. Inside Subshell Server, "Open in
browser" joins as the bar's last button, and the server status rows sit on
their own strip below it. Clicking a section link still lands on the page you
last visited there.

Panel collapse retires with the rail, so the Subshell Server menu no longer
offers "Toggle Sidebar" and Cmd+B is free.

Renaming a subshell now re-titles its open dock tab right away. The live feed
invalidates the workspace read a rename touches, so the old title no longer
sticks until the pane remounts.

The touch key bar gained a Shift-Left key, so a touch user can send the
modified left arrow, for example to extend a selection, without a keyboard.
