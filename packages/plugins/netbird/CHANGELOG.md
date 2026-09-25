# @subshell-ai/plugin-netbird

## 1.0.0

### Major Changes

- [#184](https://github.com/subshell-ai/subshell/pull/184) [`711b5fa`](https://github.com/subshell-ai/subshell/commit/711b5fa4e8ab31db801800fc1733b0c370c78e58) Thanks [@theogravity](https://github.com/theogravity)! - Marked 1.0.0. Every harness and network plugin still below 1.0 joins the
  product line's first stable release.

### Patch Changes

- [#182](https://github.com/subshell-ai/subshell/pull/182) [`6955725`](https://github.com/subshell-ai/subshell/commit/6955725c3f45d0945adc18dae6234f4b44814fa4) Thanks [@theogravity](https://github.com/theogravity)! - The no-em-dash voice rule applied to shipped copy: every string a person reads on a screen or in a terminal now carries its breath with a comma, colon, parentheses, or a full stop. The tray update item reads "Update available: Subshell Server 0.8.0" (both apps), the node window title "Subshell Client: Node", network plugin hints, both CLIs' refusals and prompts, and the browser-rendered error messages lose their dashes, and so do the /docs endpoint descriptions, the shared MCP tool descriptions, and the desktop apps' permission prose. No wire name, error code, id, or log line changed.

## 0.1.3

### Patch Changes

- [#71](https://github.com/subshell-ai/subshell/pull/71) [`e5c69f2`](https://github.com/subshell-ai/subshell/commit/e5c69f2ffdc33dfcbfcdaf6048ccd5a3c460498b) Thanks [@theogravity](https://github.com/theogravity)! - Fix the three open GitHub issues, all found by fact-checking the docs.
  
  - Manual MCP registration steps (hermes, pi) now show the portable `subshell mcp` PATH command instead of the control plane's own resolved launch ([#57](https://github.com/subshell-ai/subshell/issues/57)). The steps are pasted onto every machine that hosts a pane, and an absolute server path names a program an enrolled node does not have; `subshell` is each node's own binary. The docs' swap-the-path caveat is gone, since the shown command is what to run.
  - headscale's refused-serve advice now matches the shipped origins model: a private network's addresses are trusted while the machine is joined, so the refusal says the plain `http://<name>:<port>` address is already trusted instead of telling the operator to add it ([#61](https://github.com/subshell-ai/subshell/issues/61)).
  - netbird's npm tarball now carries the icon it declares (`files` said `icon.svg`; the file and the manifest both say `icon.png`), so a registry-installed netbird shows its official mark instead of the monogram ([#64](https://github.com/subshell-ai/subshell/issues/64)). headscale and cloudflare-tunnel were carrying the same kind of dead `icon.svg` entry and are cleaned up too; a new pane-runtime test fails on any plugin whose declared icon is not in `files`, or whose `files` names an icon that does not exist.

## 0.1.2

### Patch Changes

- [`79cb1e1`](https://github.com/subshell-ai/subshell/commit/79cb1e1c193e3dda6d5e048f09f29851ad37016d) Thanks [@theogravity](https://github.com/theogravity)! - NetBird's card no longer asks for a management URL
  
  The plugin declared one optional settings field — "Management URL (self-hosted only)" — that only ever fed `netbird up --management-url` at join; after joining, the NetBird daemon owns its own configuration, so the card's copy was a dead input that could disagree with what the machine already says. It is gone, along with the `settings` capability that paired with it: a self-hosted NetBird is set up on the machine (`netbird setup`/`netbird up`), and the card then reflects and publishes what the daemon reports. Hosted SaaS is what a bare join uses, and the setup key is untouched — it is the join credential, not configuration. NetBird cards now show no settings fields anywhere; the joined card's "Change settings" disclosure appears only on plugins that still have them. The plugin ships built in, so the server binary carries the change too.

- [`4a4fc56`](https://github.com/subshell-ai/subshell/commit/4a4fc56193477bc72ae09ceb40eb07415222b676) Thanks [@theogravity](https://github.com/theogravity)! - NetBird's daemon hint no longer asks for a press the card no longer has
  
  "If it is installed, start its service, then re-check." ends "…start its service — this page will notice when you do.": the Re-check button left the network card with the operator's sixth live read, and the page's own poll was always what noticed.

## 0.1.1

### Patch Changes

- [`b68c249`](https://github.com/subshell-ai/subshell/commit/b68c2495e2beea0b470d089dd9ec705f46d669e8) Thanks [@theogravity](https://github.com/theogravity)! - The networking page reads like a form now
  
  Three copy fixes from an operator working through the live Headscale and
  NetBird cards. Each address in the Addresses list leads with its kind label
  above the URL — "NetBird FQDN", then the address — instead of a big bold URL
  with a small muted tag trailing it, which read as two disjoint things. The
  disabled Connect/Sign-in reason now says `Save the Control server URL first.`
  — naming the button that actually delivers the value, and keeping the label's
  own casing so the sentence names the same box the form does. And every
  credential box that can — all four built-ins now do — carries a Docs link
  beside its label, pointing at the vendor page where that key is minted:
  "Auth key" told you what to paste, and nothing on the card said where to get
  one. The link is new manifest data (`labels.credentialDocsUrl`, http(s)
  refused at parse), so third-party network plugins can carry one too.

- [`0799db9`](https://github.com/subshell-ai/subshell/commit/0799db9a6eee4f0a1f272d1b74c31d78f048c150) Thanks [@theogravity](https://github.com/theogravity)! - The README says what joining does now
  
  "Unpublish is therefore a no-op" was true of the plugin's own half and
  misleading about the whole act: joining now records the publish and trusts
  its origins, and the host's unpublish strips them at leave, disable or
  uninstall. Documentation-only; the plugin's code never changed.

- [`f374ad3`](https://github.com/subshell-ai/subshell/commit/f374ad3a1a7a41eedb319323f590d83954dfda41) Thanks [@theogravity](https://github.com/theogravity)! - NetBird's card reads a live daemon, and the publish sentence names its own button
  
  A NetBird that had joined now lists its **NetBird IP** address beside the FQDN.
  The daemon reports that address with its subnet suffix attached —
  `100.71.129.37/16` — and the plugin rejected the whole value rather than reading
  past the slash, so the card showed no IP at all while its own hint told you to
  use the IP address. The prefix now comes off before the address is checked. The
  **Client version** appears for the same reason: the daemon answers it under
  `daemonVersion` (falling back to `cliVersion`), where the plugin had been looking
  for fields guessed before any live NetBird was available.
  
  The nameserver-group hint now names the address it points at — "otherwise use the
  NetBird IP address" — and links to NetBird's own DNS page, because a nameserver
  group is an account-console setting and not something on this machine.
  
  And the sentence above the publish button quotes the button. It used to say
  "publishing is what lets your other devices open this dashboard" whatever the
  button under it read, which on NetBird is **Use this address** — an operator read
  two different words for one act and asked how to publish. The row's own label is
  now that word, so the sentence and the button cannot disagree: "Use this address"
  on NetBird, "Publish with Tailscale Serve" on Tailscale, "Start tunnel" on
  Cloudflare Tunnel.

- [`b36ef5f`](https://github.com/subshell-ai/subshell/commit/b36ef5f7897f361f71bdacbe097a9262423aeea9) Thanks [@theogravity](https://github.com/theogravity)! - Plugin icons: the vendor's own mark, or the letter fallback — never a drawing of ours
  
  NetBird's row now carries NetBird's actual brand mark (from the project's own
  repository), and Tailscale's is its official favicon squircle. Headscale and
  Cloudflare Tunnel shipped placeholder tiles someone had drawn here — a literal
  "N"/"H" indistinguishable from the monogram fallback, and a dot grid that is
  not Tailscale's mark — so the made-up ones are gone: those two rows show their
  letter monogram until an official square mark exists to link to.
