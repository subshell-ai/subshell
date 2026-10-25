---
"@internal/server": minor
"@internal/node": minor
"@internal/docs": patch
---

Separate node permissions for apps and browsers from virtual displays. Apps and browser features apply to every subshell when enabled; virtual displays still require an explicit launch choice. Preserve existing grants, show feature-specific readiness, and enforce both switches on the server and node.
