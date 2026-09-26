---
"@internal/server": patch
---

The Updates page now follows updates while they happen. A node row says what the server's tracker knows - installing, restarted onto the new version, refused, or quiet past two minutes - and the Server row tells the ending of a self-update to whoever opens the page next, including the boot that reverted. The story survives a refresh and shows the same in a second admin tab: it polls twice a second only while something is actually moving, and the no-polling-by-default rule stands.
