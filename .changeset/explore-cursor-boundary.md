---
"@internal/server": patch
---

The explore endpoint now checks its cursor at the boundary: a malformed or oversized one gets a clear 400 instead of a confusing listing, and a huge-but-legal one simply answers empty. A browse that hits the folder cap now carries a `truncated` flag through the API so callers can say some folders are missing.
