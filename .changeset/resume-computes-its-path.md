---
"@subshell-ai/plugin-api": major
"@subshell-ai/plugin-claude-code": major
"@internal/server": patch
"@internal/node": patch
---

**Breaking:** `HarnessResume` no longer does I/O. `canResume(sessionId, cwd)` becomes `resumePath(sessionId, cwd, hostEnv)`, a PURE computation of where the resumable transcript WOULD be on the target machine, given a `HostEnv` (that machine's `homeDir` plus the values of the environment variables the plugin's manifest declared, in the new `subshell.hostEnv` list; claude-code declares `CLAUDE_CONFIG_DIR`). The plugin answers "where", the HOST answers "is it there".

The control plane now builds the path with the plugin code it holds and asks the node a generalized `path_exists { path }`, renamed from `probe_resume`; the node stats the given path and answers `{ exists }`. So resume works identically whether the pane runs on the control-plane host or a remote node, and the node answers it without loading any plugin code. The node's `ready` event gained `homeDir` and `env`: the values of ONLY the variables installed manifests declared, never the node's whole environment. A manifest naming the wrong variable is the documented landmine: it fails silently as a resume that never offers itself, which the claude-code suite pins as a permanent test.

`@subshell-ai/plugin-api` is PUBLISHED, so this is a breaking change to a public contract, and it is taken deliberately: the package has been public for one day and nothing depends on it yet except these built-ins. Only claude-code implements `resume`, so only claude-code gets a major here.
