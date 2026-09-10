---
"@internal/server": patch
"@internal/node": patch
---

Harness detection finds a harness installed through a version manager, says why a binary was not found, and reports when it last looked.

The lookup ladder tries the manifest's env override, then PATH, then the manifest's known install locations, then the version-manager layouts: managers that keep versioned bin directories are globbed directly (nvm, fnm, n, newest version first), and managers with a stable one are searched there (volta, asdf, mise, pnpm, bun, yarn). A static list cannot cover the first class, because the directory carries a node VERSION, and nvm initializes in `~/.bashrc`, which a non-interactive login shell returns early from. A login-shell PATH rung stays as the last resort for managers with no predictable layout; it is bounded and cached, and it is the only rung that runs a shell profile.

A lookup that fails reports `not-on-path` or `override-invalid`, so a mis-set `CLAUDE_PATH` is named instead of being answered with an install command that cannot help, and `no-binary` says the plugin declares none. Every entry carries the time it was probed, which is what lets a cached answer be labelled last-known with its age, and what distinguishes the control-plane host (probed live on every read) from an enrolled node (read from the cache) on screen.

The version probe is bounded, and the deadline holds even when the harness leaves a child holding its stdout.
