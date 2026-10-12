---
"@internal/server": patch
---

Filter nodes, subshells, prompts, prompt stacks, and workspaces through their HTTP APIs. Debounce text searches by 300 ms, preserve access rules, and refresh filtered subshell results when live changes affect the list. Apply the same behavior to sidebar searches and prompt and subshell pickers.

Show a centered spinner and a descriptive loading message inside dashboard list cards.

Validate search lengths and filter values on the server, with matching browser input limits. Offer retry actions for failed sidebar and picker searches, and keep failure messages distinct from empty results.
