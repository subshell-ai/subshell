---
"@subshell-ai/plugin-api": patch
"@subshell-ai/plugin-claude-code": patch
"@subshell-ai/plugin-codex": patch
"@subshell-ai/plugin-hermes": patch
"@subshell-ai/plugin-opencode": patch
"@subshell-ai/plugin-pi": patch
"@subshell-ai/plugin-terminal": patch
---

Ship the Apache-2.0 licence text with every published package.

Each of these declared `"license": "Apache-2.0"` in its manifest and shipped no
copy of the terms, so an `npm install` delivered a package whose licence you
could not read without finding the repository. Apache-2.0 section 4(a) asks for
a copy of the licence to accompany the work, and `npm publish` is distribution.
Each package now carries a LICENSE file, and `bun run lint:licenses` fails if a
published package is missing one.
