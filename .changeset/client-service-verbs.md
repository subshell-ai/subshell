---
"@internal/client": minor
---

`subshell service` gains `status`, `start`, `stop` and `restart`, so an agent
can be managed without dropping to `systemctl --user` or `launchctl` — and
`subshell service status --json` reports what the service manager actually
says, including whether the installed definition would survive a restart.

**A restart that would kill live panes is refused.** A node runs its subshells'
tmux servers as children of its own unit, so a definition without
`KillMode=process` (systemd) or `AbandonProcessGroup` (launchd) takes every
running subshell on that machine down with it. Current installs carry both; a
machine that installed an older agent has a stale definition on disk, and the
effective setting is read from the service manager rather than the file, so a
drop-in cannot hide it. `--force` overrides, and `stop` warns and proceeds.

`subshell enroll --json` reports the resulting node id, server URL, name, data
directory and config path. The node key is never included — its only home is
the 0600 config file.
