---
"@internal/server": patch
"@internal/node": patch
---

Harness detection now finds a harness installed through a version manager, says why a binary was not found, and reports when it last looked.

The nvm fix in the previous release never ran: the production entry point suppressed the login-shell rung it added. That rung could not have fixed the case anyway, because nvm initializes in `~/.bashrc` and a non-interactive login shell returns early from it. Detection now globs the version-manager layouts directly (nvm, fnm, n, volta, asdf, mise, pnpm, bun).

A lookup that fails reports `not-on-path` or `override-invalid`, so a mis-set `CLAUDE_PATH` is named instead of being answered with an install command that cannot help. Every entry carries the time it was probed, which is what distinguishes the control-plane host's live probe from an agent's cached inventory on screen.

The version probe is now bounded, and the deadline holds even when the harness leaves a child holding its stdout.
