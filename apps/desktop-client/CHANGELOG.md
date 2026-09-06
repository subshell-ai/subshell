# @internal/desktop-client

## 0.1.0

### Minor Changes

- [`c694cdd`](https://github.com/subshell-ai/subshell/commit/c694cddf53a186a11c1e5e4e82e137fcfc6e149a) Thanks [@theogravity](https://github.com/theogravity)! - **Subshell Node** — a desktop app that registers this machine as a node.
  
  Paste a control plane's URL and a setup key and the app installs the agent it
  ships, enrols, registers a background service, and shows what the node is
  doing — no CLI, no `curl | bash`.
  
  It ships the `subshell` agent inside it, so nothing is downloaded on first run,
  and it installs that agent to `~/.local/bin/subshell` rather than running it
  from inside the bundle: a service points at an absolute path, and a path inside
  an app bundle breaks the moment the app is moved or replaced.
  
  Available for macOS (Apple silicon, signed and notarized) and Linux x86_64
  (`.deb`, Ubuntu 24.04+ / Debian 13+).
