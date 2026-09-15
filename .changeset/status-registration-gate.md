---
"@internal/server": patch
---

Server Settings → Status now reports the effective registration gate. It read the stored setting under an open-by-default fallback, so an instance that had never touched the setting showed an amber "open" in Security posture while the Registration toggle correctly showed "Closed" and every sign-up was refused.
