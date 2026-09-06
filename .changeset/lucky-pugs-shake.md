---
"@internal/server": minor
---

`service start|stop|restart|status` and `status --json`.

Starting and stopping the server no longer means reaching for `systemctl --user`
or `launchctl` — the CLI drives the per-user service on both platforms, and
`service status` reports what the manager is actually doing (run state, pid,
starts-at-login) rather than only whether a definition exists on disk.

The reason the control verbs live here rather than in a wrapper: each local
subshell's tmux server is a **child** of the service, so a definition written
before the `KillMode=process` / `AbandonProcessGroup=true` fix takes every
running subshell down with it — on stop as much as on restart. `service
restart` refuses on such a host (`--force` overrides), `service stop` warns and
proceeds, and `service status` reports it as `teardown keeps panes`. On Linux
the check asks systemd for the **effective** `KillMode`, so a drop-in under
`subshell-server.service.d/` is seen; a bare `systemctl --user stop` says
nothing about any of this.

`status --json` emits the same facts as the text view for scripts and other
processes. It never carries `BETTER_AUTH_SECRET` in any form — only `set` or
`missing`.

**Behaviour change:** `status` previously ignored unrecognised arguments and
exited 0. It now refuses them with a usage error, so a typo'd `--jsonn` cannot
silently hand a script prose it has no way to parse. Valid invocations still
always exit 0.
