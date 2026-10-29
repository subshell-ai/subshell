---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Bound registry downloads, plugin archive decompression, and release metadata before buffering or verification. Refuse named pipes and other nonregular transfer destinations without blocking the node daemon.
