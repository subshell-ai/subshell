---
"@subshell-ai/plugin-api": minor
"@subshell-ai/plugin-claude-code": minor
"@subshell-ai/plugin-codex": minor
"@subshell-ai/plugin-hermes": minor
"@subshell-ai/plugin-opencode": minor
"@subshell-ai/plugin-pi": minor
"@subshell-ai/plugin-terminal": minor
---

The plugin contract speaks **preset**: `ProfileDefinition` is `PresetDefinition`, `BuildCommandInput.profile` is `.preset`, `validateProfile` is `validatePreset`, `profileSettings` is `presetSettings`, and the pure helper is `validateGenericPreset`. Nothing about the launch changed under the names — a preset is the same saved customisation, now optional, and an empty one is what a presetless launch feeds `buildCommand`.

`PLUGIN_API_VERSION` is 2 and a plugin's manifest must declare `"apiVersion": 2`. The loader checks members by name, so a v1 plugin is diagnosed rather than silently accepted: rebuild against this version and rename the members. The six built-in plugins — Terminal included — ship rebuilt in the same release as the server that loads them.
