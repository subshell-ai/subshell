---
"@internal/server": minor
"@subshell-ai/plugin-claude-code": minor
"@subshell-ai/plugin-codex": minor
"@subshell-ai/plugin-hermes": minor
"@subshell-ai/plugin-opencode": minor
"@subshell-ai/plugin-pi": minor
"@subshell-ai/plugin-terminal": minor
"@subshell-ai/plugin-api": minor
---

Harnesses show their real marks instead of an emoji. `subshell.icon` now names
an image file inside the plugin package rather than a glyph, each built-in
ships its vendor's own logo, and the control plane serves it at
`GET /api/plugins/<id>/icon`. A plugin that declares no icon renders a
monogram. The mark shows wherever a harness is listed: first-run setup, the
agent picker, Settings → Plugins (installed and catalog alike) and a node's
harness list.
