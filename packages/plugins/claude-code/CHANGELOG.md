# @subshell-ai/plugin-claude-code

## 3.0.0

### Major Changes

- [#184](https://github.com/subshell-ai/subshell/pull/184) [`711b5fa`](https://github.com/subshell-ai/subshell/commit/711b5fa4e8ab31db801800fc1733b0c370c78e58) Thanks [@theogravity](https://github.com/theogravity)! - Versioned to 3.0.0 in step with the 1.0 launch. These two packages passed
  1.0 before the product line marked it; rather than reach backward they
  take the next major, so every published component is now at 1.0.0 or
  deliberately past it.

### Patch Changes

- [#173](https://github.com/subshell-ai/subshell/pull/173) [`766d4a7`](https://github.com/subshell-ai/subshell/commit/766d4a7b30546c3f03130fe5596eddfc486af3a8) Thanks [@theogravity](https://github.com/theogravity)! - Notifications get quieter. A Stop hook no longer rings "Done, waiting for you" while the session is parked on background work; approval pushes fire only for the notification types that genuinely need a human; a pane pushes at most once until its owner opens it, escalation excepted; and the sidebar dot becomes a bell for exactly as long as a push sits unanswered.

- [#176](https://github.com/subshell-ai/subshell/pull/176) [`db5951a`](https://github.com/subshell-ai/subshell/commit/db5951ae26bbc8cd4ea6a32be3114b84df786396) Thanks [@theogravity](https://github.com/theogravity)! - "Waiting for you" now clears on agent nodes. The only alive-path clearer was the plane's idle watcher, which can only observe a log on the plane's own disk, so a pane running on a node stayed amber from its last Stop or approval until the process died, however hard it worked. Claude Code's hooks now report a third attention kind, `resumed` (prompt submitted, or a tool starting after an approval), and the pane's own report clears the stamp from wherever it runs; it never reads the hook payload and never rings. Rollout: update the nodes FIRST, then the Server. The Server ships the new hook, and an older `subshell` binary rejects `resumed` as an unknown argument with exit 2, which Claude Code reads as a blocking error on every prompt and tool, so a node left behind stalls its panes until it updates. An updated node against an older Server is harmless: the report is a silent no-op there.

## 2.0.0

### Major Changes

- [`f73f29a`](https://github.com/subshell-ai/subshell/commit/f73f29a3ba94c019537b8414e3a36c0662b9cb53) Thanks [@theogravity](https://github.com/theogravity)! - The plugin contract speaks **preset**: `ProfileDefinition` is `PresetDefinition`, `BuildCommandInput.profile` is `.preset`, `validateProfile` is `validatePreset`, `profileSettings` is `presetSettings`, and the pure helper is `validateGenericPreset`. Nothing about the launch changed under the names — a preset is the same saved customisation, now optional, and an empty one is what a presetless launch feeds `buildCommand`.
  
  `PLUGIN_API_VERSION` is 2 and a plugin's manifest should declare `"apiVersion": 2`. The manifest gate accepts 1 and 2, and that is not a compatibility window: the loader checks members by name, so a v1 plugin (the `profile` spelling) is refused at LOAD as missing `validatePreset`, never as silently working. Rebuild against this version and rename the members. The six built-in plugins — Terminal included — ship rebuilt in the same release as the server that loads them.

### Minor Changes

- [`47e340d`](https://github.com/subshell-ai/subshell/commit/47e340dd04355551c5f4b84df03e0247b7e9e99a) Thanks [@theogravity](https://github.com/theogravity)! - Harnesses show their real marks instead of an emoji. `subshell.icon` now names
  an image file inside the plugin package rather than a glyph, each built-in
  ships its vendor's own logo, and the control plane serves it at
  `GET /api/plugins/<id>/icon`. A plugin that declares no icon renders a
  monogram. The mark shows wherever a harness is listed: first-run setup, the
  agent picker, Settings → Plugins (installed and catalog alike) and a node's
  harness list.

## 1.0.1

### Patch Changes

- [`8c7fc57`](https://github.com/subshell-ai/subshell/commit/8c7fc578c1c06185ef2c9538c521ca96b8711946) Thanks [@theogravity](https://github.com/theogravity)! - Ship the licence text, and say where the source is.
  
  Each of these declared `"license": "Apache-2.0"` in its manifest and shipped no
  copy of the terms, so an `npm install` delivered a package whose licence you
  could not read without finding the repository. Apache-2.0 section 4(a) asks for
  a copy of the licence to accompany the work, and `npm publish` is distribution.
  Each package now carries a LICENSE file, and `bun run lint:licenses` fails if a
  published package is missing one.
  
  Each package also declares `repository` (with the `directory` that points at it
  inside the monorepo), `homepage` and `bugs`, so the npm page links to the source,
  the site and the issue tracker instead of showing no link at all. And every
  published version now gets a GitHub Release carrying its own changelog entry —
  the version tags were being pushed with nothing against them.

## 1.0.0

### Major Changes

- [`8cc452a`](https://github.com/subshell-ai/subshell/commit/8cc452a1085debece9d0b1a27080ff037330880a) Thanks [@theogravity](https://github.com/theogravity)! - The five built-in harnesses are plugin packages behind a published contract, and that contract's resume member is now pure.
  
  Nothing changes for a user: the same five harnesses are detected, launched and configured exactly as before, and parity is pinned by tests comparing each plugin's argv against the argv the class it replaced would have built. `@subshell-ai/plugin-api` is the contract a third party builds against; `packages/pane-runtime` holds no plugin classes, it loads them. A plugin cannot import anything of ours: everything reaches it through a `PluginHost` passed to the factory it default-exports, and a plugin's own build inlines `plugin-api`. Identity lives in the package's `package.json` under `subshell`, so listing and detection read data. One behaviour that was nearly lost is explicit in the contract: Hermes prints a version banner rather than a bare version, so a plugin can declare `parseVersion` to interpret its own probe output; the host owns the timeout.
  
  **Breaking:** `HarnessResume` no longer does I/O. `canResume(sessionId, cwd)` becomes `resumePath(sessionId, cwd, hostEnv)`, a PURE computation of where the resumable transcript WOULD be on the target machine, given a `HostEnv` (that machine's `homeDir` plus the values of the environment variables the plugin's manifest declares in the new `subshell.hostEnv` list; claude-code declares `CLAUDE_CONFIG_DIR`). The plugin answers "where", the HOST answers "is it there" — so the same plugin code computes the path whether the pane runs on the control-plane host or a remote node. A manifest naming the wrong variable is the documented landmine: it fails silently, as a resume that never offers itself, and the claude-code suite pins that as a permanent test.
  
  `@subshell-ai/plugin-api` is PUBLISHED, so this is a breaking change to a public contract, and it is taken deliberately: the package has been public for one day and nothing depends on it yet except these built-ins. Only claude-code implements `resume`, so only claude-code takes a major.
