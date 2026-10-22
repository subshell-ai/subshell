---
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Verify desktop updates against the signed release manifest as well as the bundle signature. Refuse older or different-app bundles relabeled through update metadata, and check the selected platform's digest before installation.
