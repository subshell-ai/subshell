---
"@internal/desktop-server": patch
---

The tray's "Open Server App" no longer flashes. On a running server it was opening the assistant, which handed off to the dashboard and closed itself; it now opens on the standing Status screen and stays. The tray also groups its doors: "Open Control Plane In App" and "Open in Browser" above a divider, "Open Server App" below it. On the Status screen the app's version moved to the top beside the other facts and is joined by the running server's CLI version, and the resolution-rung label under the binary path ("named by the installed service", and its siblings) is gone. The redundant "Server Addresses" tray item is gone too — the assistant's own rail already carries that screen. And the assistant now says "control plane" wherever it once said "dashboard": the Status button, the ready handoff, the Set Up address row, and the supervision launch option.
