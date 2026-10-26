---
"@internal/server": patch
"@internal/node": patch
"@internal/docs": patch
---

Recheck live-screen subscriptions when revocation overtakes their permission check. Limit queued writes to preview targets that stop reading, and clean up node resources after uncertain preview-open replies.
