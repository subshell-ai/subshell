---
"@internal/server": patch
---

`subshell-server` now offers to install tmux instead of just refusing.

When `init`/`configure`/`service install` run on an interactive terminal and
tmux is missing, the CLI proposes the install (brew on macOS; `sudo
apt-get`/`dnf install tmux` on Linux), shows the exact command, and — on
yes — runs it with your own terminal attached (you watch brew/apt work and
answer any sudo prompt yourself), then CONTINUES the original command. No
rerun needed.

Nothing else changes: `--yes`, non-TTY runs (CI/scripts), a declined answer,
or a host without a supported installer all get the previous refuse-with-hint
behavior verbatim, and `SUBSHELL_SERVER_SKIP_TMUX_CHECK=1` still short-circuits
the whole preflight.
