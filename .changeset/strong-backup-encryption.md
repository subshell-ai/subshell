---
"@internal/server": patch
"@internal/desktop-server": patch
"@internal/docs": patch
---

Strengthen encrypted backup password derivation to scrypt with 128 MiB of working memory. Require at least 15 characters consistently in the CLI, browser, and desktop, and explain offline guessing and safe password selection. Reject the unreleased weaker encryption format.
