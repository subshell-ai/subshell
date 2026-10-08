---
"@internal/server": minor
"@internal/node": minor
"@internal/subshell-protocol": minor
"@internal/pane-runtime": minor
---

SSH launcher tier: an enabled node can open interactive SSH-terminal panes at any
sshd host. `GET /api/ssh/aliases` and `POST /api/ssh/resolve` answer alias discovery
and `ssh -G` normalization on the connecting machine; `POST /api/ssh/launch` composes
the pane from the approved snapshot (rendered `-F` config, every-hop confinement
policy, host keys trusted `accept-new` in the connecting machine's own
`known_hosts`); saved/recent hosts and a default connecting machine live on the
plane keyed by the resolved destination. SSH-terminal panes accept input from their
owner alone (sharees view). The per-node `ssh_enabled` gate from the previous tier
refuses every one of these doors until the owner turns it on.

Deployment: update the server before the nodes. The link gate is exact-match at
protocol 17, so a lagging agent is held (offline for every purpose but update)
until it crosses the bump on the update command. Nothing changes for anyone until
a node's gate is enabled.

Known limitation: keystrokes typed during the initial ssh handshake can be
swallowed before the remote shell reaches its prompt; the pane is fully usable
once connected.
