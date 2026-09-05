---
"@internal/server": minor
---

Add an admin-only Server status page (`/settings/status`) backed by a new
`GET /api/admin/status`.

One read answers "is this instance healthy, and what is it running":

- **Versions** — server, Bun runtime, node protocol, and the minimum agent
  version, plus the enrolled agents that fall below that floor. A refused
  agent otherwise reads as a plain offline node with nothing anywhere saying
  why; this names them and links to each.
- **Runtime** — uptime, memory, host, listen address, SPA source
  (disk vs embedded), database path and size, tmux, resolved MCP entrypoint.
  The last two are badged as failures rather than merely printed: no tmux
  means every local pane launch fails, and an unresolved MCP entrypoint means
  every subshell create 500s, and both stay invisible until a user hits them.
- **Inventory** — users/admins, subshells, nodes, workspaces, profiles,
  channels, counted server-side across every user.
- **Security posture** — registrations, break-glass login, whether the auth
  secret is still the placeholder, and how many system API keys are active.

Cookie-admin only, and bearer keys are refused even when their owner is an
admin. The body carries no secret in any form — the auth secret and the
break-glass password appear as booleans, and a test scans the serialized
response for the real values so a field added later cannot regress that.
