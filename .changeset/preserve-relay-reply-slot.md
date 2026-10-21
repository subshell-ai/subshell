---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Keep a failed SSH-agent request pending until its genuine reply is discarded after a forged reply is rejected, so a later connection cannot receive the earlier request’s response.
