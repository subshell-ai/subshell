---
"@internal/server": minor
"@internal/desktop-server": minor
---

Agent CLIs are installed by the control plane on an admin's request (`POST /api/setup/agents/:id/install`, built-in ids only, audited), from the setup assistant's Add an Agent screen. Subshell Server no longer carries its own installer table or the `desktop_install_agent` command; its status page points at the dashboard instead.
