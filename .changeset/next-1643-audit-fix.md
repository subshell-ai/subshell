---
"@internal/website": patch
"@internal/docs": patch
---

Upgrade Next.js to 16.4.3 on both sites, taking the fixes for three freshly
published advisories: two unauthenticated remote code executions (Image
Optimization with SVG input, `use cache` returning typed arrays) and a Server
Actions denial of service. Retire the two stale entries in the audit allowlist
whose advisories no longer report.
