# @internal/website

## 0.2.0

### Minor Changes

- [#212](https://github.com/subshell-ai/subshell/pull/212) [`c3cf1d7`](https://github.com/subshell-ai/subshell/commit/c3cf1d775e590f7fa0a1d4c3aa392d50ada6065e) Thanks [@theogravity](https://github.com/theogravity)! - Intel Macs (darwin-x64) are a published target again, for every component. `install-server.sh`, the server-rendered node enroll one-liner, self-update, and the downloads route resolve an Intel host to the `darwin-x64` artifact instead of refusing it by name. The desktop apps publish a second Mac image, `Subshell-<App>-Desktop-<version>-darwin-x64.dmg`, cross-built by `tauri build --target` on the Apple Silicon runner, and `install-client.sh` now installs it on an Intel Mac instead of refusing. The release pipeline cross-builds and exec-smokes CLI binaries under Rosetta; the desktop smoke verifies the bundle's signing chain, the staple, and the nested sidecar's Mach-O slice.
  
  On the marketing site the macOS download button becomes a split control with an Apple silicon / Intel menu. The choice is capability-driven: `releases.json` now carries each desktop release's verified asset list (read from the release's own signed `release-manifest.json`), and the menu appears only when the newest cut actually ships the Intel image. No version numbers are hardcoded anywhere on the page.

## 0.1.4

### Patch Changes

- [#195](https://github.com/subshell-ai/subshell/pull/195) [`97cc590`](https://github.com/subshell-ai/subshell/commit/97cc5908a2a2d82af73ff569644c7df547533b41) Thanks [@theogravity](https://github.com/theogravity)! - Header gains a Docs link to docs.subshell.sh. The install column's buttons now download the release asset for your platform directly instead of linking the release page, and two small headings say which path is the desktop app and which is the CLI (the client's one-liner installs the same app by terminal, and its heading says so).

## 0.1.2

### Patch Changes

- [#192](https://github.com/subshell-ai/subshell/pull/192) [`b326fa2`](https://github.com/subshell-ai/subshell/commit/b326fa2d18f2bdc3387a63690ce6e1dbbef0e3dc) Thanks [@theogravity](https://github.com/theogravity)! - Both sites can be found now, not just read. Each gained a robots.txt
  (everything allowed, sitemap named) and a sitemap.xml (the docs' generated
  from the same page tree the sidebar renders, so it cannot drift; the
  marketing site's one entry is its landing page), and every page declares a
  canonical URL so a `/foo`, `/foo/` or `?utm=` share counts as one page in a
  crawler's index instead of several. The metadata basics (titles,
  descriptions, share card) were already carried; this was the discovery
  layer that pointed crawlers at them.

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
