---
"@internal/desktop-server": minor
---

The tray's update item opens the update window, signed in or out

Pressing **Check for Updates…** now opens the update screen, which does the
checking and shows the result. It used to run the check in the background and
open nothing — the whole answer landed on the tray item's own label, which the
press had just closed the menu on, so there was no visible response at all and
an update that was found took a second press to reach.

Signed in that was merely awkward: the sidebar says the same thing and its
Update button opens this screen. Signed out there is no sidebar, so the tray
was the only route to updating and it led nowhere. Both labels now open the
same window.

The screen's **Not Now** and **Later** buttons were one button's worth of
meaning in two, so they are now a single **Close**.
