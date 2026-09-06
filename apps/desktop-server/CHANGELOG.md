# @internal/desktop-server

## 0.2.0

### Minor Changes

- [`8168720`](https://github.com/subshell-ai/subshell/commit/816872044ec27192e616e03c6e62604a2063a8a1) Thanks [@theogravity](https://github.com/theogravity)! - Subshell Desktop — a native shell that installs, runs and manages a
  `subshell-server` on this machine, so using Subshell no longer starts with a
  CLI binary.
  
  It bundles the server, installs it to `~/.local/bin` and drives the whole
  lifecycle from a window: configure, install as a service, start, stop and
  restart, with the live-pane refusal surfaced rather than discovered. The app
  window shows the server's own UI at its own origin — so sessions, terminals and
  WebSockets behave exactly as they do in a browser — under a native title bar,
  menu bar and tray, with native notifications when an agent is waiting for you.
  
  macOS (Apple silicon) and Linux (x86_64 `.deb`, Ubuntu 24.04 and newer).
  `tmux` is required on the host: every local pane runs through it.
