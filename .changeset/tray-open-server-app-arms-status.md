---
"@internal/desktop-server": patch
---

The tray's "Open Server App" no longer flashes. On a running server it was opening the assistant, which handed off to the dashboard and closed itself; it now opens on the standing Status screen and stays. The tray also groups its doors: "Open Control Plane In App" and "Open in Browser" above a divider, "Open Server App" and "Server Addresses" below it. On the Status screen the app's version moved to the top beside the other facts and is joined by the running server's CLI version, and the resolution-rung label under the binary path ("named by the installed service", and its siblings) is gone.
