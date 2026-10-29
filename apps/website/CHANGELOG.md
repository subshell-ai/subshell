# @internal/website

## 0.2.21

### Patch Changes

- [#470](https://github.com/subshell-ai/subshell/pull/470) [`f296876`](https://github.com/subshell-ai/subshell/commit/f296876e3a1d36a7464832fa2f948653fb1c0132) Thanks [@theogravity](https://github.com/theogravity)! - Add an explicit per-service option to ignore HTTPS certificate validation for trusted services with self-signed or mismatched certificates. Keep validation enabled by default and show when a saved service opts out. Web previews no longer show unrelated virtual-display warnings.
  
  Keep the preview icon neutral until discovery finds a live item the viewer can select.
  
  Configure discovered apps in a second step, optionally save them by name, and edit custom services with the same options. Add an explicit browser-only sandbox opt-out with a gold explanation of the account access it grants.
  
  Refresh the documentation and website alongside the app release.
  
  Add explicit Ctrl+Home and Ctrl+End mobile controls for conversation jumps in Codex, alongside ordinary Home and End.

## 0.2.20

### Patch Changes

- [#465](https://github.com/subshell-ai/subshell/pull/465) [`dbfb32e`](https://github.com/subshell-ai/subshell/commit/dbfb32eff2e2ae6b5233d8cfe6b1cfd68a58443d) Thanks [@theogravity](https://github.com/theogravity)! - Add a virtual-display section to the website with a screenshot and Linux and macOS setup links. Refresh the display screenshot in the guide, and show SSH owner-only restrictions in gold like other node settings.
  
  Refresh the website-preview recording with a neutral demo path.
  
  Keep the phone demo at the same size when switching to the wider website layout.

## 0.2.19

### Patch Changes

- [#426](https://github.com/subshell-ai/subshell/pull/426) [`cec0b06`](https://github.com/subshell-ai/subshell/commit/cec0b06e3943cf3ef9270e0b6ae651ec2717d661) Thanks [@theogravity](https://github.com/theogravity)! - Name the dashboard entry point Apps & screens and its picker Open app or screen, with matching setup guidance and documentation. Keep API and MCP identifiers stable. Simplify the website demonstration and support private development hostnames through local environment settings.

- [#426](https://github.com/subshell-ai/subshell/pull/426) [`cec0b06`](https://github.com/subshell-ai/subshell/commit/cec0b06e3943cf3ef9270e0b6ae651ec2717d661) Thanks [@theogravity](https://github.com/theogravity)! - Update Zod to 4.6.7 and override Expo CLI’s older Zod dependency to remove the vulnerable version from the dependency tree.

- [#426](https://github.com/subshell-ai/subshell/pull/426) [`cec0b06`](https://github.com/subshell-ai/subshell/commit/cec0b06e3943cf3ef9270e0b6ae651ec2717d661) Thanks [@theogravity](https://github.com/theogravity)! - Add a website preview demonstration directly below the mobile video, showing a real coding agent fixing project filters and checking the result beside its terminal.

## 0.2.18

### Patch Changes

- [#427](https://github.com/subshell-ai/subshell/pull/427) [`2b4c02b`](https://github.com/subshell-ai/subshell/commit/2b4c02ba32b08a557854e3d908b6beded8fd754e) Thanks [@theogravity](https://github.com/theogravity)! - Upgrade Next.js to 16.4.3 on both sites, taking the fixes for three freshly
  published advisories: two unauthenticated remote code executions (Image
  Optimization with SVG input, `use cache` returning typed arrays) and a Server
  Actions denial of service. Retire the two stale entries in the audit allowlist
  whose advisories no longer report.

- [#430](https://github.com/subshell-ai/subshell/pull/430) [`b1d5fee`](https://github.com/subshell-ai/subshell/commit/b1d5fee2fbaf992d8f64bb4ef430bc05e8976045) Thanks [@theogravity](https://github.com/theogravity)! - Updated zod to 4.6.6, including a root override that moves every transitive 4.x copy onto it. This picks up the fix for a high-severity advisory where validating an oversized constrained collection could exhaust memory (GHSA-mrhx-c7xc-m3w5).

## 0.2.17

### Patch Changes

- [#410](https://github.com/subshell-ai/subshell/pull/410) [`42a68e3`](https://github.com/subshell-ai/subshell/commit/42a68e35b379781ba2f28093d27b4d4b55779d7a) Thanks [@theogravity](https://github.com/theogravity)! - Refresh the desktop and phone demonstrations, posters, and feature screenshots for the sidebar bottom bar and current workspace layout.

## 0.2.16

### Patch Changes

- [#397](https://github.com/subshell-ai/subshell/pull/397) [`a21df83`](https://github.com/subshell-ai/subshell/commit/a21df83fd3db184750403e0a0fc566a87ede4d7e) Thanks [@theogravity](https://github.com/theogravity)! - Refresh navigation, workspace, launch, and account instructions for the contextual sidebar. Add a navigation guide, retain the original homepage sections with updated product screenshots, and replace screenshots with captures of the current interface. Replace the desktop and phone demo recordings, posters, and README animation.

- [#398](https://github.com/subshell-ai/subshell/pull/398) [`d622470`](https://github.com/subshell-ai/subshell/commit/d622470349c12c79b2073a96fa992044e70dcf74) Thanks [@theogravity](https://github.com/theogravity)! - Refresh website videos, posters, documentation screenshots, and the README animation for the unified workspace sidebar. Show real agent work and moving a running subshell between the sidebar sections, and update navigation copy to match the current controls.

## 0.2.15

### Patch Changes

- [#388](https://github.com/subshell-ai/subshell/pull/388) [`e465fc1`](https://github.com/subshell-ai/subshell/commit/e465fc1f591f8fff7f78811f209c1a9d111997e7) Thanks [@theogravity](https://github.com/theogravity)! - Show SSH port forwarding on the homepage with a new connection-panel screenshot, and refresh the sharing screenshot with permission dropdowns and recipient search.

## 0.2.14

### Patch Changes

- [#386](https://github.com/subshell-ai/subshell/pull/386) [`2013aed`](https://github.com/subshell-ai/subshell/commit/2013aedc387322d823a119a00f63651e9b5c2efa) Thanks [@theogravity](https://github.com/theogravity)! - Add an SSH feature section describing remote shells, authentication options, and saved connection presets.

## 0.2.13

### Patch Changes

- [#384](https://github.com/subshell-ai/subshell/pull/384) [`448a3c2`](https://github.com/subshell-ai/subshell/commit/448a3c2c1111aab321b7282a10f1819e323d3c4d) Thanks [@theogravity](https://github.com/theogravity)! - Replace feature screenshots with sharp, lossless captures and consistent product-colored frames.

## 0.2.12

### Patch Changes

- [#379](https://github.com/subshell-ai/subshell/pull/379) [`db33a2d`](https://github.com/subshell-ai/subshell/commit/db33a2dc1a8a3cd1717033bad7b8898cf0740d57) Thanks [@theogravity](https://github.com/theogravity)! - Refresh product screenshots to match the current interface and remove unused screenshots of earlier designs.

## 0.2.11

### Patch Changes

- [#362](https://github.com/subshell-ai/subshell/pull/362) [`c05eb71`](https://github.com/subshell-ai/subshell/commit/c05eb71d10ad42a189166c07e965d826a954cea9) Thanks [@theogravity](https://github.com/theogravity)! - Clarify the website’s workspace, sharing, installation, and hosting copy, and use subshell terminology consistently.

## 0.2.10

### Patch Changes

- [#360](https://github.com/subshell-ai/subshell/pull/360) [`814194d`](https://github.com/subshell-ai/subshell/commit/814194dd8e281ebeb354ff136101b37c5767a3c1) Thanks [@theogravity](https://github.com/theogravity)! - Make CLI help, installer messages, desktop menus and dialogs, notifications, and MCP tool descriptions easier to follow. Clarify command timeouts and agent cleanup, refresh README wording, and align documentation with current interface labels.

- [#360](https://github.com/subshell-ai/subshell/pull/360) [`814194d`](https://github.com/subshell-ai/subshell/commit/814194dd8e281ebeb354ff136101b37c5767a3c1) Thanks [@theogravity](https://github.com/theogravity)! - Make setup, settings, status messages, and website documentation clearer and more conversational. Simplify technical explanations, use active voice and natural contractions, and update outdated navigation references while preserving security warnings and operational details.
  
  Align public maintenance, restart, node recovery, and prompt-stack guides with the current interface, and clarify website sharing and prompt explanations.

## 0.2.9

### Patch Changes

- Serve the Proxmox server helper that trims and prunes around updates (lvm-thin containers could fill their thin volume silently and fail an update with "no space left on device"), defaults new server containers to 40 GB, and explains a failed pull with the disk's state and the remedies.

## 0.2.8

### Patch Changes

- Display marketing screenshots without links or hover effects.

## 0.2.7

### Patch Changes

- Replace the marketing site's feature list with detailed sections covering workspaces, reusable prompts and presets, session sharing, running agents on other machines, security, and self-hosting and open source. Include expandable product screenshots and documentation links.

## 0.2.6

### Patch Changes

- [#308](https://github.com/subshell-ai/subshell/pull/308) [`918a52c`](https://github.com/subshell-ai/subshell/commit/918a52c69954f0bbbe3ce0570897394c0d682e15) Thanks [@theogravity](https://github.com/theogravity)! - Show the newly saved address settings instead of startup snapshots, report whether changes applied or need a restart, and enable dashboard restarts for Docker installs explicitly configured with a restart policy. Confirm that restarting Docker closes running subshells.

- [#308](https://github.com/subshell-ai/subshell/pull/308) [`918a52c`](https://github.com/subshell-ai/subshell/commit/918a52c69954f0bbbe3ce0570897394c0d682e15) Thanks [@theogravity](https://github.com/theogravity)! - Fix Proxmox installation with Proxmox-managed template downloads, compatible Debian templates, cluster-wide container IDs, and selection of active container, template, and backup storage. Stop before container creation when template discovery or download fails.
  
  Check anonymous access to the server image before creating a container, and require anonymous pulls in image publishing smoke checks.
  
  Detect and persist the Proxmox container browser address before startup so first-run signup succeeds from another device and remains configured across updates.
  
  Prompt for additional comma-separated browser IPs, domains, and URLs, link to the address documentation and dashboard settings, and increase the server container disk default to 20 GB.

## 0.2.5

### Patch Changes

- [#306](https://github.com/subshell-ai/subshell/pull/306) [`a377e5b`](https://github.com/subshell-ai/subshell/commit/a377e5bb66bfd84c6823f393a2b3353f8746e503) Thanks [@theogravity](https://github.com/theogravity)! - Keep update progress spinners moving with reduced motion enabled. Start visible website demos automatically and reload their lazily attached video sources, while preserving data-saving and manual pause controls.

## 0.2.4

### Patch Changes

- [#305](https://github.com/subshell-ai/subshell/pull/305) [`13e1b3b`](https://github.com/subshell-ai/subshell/commit/13e1b3bf44ae97807dbda33fe9469ae9b5eec1d2) Thanks [@theogravity](https://github.com/theogravity)! - Replace the mobile and desktop product screenshots with compact ten-second recordings switching between real Codex and Claude Code workspace tabs, submitting a prompt and displaying a notification preview, at double pixel density with larger terminal text. Load videos when visible, pause offscreen, and retain posters for reduced-motion and data-saving preferences with playback toggled directly on the video.
  
  Add the wide demonstration to the README as an animated preview linked to the full-quality video.
  
  Clarify website installation labels, retain terminal installation commands for both products, and standardize product terminology, platform descriptions, and license wording.

## 0.2.3

### Patch Changes

- [#273](https://github.com/subshell-ai/subshell/pull/273) [`53c9e33`](https://github.com/subshell-ai/subshell/commit/53c9e339b4fe23029b84d56accc3a9aa40cd5f9b) Thanks [@theogravity](https://github.com/theogravity)! - Docker release image and Proxmox LXC rails: a signed-release GHCR image (tmux + the five harness CLIs, per-install secret minted at first boot), the proxmox-server.sh host helper with install/update verbs, a proxmox-node.sh helper whose container enrolls as a node through the instance's own setup-keyed rail, and an update rail that names the image as the unit of update inside containers (UPDATE_CONTAINERIZED, the containerized deployment fact, and `update --check` reporting it).

## 0.2.2

### Patch Changes

- [#222](https://github.com/subshell-ai/subshell/pull/222) [`512a7cf`](https://github.com/subshell-ai/subshell/commit/512a7cffb3aca50903a133c4c66099afe3519666) Thanks [@theogravity](https://github.com/theogravity)! - Refresh the site's copy of the control-plane install script: subshell.sh serves a build-time copy of the root `install-server.sh`, and that script changed with the terminal-handoff fix (the reattach is gone; `init` acquires its own terminal and prints every non-interactive default), so the published one-liner's bytes must move with it. This bump is what lets `website.yml` mint a fresh `website-v*` tag after the merge; without it the deploy would refuse against the already-published tag.

## 0.2.1

### Patch Changes

- [#220](https://github.com/subshell-ai/subshell/pull/220) [`4b64379`](https://github.com/subshell-ai/subshell/commit/4b64379be3744c7fa843c783e870ce29470134e2) Thanks [@theogravity](https://github.com/theogravity)! - The install one-liners now fetch from the product's own site: `curl -fsSL https://subshell.sh/install-server.sh | bash` (and the client's) replaces the raw.githubusercontent.com URL. The site serves build-time copies of the two root scripts, so the repo root stays the single source; the two root scripts' header comments now print the subshell.sh one-liner too (comment-only, no behavior change).

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
