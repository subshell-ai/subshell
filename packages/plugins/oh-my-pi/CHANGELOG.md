# @subshell-ai/plugin-oh-my-pi

## 0.3.1

### Patch Changes

- [#522](https://github.com/subshell-ai/subshell/pull/522) [`533395a`](https://github.com/subshell-ai/subshell/commit/533395aa8bd97b1e8b228c1fa4be112eebab4d49) Thanks [@theogravity](https://github.com/theogravity)! - Oh My Pi subagent rows in the sidebar now switch the parent terminal to the selected child, and the header follows agent changes made inside omp. The selected child's row carries the focus ring instead of the parent. Subagent tooltips render beside the row they explain instead of over the parent above it, and no longer intercept clicks. Clicking a subagent's parent row returns the shared view to the main agent instead of collapsing the child rows.

## 0.3.0

### Minor Changes

- [#519](https://github.com/subshell-ai/subshell/pull/519) [`0bf7e48`](https://github.com/subshell-ai/subshell/commit/0bf7e4801a56914b4bf1c28c8a2edfc635096b13) Thanks [@theogravity](https://github.com/theogravity)! - Web previews list ports a harness reports about its own tooling. The new
  `previews` plugin capability ships a reporter; Oh My Pi watches tool output for
  loopback URLs and reports them, so an agent-started dev server appears in the
  preview picker even when its process runs outside the pane's tree (as omp's
  brokered tool shells do). Only the pane's own key may report, reports carry
  ports rather than hosts, and the rows are transient.

## 0.2.3

### Patch Changes

- [#516](https://github.com/subshell-ai/subshell/pull/516) [`02d787b`](https://github.com/subshell-ai/subshell/commit/02d787bec70ecd8c8b5cf164849f392bf92d55f3) Thanks [@theogravity](https://github.com/theogravity)! - Oh My Pi presets that carry a model-cli provider config now work on every node. Each launch writes a fixed provider module beside the harness config; it reads `MODEL_CLI_OMP_CONFIG` from the pane environment, loads only the shape `model-cli omp` generates, and loads nothing when the variable is absent or the value doesn't match. The config it reads names `MODEL_CLI_OMP_API_KEY` rather than carrying the credential, so no secret is written to a node. A preset's legacy `--extension` path into model-cli's cache is dropped when the launch writes the module, so the pane no longer depends on a file left behind by the host that generated it.

## 0.2.2

### Patch Changes

- [#511](https://github.com/subshell-ai/subshell/pull/511) [`a2119a2`](https://github.com/subshell-ai/subshell/commit/a2119a222d6b5c55745811d091cb7ec9c526252a) Thanks [@theogravity](https://github.com/theogravity)! - Oh My Pi subshells now list their running subagents beneath the parent in the sidebar. Each launch adds a companion extension that reports omp's own subagent lifecycle and progress events, so names, status, and the harness's one-line label appear as they change; opening a child stays with omp's own controls. The sidebar's subsections also sit just inside the machine dropdown instead of 16px inside it, reclaiming 10px for pane names.

## 0.2.1

### Patch Changes

- [#505](https://github.com/subshell-ai/subshell/pull/505) [`55b3644`](https://github.com/subshell-ai/subshell/commit/55b36448a46071b7dca9e92c32cc461cd53c8ade) Thanks [@theogravity](https://github.com/theogravity)! - Harness plugins can now interpret their own terminal title: `parsePaneTitle(raw)` strips the brand, run-state separator, or status glyph a harness writes around the session name. Oh My Pi uses it for `π <state> <label>`, and Claude Code for its cycling status glyph. The control plane keeps only the sanitising every title needs (escape sequences, control bytes, terminal-protocol payloads) instead of knowing either harness's title format.

## 0.2.0

### Minor Changes

- [#446](https://github.com/subshell-ai/subshell/pull/446) [`a1adc0e`](https://github.com/subshell-ai/subshell/commit/a1adc0ebc3d0c137f84b92f08599ba2e3139a843) Thanks [@theogravity](https://github.com/theogravity)! - Add Oh My Pi as a built-in harness, with omp detection, model/provider/thinking settings, and automatic per-launch MCP configuration. Document installation and the integration's session behavior.
