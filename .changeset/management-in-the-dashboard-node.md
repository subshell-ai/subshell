---
"@internal/node": minor
---

The agent reports how it runs when it connects — process start time, whether a service manager supervises it, the service state, its config and log paths, the agent binary, and whether tmux is on its PATH — so a headless node's owner can see all of it from the control plane. It also accepts a `restart` command from its control plane, exiting for the service manager to respawn it; a restart is refused unless the manager started this very process, and refused when the service definition would take the node's running panes down with it unless the caller forces it.
