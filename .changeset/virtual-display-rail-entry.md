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

The preview icon in a pane's header now wears a count when the pane has things you could open but have not saved: discovered app ports with no Saved services row, plus the screen and the browser watch when the pane offers them. It is the picker's own data, so the number and the list cannot disagree.

The desktop apps' **Open Display Helper settings** control works: the helper's signature check handed `codesign` a bare requirement string, which it read as a file name, so the panel failed to open on every press. (It reached the releases because the code is macOS-only and Linux CI never compiles it.) Pressing it then opened nothing either: the helper read its own preferences through a `UserDefaults` suite named after its bundle identifier, which Foundation refuses, so the process trapped before any window existed. Both are fixed, and a helper that cannot find its panel now says so instead of showing an empty window.

The panel itself is now the same product as the rest of Subshell: heading, label, body, and detail from the shared palette, gold for what you can still fix and white for what is settled, red for what macOS refused, a live line naming how many people are watching this Mac's screens, help at the bottom left and the exits at the bottom right in one shape, and a window wide enough that nothing wraps away from the label it belongs to. It is a small local page bundled into the helper, so the design system's own checker guards it, and the palette it draws on moved to `packages/assistant/tokens.css` where every surface imports the same one instead of copying it. The menu bar's menu now says it belongs to the Subshell virtual display helper instead of leaving you to guess from an icon, and its **Minimize helper** item follows whether the panel is actually on screen.

Discarding the last virtual display on a Mac also hands the pointer back. A viewer driving that screen leaves the real cursor on a display that no longer exists, which looked like a vanished cursor to whoever was sitting at the machine.
