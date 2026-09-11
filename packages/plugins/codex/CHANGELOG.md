# @subshell-ai/plugin-codex

## 0.1.0

### Minor Changes

- [`8cc452a`](https://github.com/subshell-ai/subshell/commit/8cc452a1085debece9d0b1a27080ff037330880a) Thanks [@theogravity](https://github.com/theogravity)! - The five built-in harnesses are plugin packages behind a published contract, and that contract's resume member is now pure.
  
  Nothing changes for a user: the same five harnesses are detected, launched and configured exactly as before, and parity is pinned by tests comparing each plugin's argv against the argv the class it replaced would have built. `@subshell-ai/plugin-api` is the contract a third party builds against; `packages/pane-runtime` holds no plugin classes, it loads them. A plugin cannot import anything of ours: everything reaches it through a `PluginHost` passed to the factory it default-exports, and a plugin's own build inlines `plugin-api`. Identity lives in the package's `package.json` under `subshell`, so listing and detection read data. One behaviour that was nearly lost is explicit in the contract: Hermes prints a version banner rather than a bare version, so a plugin can declare `parseVersion` to interpret its own probe output; the host owns the timeout.
  
  **Breaking:** `HarnessResume` no longer does I/O. `canResume(sessionId, cwd)` becomes `resumePath(sessionId, cwd, hostEnv)`, a PURE computation of where the resumable transcript WOULD be on the target machine, given a `HostEnv` (that machine's `homeDir` plus the values of the environment variables the plugin's manifest declares in the new `subshell.hostEnv` list; claude-code declares `CLAUDE_CONFIG_DIR`). The plugin answers "where", the HOST answers "is it there" — so the same plugin code computes the path whether the pane runs on the control-plane host or a remote node. A manifest naming the wrong variable is the documented landmine: it fails silently, as a resume that never offers itself, and the claude-code suite pins that as a permanent test.
  
  `@subshell-ai/plugin-api` is PUBLISHED, so this is a breaking change to a public contract, and it is taken deliberately: the package has been public for one day and nothing depends on it yet except these built-ins. Only claude-code implements `resume`, so only claude-code takes a major.
