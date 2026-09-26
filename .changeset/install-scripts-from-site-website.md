---
"@internal/website": patch
---

The install one-liners now fetch from the product's own site: `curl -fsSL https://subshell.sh/install-server.sh | bash` (and the client's) replaces the raw.githubusercontent.com URL. The site serves build-time copies of the two root scripts, so the repo root stays the single source; the root files themselves are unchanged.
