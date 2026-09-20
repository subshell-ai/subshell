# @internal/docs

## 0.3.1

### Patch Changes

- [#106](https://github.com/subshell-ai/subshell/pull/106) [`3181b00`](https://github.com/subshell-ai/subshell/commit/3181b001eef9849662ab4aff68000ce9a7602699) Thanks [@theogravity](https://github.com/theogravity)! - Docs follow the Server Settings move: the audit trail is now reached at Settings → Logs → Audit tab and pages 25 events at a time (with its keyset cursor documented), the server's log tail and the debug switch live on the Logs page's System tab rather than Service, and two stale "Settings → Service" pointers (network origins, and the Service row's list of what it owns) now name the pages that actually hold those cards.

## 0.3.0

### Minor Changes

- [#93](https://github.com/subshell-ai/subshell/pull/93) [`b87d11d`](https://github.com/subshell-ai/subshell/commit/b87d11d65de43b44c1495e6317cfd37a17619b4c) Thanks [@theogravity](https://github.com/theogravity)! - The documentation says "node" where it means the node — the daemon that makes a
  machine a node — and keeps "agent" for the harness a subshell runs, which is
  what the word means everywhere else in the product. It also carries the release
  tags' rename to `cli-server-v` / `cli-node-v`.
  
  `/nodes/managing-the-agent` is now `/nodes/managing-a-node`. The old path is
  gone rather than redirected.

## 0.2.0

### Minor Changes

- [`380517c`](https://github.com/subshell-ai/subshell/commit/380517cdebe6f72a05937a5b3c39ab839b18b5a6) Thanks [@theogravity](https://github.com/theogravity)! - The updating pages now teach the signed-releases trust model instead of the retired one: every release carries a signed `release-manifest.json`, every update path verifies the publisher's minisign signature against a key compiled into the product, and install digests come from the signed manifest's `assets` map — never the release host's `.sha256` sidecar. The desktop apps are no longer the lone stronger case; the accounted exceptions (the install one-liners, `--from`, an empty `SUBSHELL_RELEASE_URL`) stay stated.

- [#80](https://github.com/subshell-ai/subshell/pull/80) [`d959af5`](https://github.com/subshell-ai/subshell/commit/d959af54fb17a953f2aed3f48efe9c54e77e27e2) Thanks [@theogravity](https://github.com/theogravity)! - The node pages follow the revamped setup: adding a node asks for nothing on the
  control plane, the machine supplies its own name, and the reveal has two paths — a
  terminal one-liner or the two values the Subshell Client app pastes. The setup-key
  claims that were true under the old design are corrected where they were true no
  longer: a key is not shown once and is not stored as a digest — it is listed in full to
  whoever minted it, for as long as it can still enroll a machine, and the docs say why
  that trade is bounded rather than skipping it. The scripted spelling of the node's name
  (`SUBSHELL_NODE_NAME`, because `curl | bash` has no argv) is documented beside the
  knobs that already worked that way.

## 0.1.0

### Minor Changes

- [#52](https://github.com/subshell-ai/subshell/pull/52) [`72fd88a`](https://github.com/subshell-ai/subshell/commit/72fd88a197944880ff52ccc0f6d9bdb763081983) Thanks [@theogravity](https://github.com/theogravity)! - Docs site content, wave 1: the About group is written — How It Works, Security Model, Subshell vs. Alternatives, Supported Platforms. Also the authoring contract (`apps/docs/AGENTS.md`) and an internal-link check in the content test.

- [#55](https://github.com/subshell-ai/subshell/pull/55) [`f1cdac0`](https://github.com/subshell-ai/subshell/commit/f1cdac0015a875a46d8aa095e80ad3a933919649) Thanks [@theogravity](https://github.com/theogravity)! - Docs site content, wave 4: the Agents group is written — overview, the six built-in harness plugins, the in-page agent-CLI installer, and the plugin registry, all verified against the plugin manifests, the launch pipeline, and the plugin routes rather than the drifted old docs.

- [#62](https://github.com/subshell-ai/subshell/pull/62) [`518de83`](https://github.com/subshell-ai/subshell/commit/518de8327c7a286ccdb7ed2bba88450bf7f08d88) Thanks [@theogravity](https://github.com/theogravity)! - Docs site content, wave 9: the Automation & MCP group is written — the `subshell mcp` server (launch, credentials, per-harness registration, the launch ladder), all thirteen MCP tools transcribed from the registrations, the REST API surface with its typed path and the API Type Surface licence exception, and system API keys as an operator practice — verified against `packages/mcp-core`, the launch and nudge services, the auth guard, and the licence files rather than the drifted old docs.

- [#63](https://github.com/subshell-ai/subshell/pull/63) [`c06b51f`](https://github.com/subshell-ai/subshell/commit/c06b51f9a8a28e8619578d4a9396352b4224b498) Thanks [@theogravity](https://github.com/theogravity)! - Write the Develop group: a contributor-grade Architecture map (component trees refreshed against today's source, the nine invariants with the tests that pin each, extension points and caveats) and real pages for harness plugins, network plugins, the Plugin API, publishing a plugin, and contributing to Subshell.

- [#53](https://github.com/subshell-ai/subshell/pull/53) [`b9688cd`](https://github.com/subshell-ai/subshell/commit/b9688cdabc54585659a0bdce9f41b0062ba48b8a) Thanks [@theogravity](https://github.com/theogravity)! - Docs site content, wave 2: the Get Started group is written — Quickstart, Install the Control Plane, Your First Subshell, and Mobile, verified against the install scripts, the CLI, the setup wizard, the desktop assistant, and the Expo companion rather than the drifted README.

- [#66](https://github.com/subshell-ai/subshell/pull/66) [`c0ecb0d`](https://github.com/subshell-ai/subshell/commit/c0ecb0dbfba1d5839f6d5aacf3e09f2871c59345) Thanks [@theogravity](https://github.com/theogravity)! - Complete the Help group: troubleshooting, FAQ, release notes and support pages, each verified against the code that prints the messages it quotes.

- [#70](https://github.com/subshell-ai/subshell/pull/70) [`589e8f4`](https://github.com/subshell-ai/subshell/commit/589e8f4b811a9b62538ea194dea0ae631e1d157d) Thanks [@theogravity](https://github.com/theogravity)! - Networking & Addresses and the mobile page follow the LAN-address derivation: the allowlist now has four sources, the phone-on-the-Wi-Fi case is configured by nothing, and the `403 "Invalid origin"` page speaks about names — the spellings that still need a trusted-origin entry.

- [#59](https://github.com/subshell-ai/subshell/pull/59) [`0194bf2`](https://github.com/subshell-ai/subshell/commit/0194bf21624dbed735bd4e3bfcb3a4a809398e41) Thanks [@theogravity](https://github.com/theogravity)! - Docs site content, wave 8: the Network Plugins group is written — Overview, Tailscale, Headscale, NetBird, and Cloudflare Tunnel, covering the describe/execute rule, the sudo boundary, record-derived origin trust, and each vendor's join and publish flow as the shipped code performs them.

- [#56](https://github.com/subshell-ai/subshell/pull/56) [`eaf84f1`](https://github.com/subshell-ai/subshell/commit/eaf84f1e7920724b325374418e37a69a655a630d) Thanks [@theogravity](https://github.com/theogravity)! - Docs site content, wave 5: the Nodes group is written — What a Node Is, Adding a Node, Subshell Client as a Node, Sharing a Node, Directory Allowlist, Maintenance Mode, Managing the Agent, and Updating a Node.

- [#65](https://github.com/subshell-ai/subshell/pull/65) [`972a5d5`](https://github.com/subshell-ai/subshell/commit/972a5d59bed41040b8edaeb3876f006c7ed69891) Thanks [@theogravity](https://github.com/theogravity)! - Finish the Reference group: the `subshell-server` and `subshell` CLI pages transcribed from each binary's parser, the environment-variable tables split by server/agent/installer, the full on-disk layout with permissions, the ports and outbound-connection map, version compatibility and the held-connection gates, the node wire protocol (ported from `docs/node-protocol.md`, verified against current code and updated through protocol 10), and the glossary.

- [#60](https://github.com/subshell-ai/subshell/pull/60) [`8957257`](https://github.com/subshell-ai/subshell/commit/89572572f06870029f5a624a01440bc988db20d9) Thanks [@theogravity](https://github.com/theogravity)! - Docs site content, wave 7: the Server administration group is written — Users & Roles, Registration & Enrollment, API Keys, Backups, Updating the Server, Logs & Debugging, and Audit Log. The stub's parked question about the `status` / log-file / service-journal boundary is resolved from the shipped logging code.

- [#58](https://github.com/subshell-ai/subshell/pull/58) [`6cf3a21`](https://github.com/subshell-ai/subshell/commit/6cf3a21d19b64bd5892dbfb3c6fe4210f437af6f) Thanks [@theogravity](https://github.com/theogravity)! - Write the Server group's core pages: overview, headless install, configuration, service, Docker, networking, and reset.

- [#49](https://github.com/subshell-ai/subshell/pull/49) [`99c42c9`](https://github.com/subshell-ai/subshell/commit/99c42c954671753125d9a6cbf1fcf508d08e5200) Thanks [@theogravity](https://github.com/theogravity)! - Scaffold the documentation site: a Fumadocs static export under `apps/docs`, versioned through the changesets version PR and deployed off its `docs-vX.Y.Z` tag by `.github/workflows/docs.yml` to https://docs.subshell.sh (Cloudflare Workers static assets).

- [#54](https://github.com/subshell-ai/subshell/pull/54) [`6183e1e`](https://github.com/subshell-ai/subshell/commit/6183e1ee56bdfb3a630c6a8d56b1c7db4dbb8b60) Thanks [@theogravity](https://github.com/theogravity)! - Docs site content, wave 3: the Use Subshell group is written — subshells, workspaces and panes, sharing, notifications, presets, channels, and devices, grounded in the routes, the manager service, the geometry library, and each plugin manifest rather than the drifted old docs.

### Patch Changes

- [#71](https://github.com/subshell-ai/subshell/pull/71) [`e5c69f2`](https://github.com/subshell-ai/subshell/commit/e5c69f2ffdc33dfcbfcdaf6048ccd5a3c460498b) Thanks [@theogravity](https://github.com/theogravity)! - Fix the three open GitHub issues, all found by fact-checking the docs.
  
  - Manual MCP registration steps (hermes, pi) now show the portable `subshell mcp` PATH command instead of the control plane's own resolved launch ([#57](https://github.com/subshell-ai/subshell/issues/57)). The steps are pasted onto every machine that hosts a pane, and an absolute server path names a program an enrolled node does not have; `subshell` is each node's own binary. The docs' swap-the-path caveat is gone, since the shown command is what to run.
  - headscale's refused-serve advice now matches the shipped origins model: a private network's addresses are trusted while the machine is joined, so the refusal says the plain `http://<name>:<port>` address is already trusted instead of telling the operator to add it ([#61](https://github.com/subshell-ai/subshell/issues/61)).
  - netbird's npm tarball now carries the icon it declares (`files` said `icon.svg`; the file and the manifest both say `icon.png`), so a registry-installed netbird shows its official mark instead of the monogram ([#64](https://github.com/subshell-ai/subshell/issues/64)). headscale and cloudflare-tunnel were carrying the same kind of dead `icon.svg` entry and are cleaned up too; a new pane-runtime test fails on any plugin whose declared icon is not in `files`, or whose `files` names an icon that does not exist.
