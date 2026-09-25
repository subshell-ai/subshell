# @internal/website

## 0.1.1

### Patch Changes

- [#189](https://github.com/subshell-ai/subshell/pull/189) [`0c52ccd`](https://github.com/subshell-ai/subshell/commit/0c52ccdc6953fa27e700f7690171d7452779d0f2) Thanks [@theogravity](https://github.com/theogravity)! - The docs wear the brand. The site is dark-only now, painted in the
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

- [#191](https://github.com/subshell-ai/subshell/pull/191) [`0fd469c`](https://github.com/subshell-ai/subshell/commit/0fd469c27c7efc83ce1dc2114caf7a95565ea716) Thanks [@theogravity](https://github.com/theogravity)! - Both sites can be found now, not just read. Each gained a robots.txt
  (everything allowed, sitemap named) and a sitemap.xml (the docs' generated
  from the same page tree the sidebar renders, so it cannot drift; the
  marketing site's one entry is its landing page), and every page declares a
  canonical URL so a `/foo`, `/foo/` or `?utm=` share counts as one page in a
  crawler's index instead of several. The metadata basics (titles,
  descriptions, share card) were already carried; this was the discovery
  layer that pointed crawlers at them.

## 0.1.0

### Minor Changes

- [#162](https://github.com/subshell-ai/subshell/pull/162) [`ce6249d`](https://github.com/subshell-ai/subshell/commit/ce6249dfd6054853b7022dd668ad9d0cee51eefa) Thanks [@theogravity](https://github.com/theogravity)! - Marketing site scaffold: static export at subshell.sh (deploy via website.yml), manifest-driven install section, install-client.sh, releases.json pipeline.
