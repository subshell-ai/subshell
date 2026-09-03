---
"@internal/client": patch
---

Reliability: the agent's subshell-meta mirror can no longer be poisoned by a read racing a forget — a per-id generation counter refuses the stale refill, so a forgotten subshell actually reads as gone (this was the watcher tests' historical flake).
