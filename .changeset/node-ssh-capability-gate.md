---
"@internal/server": minor
"@internal/node": minor
---

Per-node SSH capability gate: a new ssh_enabled flag (migration 0047) defaults off on every machine including the control-plane host, owners flip it at PUT /api/nodes/:id/ssh-enabled (admins on the server row) audited as node.ssh_enabled.update, the node caches the value in a mirror file it reads only to refuse, and the node protocol bumps to 16 so a pre-update agent is never wire-ambiguous about honoring the gate. The ported foundations (OpenSSH config discovery, ssh -G snapshot resolution, the isolated sshd e2e fixture) land with it; nothing launches SSH yet.
