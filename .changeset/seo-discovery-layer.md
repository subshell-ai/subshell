---
"@internal/docs": patch
"@internal/website": patch
---

Both sites can be found now, not just read. Each gained a robots.txt
(everything allowed, sitemap named) and a sitemap.xml (the docs' generated
from the same page tree the sidebar renders, so it cannot drift; the
marketing site's one entry is its landing page), and every page declares a
canonical URL so a `/foo`, `/foo/` or `?utm=` share counts as one page in a
crawler's index instead of several. The metadata basics (titles,
descriptions, share card) were already carried; this was the discovery
layer that pointed crawlers at them.
