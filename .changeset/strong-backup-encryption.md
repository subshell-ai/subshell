---
"@internal/server": patch
"@internal/desktop-server": patch
"@internal/docs": patch
---

Strengthen encrypted backup password derivation to scrypt with 64 MiB of working memory with a 128 MiB scrypt memory allowance and a calibrated CPU work factor targeting about 2–3 seconds on the backup host. Require at least 8 characters consistently in the CLI, browser, and desktop, and explain offline guessing and safe password selection. Reject the unreleased weaker encryption format.
