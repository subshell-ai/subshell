---
"@internal/server": minor
"@internal/client": minor
---

Per-node directory allowlist: restrict where subshells may be created.

A node grants arbitrary command execution under its OS user to anyone who can
launch there, and any node share confers that. A node owner can now say "on
this machine, only under these directories".

- `PUT /api/nodes/:id/allowed-dirs` (owner-only, audited) stores the rules and
  pushes them to the node. **An empty list means unrestricted**, so existing
  nodes are unaffected.
- Enforced twice: the control plane checks the resolved working directory at
  create and restart, and the node checks every launch against a copy it
  persists itself — signing proves who sent a launch, never whether the
  directory is permitted.
- The folder picker is scoped to the rules for anyone who cannot manage the
  node; the owner browses unfiltered, since they browse in order to choose
  what to permit.

**Node protocol v4 → v5, and the agent floor rises to 0.4.0.** The protocol is
matched exactly, so every enrolled node must be updated to this release or it
is refused at connect. Server and client must be released together.
