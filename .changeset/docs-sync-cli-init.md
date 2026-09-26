---
"@internal/docs": minor
---

Sync the docs site with the CLI's re-cut first run: `init` owns its terminal (a piped install reattaches to yours), `--yes` answers every question including the tmux install and the `~/.local/bin` PATH write, the tmux preflight aborts with nothing written, macOS gets a Homebrew/MacPorts/Homebrew-bootstrap ladder, and `--verbose` / `SUBSHELL_VERBOSE` raises one run's console to debug.
