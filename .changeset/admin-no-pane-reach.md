---
"@internal/server": minor
---

Admin accounts no longer see or operate agent panes belonging to other accounts. The list, the single-pane reads, the terminal and the live feed now resolve from ownership and shares alone, for every role alike, so a foreign unshared pane is absent and answers "not found" to an admin exactly as it does to anyone else; admins keep running the instance itself (accounts, settings, plugins, nodes). This reverses the earlier design where admin meant effective read and drive of every pane (operator ruling 2026-10-09). A machine group the node list cannot name now headers "node you can't see" rather than "unknown node", which is what it always meant: a revoked or never-granted share, not a vanished machine.
