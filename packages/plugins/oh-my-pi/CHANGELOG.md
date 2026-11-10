# @subshell-ai/plugin-oh-my-pi

## 0.2.2

### Patch Changes

- [#511](https://github.com/subshell-ai/subshell/pull/511) [`a2119a2`](https://github.com/subshell-ai/subshell/commit/a2119a222d6b5c55745811d091cb7ec9c526252a) Thanks [@theogravity](https://github.com/theogravity)! - Oh My Pi subshells now list their running subagents beneath the parent in the sidebar. Each launch adds a companion extension that reports omp's own subagent lifecycle and progress events, so names, status, and the harness's one-line label appear as they change; opening a child stays with omp's own controls. The sidebar's subsections also sit just inside the machine dropdown instead of 16px inside it, reclaiming 10px for pane names.

## 0.2.1

### Patch Changes

- [#505](https://github.com/subshell-ai/subshell/pull/505) [`55b3644`](https://github.com/subshell-ai/subshell/commit/55b36448a46071b7dca9e92c32cc461cd53c8ade) Thanks [@theogravity](https://github.com/theogravity)! - Harness plugins can now interpret their own terminal title: `parsePaneTitle(raw)` strips the brand, run-state separator, or status glyph a harness writes around the session name. Oh My Pi uses it for `π <state> <label>`, and Claude Code for its cycling status glyph. The control plane keeps only the sanitising every title needs (escape sequences, control bytes, terminal-protocol payloads) instead of knowing either harness's title format.

## 0.2.0

### Minor Changes

- [#446](https://github.com/subshell-ai/subshell/pull/446) [`a1adc0e`](https://github.com/subshell-ai/subshell/commit/a1adc0ebc3d0c137f84b92f08599ba2e3139a843) Thanks [@theogravity](https://github.com/theogravity)! - Add Oh My Pi as a built-in harness, with omp detection, model/provider/thinking settings, and automatic per-launch MCP configuration. Document installation and the integration's session behavior.
