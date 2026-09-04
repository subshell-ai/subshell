---
"@internal/server": patch
"@internal/client": patch
---

Service restarts no longer kill live panes, and restart-resume follows the pane's CURRENT conversation.

**Keep the panes across a service restart.** The server and the node daemon
spawn each pane's tmux server as a child inside their unit's cgroup, so
systemd's default control-group kill SIGKILLed every live subshell on any
stop/restart (observed 2026-09-01 and again 2026-09-03 when a renamed unit
lost its manual drop-in). Generated systemd units now carry
`KillMode=process` and launchd agents `AbandonProcessGroup` — panes are
stateful daemons the boot reconciler / reconnect census re-adopts. Hosts
already running a generated unit pick this up on the next `service install`.

**SessionStart re-pins the harness conversation.** The claude-code harness
pins the conversation id at launch (`--session-id`); when the pane switched
conversation in-pane (/clear, /resume, /fork) the next restart resurrected
the ORIGINAL launch transcript — a silently stale conversation. A new
SessionStart hook reports the pane's current session id to
`POST /api/subshells/:id/harness-session` (the subshell's own bearer,
self-only like /attention), and restart-resume continues the current one.

**Node-offline precedence on workspace panes.** A docked pane whose agent
node is unreachable now says "Node offline — reconnecting" (the machine is
unreachable; the subshell may still be RUNNING there) instead of rendering a
dead-looking frozen terminal — the pane-surface twin of the precedence the
cards and the detail badge already follow (spec §5.6). Pane rows from
`GET /api/workspaces/:id` gained `subshellNodeId`/`subshellNodeOffline`.
