---
"@internal/desktop-client": minor
"@internal/desktop-server": minor
"@internal/server": patch
"@internal/docs": patch
---

Add a **Virtual Displays** section to both desktop assistants' sidebar, shown only where a display helper exists, so the helper is reachable from the window a person is already looking at instead of only from the macOS menu bar. The screen carries the steps the menu item never showed (enable the helper, grant Screen Recording and Accessibility to Subshell Display Helper, and what to do when macOS asks for a restart) above one button that opens the helper's own settings panel and a link to the setup guide. Document the sidebar as the way in.

In the web dashboard, a node that cannot serve previews now says so in gold when the reason is its **Web previews & screens** switch, which an owner can turn on, with a link to the guide that says how; an offline or outdated node stays muted, because no setting fixes that. A launch form, a preset, and the provider list no longer offer a virtual display provider the selected machine's operating system cannot run.
