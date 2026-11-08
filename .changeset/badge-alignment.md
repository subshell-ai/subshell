---
"@internal/server": patch
---

Fixed the count chips sitting at different heights in a pane's header: the preview chip hung off a 14px anchor and the devices chip off a 16px one. Both controls now anchor to the same box, so the badges ride level.
