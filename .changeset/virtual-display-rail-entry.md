---
"@internal/desktop-client": minor
"@internal/desktop-server": minor
"@internal/server": patch
"@internal/node": patch
"@internal/docs": patch
---

Add a **Virtual Displays** section to both desktop assistants' sidebar, shown only where a display helper exists, so the helper is reachable from the window a person is already looking at instead of only from the macOS menu bar. The screen carries the steps the menu item never showed (enable the helper, grant Screen Recording and Accessibility to Subshell Display Helper, and what to do when macOS asks for a restart) above one button that opens the helper's own settings panel and a link to the setup guide. Document the sidebar as the way in.

In the web dashboard, a node that cannot serve previews now says so in gold when the reason is its **Web previews & screens** switch, which an owner can turn on, with a link to the guide that says how; an offline or outdated node stays muted, because no setting fixes that. A launch form, a preset, and the provider list no longer offer a virtual display provider the selected machine's operating system cannot run.

A launch refused over its virtual display now reports the problem beside the **Virtual display** checkbox it belongs to, not under Save as preset. On the machine, the display allocation says which readiness gate stayed shut (the Xvfb socket, the VNC port, or the listener's owner), logs what Xvfb and x11vnc printed before cleaning up, and gives a cold box 10 seconds instead of 5.

The desktop apps' **Open Display Helper settings** control works: the helper's signature check handed `codesign` a bare requirement string, which it read as a file name, so the panel failed to open on every press. (It reached the releases because the code is macOS-only and Linux CI never compiles it.)
