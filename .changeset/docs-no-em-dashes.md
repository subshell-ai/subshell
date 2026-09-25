---
"@internal/docs": patch
---

No em dashes in the docs (operator ruling, 2026-09-25). The voice rule the UI has carried since 2026-09-21 now extends to the documentation site: prose, headings, frontmatter and callouts carry a comma, a colon, parentheses, or a full stop instead, and the content test fails any page carrying U+2014 so the rule is enforced, not aspirational. The whole content tree was swept (about 1,800 occurrences across 77 pages); en dashes in ranges and hyphens are untouched, and code fences still quote whatever they quote.
