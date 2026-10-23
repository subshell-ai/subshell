---
"@internal/server": patch
"@internal/node": patch
"@internal/docs": patch
"@internal/website": patch
---

Updated zod to 4.6.6, including a root override that moves every transitive 4.x copy onto it. This picks up the fix for a high-severity advisory where validating an oversized constrained collection could exhaust memory (GHSA-mrhx-c7xc-m3w5).
