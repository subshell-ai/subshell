---
"@internal/server": patch
"@internal/node": patch
"@internal/docs": patch
---

Separate virtual display providers from viewer connections and launch settings. Add a per-node Display provider selector, with Xvfb + VNC as the initial option. Check requirements for the selected provider and preserve existing displays when the selection changes.
