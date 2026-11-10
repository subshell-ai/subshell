---
"@internal/server": patch
"@subshell-ai/plugin-oh-my-pi": patch
---

Oh My Pi presets that carry a model-cli provider config now work on every node. Each launch writes a fixed provider module beside the harness config; it reads `MODEL_CLI_OMP_CONFIG` from the pane environment, loads only the shape `model-cli omp` generates, and loads nothing when the variable is absent or the value doesn't match. The config it reads names `MODEL_CLI_OMP_API_KEY` rather than carrying the credential, so no secret is written to a node. A preset's legacy `--extension` path into model-cli's cache is dropped when the launch writes the module, so the pane no longer depends on a file left behind by the host that generated it.
