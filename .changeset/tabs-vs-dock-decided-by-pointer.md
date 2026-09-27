---
"@internal/server": patch
---

Workspace tabs now stay draggable in narrow desktop windows. The page chose its presentation by width alone, so a window under the tiling breakpoint in CSS pixels (HiDPI scaling, browser zoom, a deliberately small window) got the phone's tap-only strip. It now asks `useIsPhoneLayout`, which is touch-primary AND narrow, the rule the detail header already used. A phone keeps the strip; a mouse keeps the dock at any width.
