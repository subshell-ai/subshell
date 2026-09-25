---
"@internal/docs": patch
"@internal/website": patch
---

The docs wear the brand. The site is dark-only now, painted in the
marketing palette (void, card, frost, orchid), set in the same two faces
(Inter and JetBrains Mono), and its header shows a new lockup: the
wordmark with "docs" after it in shell's own frost, generated from
brand/src/wordmark-docs.svg by the brand pipeline. Both sites also gained
the generated favicon set (mirrored byte-identical from the SPA's icons by
brand:generate, declared in each layout's metadata) and a void-matched
theme-color. And the deploy jobs that had never run found their first bug
before shipping: the Cloudflare deploy steps downloaded only the export,
so wrangler never saw the custom-domain config and demanded a workers.dev
subdomain; they now sparse-checkout the wrangler.jsonc they read.
