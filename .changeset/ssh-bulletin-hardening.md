---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Keep SSH setup keys out of subprocess arguments, require stdin-capable connecting nodes, and refuse older downloaded node binaries before passing credentials. Bound retained terminal resize work during sustained updates and document the SSH security bulletin review.
