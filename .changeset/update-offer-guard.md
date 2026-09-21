---
"@internal/server": patch
---

Before ordering a node update, the plane now verifies that the node binary it serves from disk is the release it offers, and refuses with NODE_UPDATE_UNAVAILABLE when a stale artifact is on disk. The refusal names both remedies: republish the binary, or delete it so the next download fetches the verified release.
