---
"@internal/server": patch
"@internal/desktop-server": patch
---

Reject untrusted browser origins on cookie-authenticated API requests and terminal WebSocket connections. Prevent an unrelated node from closing an SSH relay by sending an oversized frame with its routing id.

Block self-service API-key reads as well as writes in the auth handler, closing a routing bypass for GET requests.
