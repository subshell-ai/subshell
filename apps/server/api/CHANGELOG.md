# @internal/server

## 0.11.0

### Minor Changes

- [#87](https://github.com/subshell-ai/subshell/pull/87) [`7036b3b`](https://github.com/subshell-ai/subshell/commit/7036b3b0725f6f51bd55a730edcbc445cde335f1) Thanks [@theogravity](https://github.com/theogravity)! - Updating, and getting back in when an address change locks you out.
  
  **The update screen is a table you choose from.** It used to push both halves
  of an update whenever either was behind, which was wrong on a machine whose
  `subshell-server` had been updated by hand: the screen offered to install an
  older one. Now each component is a row — what it runs, what it would become,
  and a checkbox where there is something to do or a short reason where there is
  not — with one Force box below for the restart that would take live panes with
  it. It can never install an older server over a newer one.
  
  **A sign-in the server accepted no longer fails silently.** Setting an https
  address for the instance makes its session cookies Secure, which a plain-http
  page cannot keep — so the sign-in worked and the browser dropped it, and the
  form simply came back. The page now says what happened and how to get in.
  
  **The desktop app can reach a server behind a login proxy.** Its window
  follows the sign-in to the identity provider and back; what the page is allowed
  to ask of the app is recomputed for every page it lands on.
  
  **And the app can edit its own addresses.** An https address signs the app's
  own window out for good, and that value could only be changed from the page
  that now needs the session it just lost. The assistant gets a Server Addresses
  screen, reachable from the tray with the server down, stopped, or refusing
  every sign-in.
  
  Also: a pane whose title carries terminal escape sequences is named properly
  instead of showing the raw sequence, and inside Subshell Server the Updates
  page shows the app and the server it ships as one row with one button.

## 0.10.1

### Patch Changes

- [#85](https://github.com/subshell-ai/subshell/pull/85) [`ea83dc8`](https://github.com/subshell-ai/subshell/commit/ea83dc881e1bfdb806951500fdcd5b97f7716ec6) Thanks [@theogravity](https://github.com/theogravity)! - One press updates a desktop app and the CLI it ships.
  
  Each desktop bundle carries the CLI it wraps, so "update the app" and "update
  the server" were never independent — the second was the tail of the first, and
  being asked to do them separately made our packaging your problem. It also
  looped: updating the app left the next launch asking for the server again.
  
  Both apps now have ONE update screen that does both, in two phases across the
  relaunch. A marker written before the restart is finished by the new build at
  boot, so a failure leaves a machine that knows what it was doing rather than a
  half-updated one. Subshell Client's phase 2 additionally **offers the restart
  it used to stay silent about**: installing the agent never stopped the daemon,
  so the machine kept running the previous version with nothing on screen saying
  so.
  
  On Server Settings → Updates, inside Subshell Server the app and the server it
  ships are one row with one control, both version pairs in the real columns, and
  Re-check moved to the card header where its behaviour always was. A browser is
  unchanged — nothing there can install anything on a machine the page is not
  running on.
  
  Also fixes a pane title that could name a subshell after a terminal escape
  sequence: an agent's image-support query arrived in the sidebar as
  `Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA`, because the cleaner removed the two
  characters identifying the text as not a title and kept the rest.

## 0.10.0

### Minor Changes

- [#82](https://github.com/subshell-ai/subshell/pull/82) [`636ad46`](https://github.com/subshell-ai/subshell/commit/636ad462daa81cad41bcda92628c7fe65aaed0a9) Thanks [@theogravity](https://github.com/theogravity)! - Subshell Client's first run asks what you came to do. It used to land on one screen
  whose primary button read **Open**, which persisted the address *and* threw the server's
  dashboard on screen while the setup carried on in the window behind it. Now: Welcome →
  "What would you like to do?" → either **use this machine as a node** (tmux → the
  registration details → how the node runs → a Setting Up… checklist) or **connect to a
  server**. A configured client lands on a client-status screen on every launch
  afterwards, where the dashboard is a button. The rule the whole flow exists for: this
  app never opens the control plane's dashboard by itself.
  
  The details screen says **Continue**, because that press spends nothing; the press that
  installs the agent, enrols and starts the service is on the start-up screen, so that one
  says **Register**. Nothing verifies the server or the key before it — a setup key is
  single-use and `enroll` is the only operation that tests one, and an endpoint answering
  "is this key good?" would be an oracle for guessing them — so the press checks the
  answers' SHAPE and the checklist reports the rest.
  
  A failed registration can be edited and retried. The failed act shows the CLI's own
  words, **Edit details** goes back to the form with the server and name intact and the
  spent key cleared, and a retry with the machine already registered resumes at the
  service act rather than enrolling a second time. Enrolling over a live `config.json`
  mints a second node row and discards the only copy of the node key, so the chain stops
  and asks rather than doing it silently. Every walk screen has a way out, and a client
  that was already configured returns to its status screen rather than to a choice it
  never saw.
  
  The tmux pane is the server's. tmux is a hard requirement for registration, and on a Mac
  with no Homebrew the old screen could only refuse while telling you to run `brew`. It
  now streams the package manager's own output with a clock, and offers Homebrew and
  MacPorts where it cannot install for you. The node agent gained
  `service install --no-autostart` to back the start-up choice — on macOS that is which
  DIRECTORY the plist lives in, since launchd auto-loads only `~/Library/LaunchAgents`, so
  `status`, `start`, `uninstall` and `update` learned to read both places.
  
  A node's harness inventory refreshes itself: when the node comes online, and periodically
  while it stays online. Detection used to fire only on a node-detail page load, a manual
  Re-check, or a launch, so a machine that had just enrolled — or had a CLI installed on it
  afterwards — carried a stale inventory until somebody opened its page.
  
  The agent's log is the one you are shown. It was already capped at 200 KB and replaced
  when full; what diverged was that the desktop revealed launchd's redirect instead, which
  is appended to forever. Both surfaces name the same file now, and the launchd copy is
  0600 rather than world-readable.
  
  Two touch bugs on a phone, in the browser and in the app. A tap on the grid raises the
  keyboard again — xterm 6 focuses its helper textarea only from `mousedown`, and its own
  gesture layer cancels the touch that would produce one, so nothing was ever focused. And
  a flick no longer types `NaN` into the pane: xterm reports momentum frames as wheel
  events without coordinates, and those reports are now dropped on their way out while
  well-formed ones still scroll.
  
  And **Choose an existing agent…** is gone. It pointed at a `subshell` binary, but *agent*
  already means an agent-harness plugin here, so the label offered to choose the wrong
  thing entirely.

- [`de05252`](https://github.com/subshell-ai/subshell/commit/de0525249e1820148d5fae9bc9409e33f12a2d18) Thanks [@theogravity](https://github.com/theogravity)! - Server Settings → Updates is one Components table instead of three cards: the two desktop apps, the Server and every enrolled node now answer the same four columns — name, running, newest, act — and each row states its own blockers, job phases and held-node reasons as detail lines inside the row.

- [#74](https://github.com/subshell-ai/subshell/pull/74) [`a2ebcc3`](https://github.com/subshell-ai/subshell/commit/a2ebcc34e7444ee78fbec9efd0f60d181c3ed232) Thanks [@theogravity](https://github.com/theogravity)! - Inside Subshell Server's window, the sidebar now reports the app's own version under the user panel, with an **Update** action when one is known and a per-version dismiss — desktop-only, and it never installs anything by itself. (spec 2026-09-17-zero-touch-desktop-setup)

- [`9be2954`](https://github.com/subshell-ai/subshell/commit/9be295447629937de3447ec8e1e2b70b00198be3) Thanks [@theogravity](https://github.com/theogravity)! - Server Settings → Networking now owns the Addresses card (moved from Service: port, bind, base URL and trusted origins are the page's own question), and the installed network plugins are grouped into one Networks card instead of a card each.

- [#77](https://github.com/subshell-ai/subshell/pull/77) [`ffca436`](https://github.com/subshell-ai/subshell/commit/ffca43632642776c7ccdc6a6ef3e4278367910cf) Thanks [@theogravity](https://github.com/theogravity)! - Adding a node now lets you PICK the address the new machine dials: step 2 grew the same dropdown the "Subshell for Mobile" dialog has (the instance's trusted addresses, loopback dropped when anything else is known), the chosen one rides to `install.sh` as `server=` and is baked as the agent's permanent `SERVER` — accepted only if the live trusted-origin registry still names it. The amber "APP_BASE_URL points at loopback… replace the host" paragraph is gone: hand-editing the curl host only ever changed where the script downloaded from, never what the node dialed, and the dropdown is the control that sentence was describing. The mobile dialog also drops its two explanatory blurbs — the audience is developers, and both restated the address bar.

- [#80](https://github.com/subshell-ai/subshell/pull/80) [`d959af5`](https://github.com/subshell-ai/subshell/commit/d959af54fb17a953f2aed3f48efe9c54e77e27e2) Thanks [@theogravity](https://github.com/theogravity)! - A node now names itself, on the machine. The Add-node dialog's "Node name" field is
  gone — its text became only the setup key's label, while the node was named by its own
  hostname whatever you typed — so step 1 is one press that mints a key, and the name is
  asked where it can be answered: `subshell setup` asks "Name this node" with the
  hostname prefilled, `--name` answers for a script, `SUBSHELL_NODE_NAME` answers through
  the install pipe, and `subshell enroll` — the primitive that asks nothing — requires
  `--name` outright, as does `setup` under `--yes`, `--json` or no terminal.
  
  The reveal has two paths now, on a **Terminal | Desktop App** switch under the address
  both of them need: the one-liner, or the two values Subshell Client's Enroll step
  actually takes — server address and setup key, each copyable.
  
  And the key is readable again after the dialog closes. The Setup keys card lists each of
  your own keys in full until it is used, expires (24 h) or is revoked, which is why the
  server stores the key itself rather than its SHA-256 digest: an unused key you cannot
  read was a door you could only close. Single-use, owner-scoped, never in the audit log;
  `docs/security.md` accounts for it. The migration drops every outstanding key, so mint
  again after upgrading.
  
  And the cap on that name is counted in ONE unit now. `normalizeNodeName` caps
  CHARACTERS, while a JSON Schema `maxLength` and a DOM `maxlength` count UTF-16 units, so
  enroll's body, rename's body and the rename field each said 64 where the rule says 64
  characters — a machine named with 40 emoji was legal at every door and refused at these
  three. `NODE_NAME_MAX_UNITS` is the unit spelling of the same limit (twice the cap, which
  is the most 64 characters can occupy), and the agent's `--name` preflight and `setup`'s
  prompt count code points like the desktop field and Rust already did, so an emoji name
  measures the same whether it was typed, pasted, prompted for or piped.
  
  And the card now hands back the COMMAND as well as the key. A `Setup` button on each
  usable row opens the same fields the mint dialog shows — address picker, Terminal |
  Desktop App, the one-liner or the two values — because closing the dialog mid-copy still
  lost the command, and re-reading instructions that had never been lost meant minting a
  second single-use key. Rows whose key is spent or expired have no such button; steps for
  an inert credential only end in a 401. The reveal itself moved to
  `node-key-setup.tsx`, shared by both surfaces, and its two explanatory paragraphs are
  gone: the command and the two labelled rows are the instruction. The tabbed group control
  now divides its width between its options instead of leaving the rest of the pill empty.

- [`decd321`](https://github.com/subshell-ai/subshell/commit/decd3211cedd9536c36985202d4f82b1e8d15520) Thanks [@theogravity](https://github.com/theogravity)! - Signed releases: the update paths stop trusting the release source (spec 2026-09-17). Every release now carries `release-manifest.json` plus a detached minisign signature over its exact bytes (`release-manifest.json.sig`), made with the same publisher keypair the desktop apps' updater uses — one key now guards all four components — and every install digests come from the manifest's signed `assets` map instead of the release source's `.sha256` sidecar. `subshell update`, `subshell-server update`, the dashboard's Server and node update flows, and the downloads route's lazy artifact fetch all verify the signature against a pubkey compiled into the product before anything is downloaded or replaced, and an unsigned or unverifiable release is refused by name rather than offered. `update --from` stays signature-free — a file the operator named is their decision.
  
  Node protocol 12: the `update` command carries the verified manifest and its signature, and the agent re-verifies both against its own compiled-in key before swapping, so a node's trust is the publisher's, not its plane's. Agents below protocol 12 are no longer sent update commands at all (they would ignore the new fields); the Nodes and Updates pages say so and name the by-hand verb. Server and agent must ship together: this node release is 0.11.1, one patch above the new `MIN_AGENT_VERSION` floor of 0.11.0. The floor has one consequence a fleet admin will feel: nodes running agents below 0.11.0 are not offered updates at all — each must be updated by hand once on the machine (`subshell update` at its keyboard, or a reinstall) before the page can keep it current from there.
  
  Operator action: `release.yml` now refuses every CLI shard, not just the desktop ones, when `TAURI_SIGNING_PRIVATE_KEY` is unset, and the publish job merges the per-shard manifests into one signed release manifest.

### Patch Changes

- [#81](https://github.com/subshell-ai/subshell/pull/81) [`4500102`](https://github.com/subshell-ai/subshell/commit/45001024030c87d6530423460bc317ba7e3cc844) Thanks [@theogravity](https://github.com/theogravity)! - The Add-node flow is now ONE screen titled **"Install Subshell client"**. The trigger button stays "Add node"; opening it used to land on a first screen whose entire content was one button, and pressing it swapped in the instructions. Now the instructions open immediately and the mint is a **Generate setup key** press between the address picker (labelled **"Select Subshell server address"**) and the Terminal | Desktop App switch. Until the press no key exists, and the screen says so instead of leaving holes: the app path's key row reads "Generate setup key first" and the terminal one-liner shows with `<generate setup key first>` in its token slot and its copy button disabled — the command's shape is the instruction from the start, the placeholder is unmistakable next to real `nsk_` keys, and nothing runnable leaves the page.
  
  The terminal tab is never empty: its one-liner shows from the start with `<generate setup key first>` in the key slot and the copy button disabled until the mint replaces it — the command's shape is the instruction, the placeholder is unmistakable, and nothing runnable leaves the page. The amber no-binary refusal moved into the terminal panel beside the command it refuses, and the first-run-per-platform sentence is gone; nothing sits between the address picker and the button but the button's own failure line.
  
  The Desktop App path also LEADS with getting the app — "First, download the Subshell Client app," linking to the release list filtered to `desktop-client` (never `/releases/latest`: four components share this repo and "latest" is whichever was tagged last) — because the desktop bundles are served by nobody but GitHub Releases and a reader without the app was otherwise at a dead end. Three reveal sentences went the same day: the key-lifetime note (single-use / 24 h is said once, on the Setup keys card), "Waiting for enrollment" (an open dialog that polls IS the waiting), and "it will ask what to call itself" (the machine asks; the dialog says nothing about naming now).

## 0.9.0

### Minor Changes

- [#70](https://github.com/subshell-ai/subshell/pull/70) [`589e8f4`](https://github.com/subshell-ai/subshell/commit/589e8f4b811a9b62538ea194dea0ae631e1d157d) Thanks [@theogravity](https://github.com/theogravity)! - The "Subshell for Mobile" dialog now shows a QR code on a stock install. The server derives its own LAN interface addresses into the trusted-origin allowlist — the kernel's answer for this host, on a wildcard bind only, re-asked whenever the public settings are read, so a laptop that switched Wi-Fi stops offering the network it left — and a phone on the same Wi-Fi signs in at the server's LAN address with no operator act at all. The picker follows: every row it offers is now an address a phone can dial and sign in from, so loopback rows are dropped rather than captioned "this device only", and an instance that truly knows no phone-dialable address says so where the QR would be, with the remedy. `subshell-server configure`'s LAN-bind warning narrows to what it now catches — browsing by a NAME that is not one of the machine's addresses; browsing by IP is automatic. (docs/security.md §8 records the new source and why a literal IP cannot be met by a DNS-rebinding attack; §3's address-list disclosure now includes the LAN addresses.)

### Patch Changes

- [#68](https://github.com/subshell-ai/subshell/pull/68) [`d1f9a20`](https://github.com/subshell-ai/subshell/commit/d1f9a20f8ffe0468aa77d1dafcc9bc4c195be3d1) Thanks [@theogravity](https://github.com/theogravity)! - The first-run wizard gives tmux its own screen — Account, Network, Tmux, Agent, Launch — instead of pinning it as the first row of the agent list, where it read as an agent named tmux under a subtitle promising one screen that needs nothing installed. The step says its own title, shows the found path with a checklist tick, and keeps every affordance the row had: the copyable per-platform command, the Install button only where the server may run it, the installer's own line while it runs, failures on the screen that failed, and a Continue that missing tmux never blocks. Inside Subshell Server the screen is the native assistant's own, so the SPA omits the step there and the dot totals do not move; a `tmux` wizard bookmark read in that shell resolves forward to the Agent step.

- [#71](https://github.com/subshell-ai/subshell/pull/71) [`e5c69f2`](https://github.com/subshell-ai/subshell/commit/e5c69f2ffdc33dfcbfcdaf6048ccd5a3c460498b) Thanks [@theogravity](https://github.com/theogravity)! - Fix the three open GitHub issues, all found by fact-checking the docs.
  
  - Manual MCP registration steps (hermes, pi) now show the portable `subshell mcp` PATH command instead of the control plane's own resolved launch ([#57](https://github.com/subshell-ai/subshell/issues/57)). The steps are pasted onto every machine that hosts a pane, and an absolute server path names a program an enrolled node does not have; `subshell` is each node's own binary. The docs' swap-the-path caveat is gone, since the shown command is what to run.
  - headscale's refused-serve advice now matches the shipped origins model: a private network's addresses are trusted while the machine is joined, so the refusal says the plain `http://<name>:<port>` address is already trusted instead of telling the operator to add it ([#61](https://github.com/subshell-ai/subshell/issues/61)).
  - netbird's npm tarball now carries the icon it declares (`files` said `icon.svg`; the file and the manifest both say `icon.png`), so a registry-installed netbird shows its official mark instead of the monogram ([#64](https://github.com/subshell-ai/subshell/issues/64)). headscale and cloudflare-tunnel were carrying the same kind of dead `icon.svg` entry and are cleaned up too; a new pane-runtime test fails on any plugin whose declared icon is not in `files`, or whose `files` names an icon that does not exist.
- Updated dependencies []:
  - @internal/pane-runtime@1.0.0

## 0.8.0

### Minor Changes

- [`c5ca40e`](https://github.com/subshell-ai/subshell/commit/c5ca40e1b5e84b0dcfded88d377d71995bc21118) Thanks [@theogravity](https://github.com/theogravity)! - Trusted origins are live: a network you join or publish is accepted for sign-in at once, with no restart
  
  The list of addresses a browser may sign in from is now consulted on every request from three sources — this server's own addresses, the operator's `TRUSTED_ORIGINS`, and the addresses each enabled network plugin's daemon reports for this machine — instead of being read once at boot. Joining a tailnet is enough for its addresses to be trusted (a Tailscale IP answers with nothing published), while a Cloudflare Tunnel hostname is trusted only once published, when its Access check is in front of it. Disabling, uninstalling or leaving a network forgets its addresses immediately, and the Networking card can disable and enable a plugin directly.
  
  Network acts no longer write config.env, no longer report `restartRequired`, and their results no longer carry a `config` block (an unpublish or leave still names the origins that stopped being trusted); `TRUSTED_ORIGINS` in config.env is the operator's own extras. Saving that field on Server Settings → Service applies immediately too, and the Service page no longer asks for a restart on its account.
  
  Boot trusts what each plugin's record says before the listener opens, asks each daemon once after the processes are up, and then re-asks every five minutes — so the list is right for people who never open the Networking page.

- [`5bb1f14`](https://github.com/subshell-ai/subshell/commit/5bb1f144a0d4154db990b7403302642649250c84) Thanks [@theogravity](https://github.com/theogravity)! - The dashboard now says how to put Subshell on a phone, and answers the hard half of it
  
  The SPA has been an installable PWA for a while and nothing on any surface said so. A new **Subshell for Mobile** row at the foot of the sidebar's navigation opens a dialog with the install steps for a desktop browser, for iPhone and iPad, and for Android, as a tab group that opens on whichever device is reading it.
  
  The steps are the easy half. The harder one is that the person looking them up is usually at a desk, on an address their phone cannot reach — `localhost` most of the time. So the dialog offers every address this server accepts a sign-in from, ordered with the reachable ones first and the loopback ones listed and labelled "this device only", and encodes the chosen one as a QR code beside a copyable link. Picking a different address re-renders both.
  
  It is honest about what an address costs: over plain `http://` an iPhone still adds the app to the Home Screen, but notifications never arrive there and Chrome offers a shortcut rather than an app — with the remedy named only for someone who can take it. Choosing an address a phone cannot reach replaces the QR with a sentence naming it, so nothing unscannable is ever offered — and on an instance that knows no reachable address at all, which is every stock install, that sentence says so instead.
  
  `GET /api/settings/public` carries a new `trustedOrigins` field to make this possible, which is what the dialog reads. It is a deliberate widening — any signed-in caller now learns this instance's other names — recorded in `docs/security.md` §3.
  
  Two existing surfaces change as a result of the helpers moving into shared code. The loopback check behind the Add-node dialog's "a remote machine cannot dial this address" warning matched `127.` as a string prefix, so it fired on hosts like `127.0.0.1.example.com`, which are somebody else's domain entirely.
  
  And the iOS check behind the notifications card's "use Share → Add to Home Screen first" line now recognises an iPad running iPadOS 13 or later, which requests desktop sites by default and so calls itself a Macintosh — it reports touch points, and no Mac does. That line was previously absent on exactly the devices it was written for.

### Patch Changes

- [`4a4fc56`](https://github.com/subshell-ai/subshell/commit/4a4fc56193477bc72ae09ceb40eb07415222b676) Thanks [@theogravity](https://github.com/theogravity)! - Network cards dropped the Re-check button in every state
  
  Installing a daemon or signing in happens outside this page, and the card answered "how does it find out" with a button that did what the page's poll was already doing every few seconds — the settings page's own "no Refresh button: the page polls" reasoning, contradicted one component away. The operator's sixth live read cut it from every state of both frames (the wizard included); the poll cadences are exactly as they were, and the plugin hints that ordered the press now say the page notices on its own.

- [`79cb1e1`](https://github.com/subshell-ai/subshell/commit/79cb1e1c193e3dda6d5e048f09f29851ad37016d) Thanks [@theogravity](https://github.com/theogravity)! - NetBird's card no longer asks for a management URL
  
  The plugin declared one optional settings field — "Management URL (self-hosted only)" — that only ever fed `netbird up --management-url` at join; after joining, the NetBird daemon owns its own configuration, so the card's copy was a dead input that could disagree with what the machine already says. It is gone, along with the `settings` capability that paired with it: a self-hosted NetBird is set up on the machine (`netbird setup`/`netbird up`), and the card then reflects and publishes what the daemon reports. Hosted SaaS is what a bare join uses, and the setup key is untouched — it is the join credential, not configuration. NetBird cards now show no settings fields anywhere; the joined card's "Change settings" disclosure appears only on plugins that still have them. The plugin ships built in, so the server binary carries the change too.

- [`5ad46b2`](https://github.com/subshell-ai/subshell/commit/5ad46b25983fcea75f850344d48ba4f678e2c999) Thanks [@theogravity](https://github.com/theogravity)! - The account menu grows a way to tell us about the thing
  
  A new **Feedback** item sits above **About Subshell** in the user menu and links to this project's GitHub issue list — the place Subshell feedback actually lands. It is an ordinary new-tab link, so in Subshell Server's and Subshell Client's windows the existing bridge hands it to the system browser rather than dead-ending in the webview.
- Updated dependencies []:
  - @internal/pane-runtime@1.0.0

## 0.7.2

### Patch Changes

- [`0799db9`](https://github.com/subshell-ai/subshell/commit/0799db9a6eee4f0a1f272d1b74c31d78f048c150) Thanks [@theogravity](https://github.com/theogravity)! - Trusted origins now have the lifecycle of the publish that added them, and the restart that lands a change can be taken from the result that needs it
  
  Publishing already added its addresses to `TRUSTED_ORIGINS`; unpublishing now takes exactly those back through the same config writer — origins no publish ever matched survive every cycle — the subtraction is by value, so a hand-added entry equal to a published address leaves with it, and a key the server's environment owns is refused by name while the unpublish itself completes. No kind is exempt: a NetBird unpublish clears its record and takes its origins back too — after a disable the daemon may still answer at its address, and what changes is that the address stops accepting sign-ins when the restart lands, the stated and chosen cost of letting a publish own an origin's lifecycle.
  
  Network plugin manifests that pair `publishImplicit: true` with a non-`private` exposure are now refused at load: implicit publishing means the JOIN records and trusts the addresses with no press to warn at, and that is only sound on a network whose addresses cannot reach the open internet.
  
  Joining NetBird now completes the whole path to "other devices can open this dashboard" in one press plus one confirmation: the join itself records the publish and widens `TRUSTED_ORIGINS` through that same writer, so the separate box under "Publish" is gone — the rare gap where the address table never settled still shows a single line and the press.
  
  And where a publish or unpublish ends with `restartRequired`, the card's result offers the Service page's own restart button and confirmation — the one that names what it costs running subshells — locks the card's acts while the server is out, and refetches the row and the public settings the moment it is back.

- [`2da286d`](https://github.com/subshell-ai/subshell/commit/2da286d9ea9156c38cc36584838878c68ea7279f) Thanks [@theogravity](https://github.com/theogravity)! - The Networking page now prints the server's own address, and the chips legend is gone
  
  The base URL is one value, so the page that lists the network cards now
  states it: the address the server is RUNNING as and which network's published
  address it is ("http://… — over Tailscale"). The value is written on Server
  Settings → Service; when a saved change is newer than the running one, the
  line names the pending address and its network as awaiting the restart,
  because APP_BASE_URL is read at boot — the saved value is not the live one
  until then.
  
  The "Joined means… Published means…" sentence above the network lists is
  removed; the cards and the publish section now carry that difference where
  the states actually appear.

- [`844ceb2`](https://github.com/subshell-ai/subshell/commit/844ceb2b6a3d1853fa237036ff5a8b795f2792ab) Thanks [@theogravity](https://github.com/theogravity)! - The first-run Network step now sets its way-round in the control-label weight
  
  "You can set it up later under **Settings → Networking**" — the destination a
  person should remember when they skip is the one place in the sentence that
  now reads as a pointer rather than as prose. `SetupAssistant`'s subtitle
  takes markup, which is what `PageHeader`'s already did.

- [`dbccc29`](https://github.com/subshell-ai/subshell/commit/dbccc29d411a519039d15197b08c9d063fa892f3) Thanks [@theogravity](https://github.com/theogravity)! - Cloudflare Tunnel: publish this server on a hostname you own, behind Cloudflare Access
  
  The third network plugin for Settings → Networking, and the first built-in to
  actually use the `supervise` and `guard` capabilities — the supervisor that
  holds a plugin's long-running child, and the Access front door that refuses
  every request whose Host names the tunnel hostname without a valid assertion,
  both shipped by phase 1 and unexercised until now. `cloudflared` is the one
  connector needing no root anywhere, so this is also the one plugin with an
  Install button the server may press (`brew install cloudflared`, macOS); the
  Linux apt-repo step prints for a human to copy.
  
  The shape is the contract's: joining stores the connector token in the
  write-only secret store and spawns nothing; publishing refuses unless the
  hostname, team domain and AUD are set and a pre-flight at Cloudflare's edge
  confirms an Access application covers the hostname — failing CLOSED, since
  the whole exposure of `public-with-gate` is bounded by that check; and the
  tunnel itself runs as a supervised child, authenticating through its
  `TUNNEL_TOKEN` environment so the credential is never an argv element and
  never visible in `ps`. Unpublish and Disconnect follow the host's existing
  ordering: the process stops first, the guard drops last.
  
  The token is a new credential class at rest, and `subshell-server backup`
  does not include it — the field says so, and after a restore it needs pasting
  again. § 10.5 (cloudflared's `--token-file` version floor, the pre-flight's
  exact status and header shapes) remains UNMEASURED: no live Access team was
  available, so the pre-flight passes only on positive evidence of Access and
  treats every other answer — including a failed check — as a refusal.

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

- [`9756793`](https://github.com/subshell-ai/subshell/commit/975679394759252b016ed68c1d5ae18d1f432239) Thanks [@theogravity](https://github.com/theogravity)! - Network results speak the product, not the config file
  
  The card's green lines used to append what the write changed — ENV-key names concatenated into a success sentence nobody reading it asked for. They now say what the person can do ("Published on Tailscale — your other devices can open this dashboard over it once the server restarts"), removals name the ending rather than a subtraction, and the refused-write notes lead with the outcome and keep the key (`TRUSTED_ORIGINS`, `config.env`) only as a mono pointer naming where the change has to be made instead — because a symptom that names nothing is the defect the original 403 story taught us. Tense is honest throughout: nothing says "can" while a restart is still owed.

- [`295bad3`](https://github.com/subshell-ai/subshell/commit/295bad38588537e863fac33688287d1c252b5c09) Thanks [@theogravity](https://github.com/theogravity)! - A new built-in network plugin: **Headscale**. Settings → Networking gains a row for reaching this server over your own self-hosted tailnet — the same `tailscale` client as the Tailscale plugin, pointed at a control server you run. It asks for the control server URL before it will join, finishes interactive logins with the hint that a Headscale admin must approve the machine, lists `http://` addresses (Headscale tailnets issue no HTTPS certificates, and the page says so), and tries Tailscale Serve for publishing — where the CLI refuses, it says that serve-against-Headscale is unmeasured rather than pretending. Installing it is the same admin act as every plugin: one install arms every node.

- [`2b4060b`](https://github.com/subshell-ai/subshell/commit/2b4060bd864f4f65fa8c01cd1d193b4fa7749ecc) Thanks [@theogravity](https://github.com/theogravity)! - Signing in or pasting a key is now a choice, not a form with two buttons
  
  An operator working through the Headscale card read it backwards, and the card
  was why. The auth key box sat at the top as a big empty field — with Connect and
  "Sign in with Headscale" as two buttons underneath — so the optional path's
  credential looked required, and two buttons side by side looked like related
  steps rather than two exclusive ways to join.
  
  The card now asks which way you mean, using the same segmented control the view
  toggle and the add-subshell dialog use: **Sign in** or **Use auth key** ("Use
  setup key" on NetBird, the vendor's own word lower-cased). Exactly one panel
  shows beneath it, so the thing you did not choose is not on screen — an empty
  box can no longer read as a field you owe somebody. Sign in is the default,
  because the person at this page usually wants the browser flow; a pasted key is
  what an automation or a headless host brings. The choice and what it chooses
  between now sit inside one box, sized to its own labels rather than stretched
  across the card, so it reads as a single question rather than a strip of tabs
  above loose text. Either way the sign-in link and
  its code stay visible below the choice, since they arrive from the network
  whichever panel you were looking at, and a machine with only one way in —
  Cloudflare Tunnel — is offered no fork at all.
  
  The reason a join would be refused ("Save the Control server URL first.") moved
  under the choice, because the server refuses either path while a required
  setting is unset, and both buttons still carry it for a screen reader.

- [`37d73ba`](https://github.com/subshell-ai/subshell/commit/37d73ba2b7a854e7795d1274d40fad989094b3a9) Thanks [@theogravity](https://github.com/theogravity)! - A joined network card leads with what is pending, not with setup fields
  
  The settings fields — a self-hosted network's "Management URL" and its disabled save button — opened every network card, including one whose network had long since joined, above the one press still waiting there. On joined and published rows they now sit behind a "Change settings" disclosure at the bottom of the card, refusal reasons and disabled inputs intact. A row still setting up keeps its fields inline, and a row with a required field unset always shows that field and why it blocks; the first-run wizard is unchanged.

- [`4b2c05e`](https://github.com/subshell-ai/subshell/commit/4b2c05ea9972cd3ff30dd12b0ecbd840f19b53f4) Thanks [@theogravity](https://github.com/theogravity)! - Networking cards read as one system: the join options sit inside one bordered group with the pills hugging their labels, the address rows take the same quiet label-over-value grammar as the other facts on the card, and the design system now names the two label grammars (quiet for read-only data, bold for a control's label and a section heading).

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

- [`af48663`](https://github.com/subshell-ai/subshell/commit/af48663369dd779ba1baa96a712f0172bec639ae) Thanks [@theogravity](https://github.com/theogravity)! - Add the NetBird network plugin
  
  Settings → Networking now offers NetBird beside Tailscale: reach this server
  from your other devices over a NetBird network you already use. It is a second
  `type: "network"` built-in with its own binary and daemon, so nothing about its
  argv or status parsing is shared with Tailscale.
  
  NetBird needs root once to install its service, which the server cannot do from
  a browser — so the install steps are printed to copy (the app or the command-line
  daemon on macOS, the official script on Linux), and there is no install button.
  It has no `needs-privilege` state: once the daemon is installed the CLI
  authorises callers by kernel peer credentials, so the ladder runs from
  not-installed to daemon-down to needs-login.
  
  Publishing runs no command: a NetBird join already makes the machine reachable at
  its WireGuard address, so "Use this address" records the FQDN and peer-IP
  addresses and admits them to the trusted origins. Peer names resolve only if the
  NetBird account has a nameserver group — otherwise use the IP address.
  
  Because that publish leaves nothing the daemon can later be asked about, the
  host records it instead: a NetBird row reads **Published** once it has been
  published, from the host's own record rather than a state the plugin could not
  honestly claim to have seen (the new `publishImplicit` manifest flag says which
  plugins work this way; plugins without it are unaffected).

- [`0fbb9e8`](https://github.com/subshell-ai/subshell/commit/0fbb9e891567aaa35040368ec320bb4518ff9844) Thanks [@theogravity](https://github.com/theogravity)! - The networking cards' publish act becomes a section, and three spacing fixes
  
  A joined network card answered "what is true about this machine" and "press
  this to publish" in one undifferentiated column, and an operator could not
  tell whether publishing was required. It is its own section now — under its
  own heading, below the plugin's cost notes — and it says outright when
  skipping is fine: use of Subshell on this machine only, or at an address the
  server already allows. A published row states its fact without re-asking.
  
  Also: the membership facts keep the fact card's columns (three short strings
  were spending three rows each); every network address is copyable in every
  state, not only published; and address rows, labels, and the sign-in link
  now share one grammar.

- [`f17238e`](https://github.com/subshell-ai/subshell/commit/f17238efc5de634284125ea71772cd5c915ba06e) Thanks [@theogravity](https://github.com/theogravity)! - The publish flow no longer offers to set the server's base URL
  
  One checkbox that moved the passkey rpID turned out to be the most confusing
  control on the Networking page: it sat in a flow about REACHING the server
  while its consequence was about the server's IDENTITY, and every card carried
  its own copy competing for the instance's single `APP_BASE_URL`. Publishing
  now only widens `TRUSTED_ORIGINS`, as it always did. The base URL is set
  where the rest of the server's config is set — Server Settings → Service —
  and that field names the passkey consequence the checkbox buried.

- [`70c7084`](https://github.com/subshell-ai/subshell/commit/70c708431a81d4d4f9ad592aa136f690d1d8af2b) Thanks [@theogravity](https://github.com/theogravity)! - The publish section speaks each network's truth
  
  NetBird has no vendor-side publish — joining already makes its addresses
  answer; the press only records them as how this server is reached. Its joined
  card now says exactly that under an "Other devices" heading, instead of
  borrowing the Serve/tunnel networks' "Publish" framing for a concept its
  vendor does not have.
- Updated dependencies []:
  - @internal/pane-runtime@1.0.0

## 0.7.1

### Patch Changes

- [`189d8df`](https://github.com/subshell-ai/subshell/commit/189d8df7e4d9c80519c8b3d0fb14de719263284c) Thanks [@theogravity](https://github.com/theogravity)! - External links inside the desktop apps' windows open in the system browser
  
  Every `target="_blank"` link the served pages render — the Tailscale card's
  Docs links among them — did nothing when clicked inside Subshell Server or
  Subshell Client. Instrumenting both webview callbacks with a self-clicking
  probe measured where it dies: the click reaches the page's DOM on the right
  anchor, and the webview then raises NOTHING at the app — neither the
  navigation callback nor the new-window callback fires for an anchor click,
  so no native handler can catch it. A `window.open` under the same click DOES
  reach the app's new-window handler, which opens http(s) in the system
  browser (fixed together with this, same spec).
  
  So the page answers its own links when it runs in a desktop shell: a
  capture-phase relay on the document turns a plain left-click on a
  blank-target http(s) anchor into `window.open`, and the native handler stays
  the security boundary — it re-checks the scheme and refuses everything else.
  In an ordinary browser nothing is armed and the links behave as always.

- [`048ca5f`](https://github.com/subshell-ai/subshell/commit/048ca5f23295de937b1abe3ed134c7c581b88659) Thanks [@theogravity](https://github.com/theogravity)! - The network card stops printing its install steps twice, and leads with what is wrong
  
  A `not-installed` Tailscale row rendered the whole install sequence twice —
  "1. Install the Tailscale daemon", "2. Let this server drive it", then the
  sentence explaining the state, then "3. Install the Tailscale daemon",
  "4. Let this server drive it" — with the only sentence that says WHY buried in
  the middle of it, in the same muted grey as a step label.
  
  One cause behind both halves. The install steps live in the plugin's
  `package.json` as data the page renders before any plugin code loads, and the
  plugin ALSO emitted them as status hints; each side was written believing it
  was the only one rendering them. The plugin now contributes the one thing a
  manifest cannot know — which state this machine is in — and the steps are
  rendered once, from the manifest.
  
  That sentence now opens the card as a notice, above the steps it explains,
  rather than below them. Only sentences BEFORE a plugin's first command are
  hoisted: one that follows a plugin's own commands says what to do once they
  are done, and lifting it would state the last instruction first.

- [`7238d30`](https://github.com/subshell-ai/subshell/commit/7238d302e15efad3961ed4b1d5e44f9a7da74ef6) Thanks [@theogravity](https://github.com/theogravity)! - The first-run Network step shows one collapsed row per network, with a Configure button
  
  Every network plugin rendered as a full card on the wizard's Network step,
  split into "networks this machine has" and an "Other networks" disclosure.
  On a fresh install the first group is empty by definition, so the step
  opened on a heading relative to nothing, followed by two numbered sudo
  commands, three Docs links and a Re-check button — for a step whose own
  framing says it is optional.
  
  Each network is now a row in the shape the Add an Agent step already uses:
  icon, name, a state chip ("Not installed", "Not signed in", "Joined",
  "Published", …) and one button. Configure expands the same card the
  Networking settings page renders, in place; Manage once published; Hide
  folds it away. Unsupported and disabled networks show their chip and no
  button.
  
  Two things found on the same screen: a network plugin's icon 404'd because
  the icon route consulted only the harness registry, so Tailscale rendered as
  a "T" monogram; and "Let this server drive it" — the label for Tailscale's
  `--operator` grant — now reads "Allow this server to control Tailscale", in
  the manifest's step, the needs-permission hint and the publish refusal.

- [`152f5ad`](https://github.com/subshell-ai/subshell/commit/152f5adb5e410d680135e4382db32c5e538b045b) Thanks [@theogravity](https://github.com/theogravity)! - Terminating or deleting a subshell now reclaims its tmux socket file
  
  Every subshell owns a tmux server, and tmux does not unlink the socket when
  its last session ends — so each subshell left a 0-byte file in the tmux
  temp directory forever. 737 had accumulated on one developer machine, one per
  subshell since the beginning, alongside ~2,000 more from test runs.
  
  `TmuxRunner.cleanSocket` already existed and was already tested; nothing in
  production had ever called it. Terminate and delete now do.
  
  The reason it was not simply added to the shared kill helper is the reason it
  took a while to be right: a **restart** kills the pane and respawns it on the
  SAME socket, so reclaiming there would unlink a socket a live tmux server is
  about to bind, orphaning the pane. Only the call site knows a kill is final, so
  that is where it lives — and a test pins both directions, including that a
  restart reclaims nothing.
  
  Two gaps stay open and are marked in the code rather than guessed at.
  Subshells on a **remote node** still accumulate a socket each: the file is on
  that machine's disk, and the node cannot tell a restart's `kill` from a
  terminate's without a new frame. A pane that **exits on its own** keeps its
  socket until the row is deleted, which is what delete now covers.

- [`42f1828`](https://github.com/subshell-ai/subshell/commit/42f1828571bd4df0f15606e153a36b36b5fcb9fb) Thanks [@theogravity](https://github.com/theogravity)! - Settings → Networking is collapsed rows too
  
  The page listed every network as a full card, while the wizard's Network
  step — built days earlier — answered the same list with one collapsed row
  per network and a Configure button. Two surfaces, minutes apart, in two
  shapes for one question.
  
  The settings page now uses the same row: name, state chip, one button —
  framed as ONE card per network, like every other card on that page — and
  Configure expands the WHOLE card (every field, the supervisor detail)
  inside the same frame rather than the wizard's stripped flat row and
  smaller card. The row is shared; the frame and the expanded content are
  what each surface deserves.

- [`8ca8b7e`](https://github.com/subshell-ai/subshell/commit/8ca8b7ec41526a418276da8447ac3ab45dfc75f5) Thanks [@theogravity](https://github.com/theogravity)! - The first-run wizard can go back
  
  Every screen rendered a Back slot the frame has always supported, and no screen
  ever filled it — so skipping **Connect a Network** to reach the agent list was
  irreversible short of restarting the wizard, on the one screen most worth a
  second look: it is optional, easy to skip past, and it is where "open this on
  my phone" is answered before a 403 on a sign-in page answers it instead.
  
  Back now goes Add an Agent → Connect a Network, and Start Your First Subshell →
  Add an Agent. It is disabled while an install or a launch is in flight, for the
  reason Continue already was: a `curl … | bash` on this machine must not be
  walked out of in either direction, or its progress line and any failure land on
  a screen nobody is looking at.
  
  There is deliberately no Back from the Network screen to the account screen.
  The wizard advances past it only once sign-up has SUCCEEDED, so that form is
  for an account that already exists.

- [`779badf`](https://github.com/subshell-ai/subshell/commit/779badfc92d80beac19c4d0589a6f569a9d9a410) Thanks [@theogravity](https://github.com/theogravity)! - Reopening the app resumes the first-run wizard where it left off
  
  Closing Subshell Server mid-wizard and reopening it landed on the dashboard.
  The wizard's step lived only in React state, and the one persisted fact —
  "does an account exist" — flips the moment the FIRST screen creates the
  account, so every later step had no record anywhere and the wizard bounced a
  returning visitor to `/`.
  
  A signed-in user now carries a per-user bookmark (`user_meta.setup_step`:
  `network`, `agent` or `launch`, NULL for nobody-but-the-first-admin and for
  anyone who finished). `promoteFirstUserAtomically` writes it in the same
  statement that decides who is admin, so closing the app the instant the
  account exists still resumes on the Network step, and the wizard advances and
  clears it through `GET`/`PATCH /api/setup/progress` — cookie-only, the
  caller's own row. The root shell holds first paint until a signed-in user's
  bookmark reads and keeps them on `/setup` when it names a step; a signed-in
  visitor with no bookmark is still bounced to the dashboard.

- [`a5c9810`](https://github.com/subshell-ai/subshell/commit/a5c9810308afed92f1da95841a6c6fe4de65d5ea) Thanks [@theogravity](https://github.com/theogravity)! - On macOS, Tailscale's card offers the app as the route and the daemon as the alternative
  
  A Mac with nothing installed was told to `brew install --formula tailscale &&
  sudo tailscaled install-system-daemon` and then grant an operator. That is the
  open-source daemon, which Tailscale itself recommends "only for unattended
  installs managed by experienced macOS system administrators", and the card named
  nothing else. Installing the Tailscale app — which most people have or would
  install — did not even clear the row: its CLI lives inside the app bundle and is
  never on PATH unless the person enables the app's CLI integration.
  
  Measured on 2026-09-16, the app's CLI drives `status`, `up`, `serve` and
  `set --operator` with no root and no operator grant, because the app runs as the
  local user and so does this server. Three things follow:
  
  - Detection can name the bundle. A `knownPaths` entry that starts with `/` is
    now used as-is rather than joined onto HOME (which resolved
    `/Applications/Tailscale.app/…` to `$HOME/Applications/…` and silently matched
    nothing), so the app and both Homebrew directories are listed beside the
    HOME-relative one. The node agent shares that lookup and gains the same rule.
  - Every run sets `TAILSCALE_BE_CLI=1`. Run with a bare environment the app's
    binary tries to start the GUI and dies with `Tailscale.CLIError error 3.`; the
    variable is inert for the formula and its wrapper.
  - A privileged step can carry a `group`, which means ALTERNATIVE rather than
    next. The macOS row now prints one heading per route with an `or` between them
    and numbers inside a route only, where a flat 1-2-3 told a person to install
    the app AND the daemon. No other plugin is grouped, so no other row changed.
  
  A dead daemon on macOS now says both routes too, since the plugin cannot tell
  the app from the wrapper, and the two sentences cost less than a wrong guess.
- Updated dependencies []:
  - @internal/pane-runtime@1.0.0

## 0.7.0

### Minor Changes

- [`023d795`](https://github.com/subshell-ai/subshell/commit/023d795a57bfba90430b632844c8b05b1709f658) Thanks [@theogravity](https://github.com/theogravity)! - Connect this server to a private network, from a page instead of a config file
  
  Subshell has always been meant to be reached remotely across a perimeter you
  already own — a VPN, a mesh, a tunnel. Building that perimeter was yours to do,
  and the server only told you about it afterwards, as a `403 Invalid origin` on
  the sign-in page that named nothing you could change. The Add-node dialog's
  advice was "replace the host with this machine's VPN/LAN address".
  
  **Settings → Networking**, and an optional first-run step, now do it. Connect
  the server to a network, publish it there, and the address flows into the
  trusted origins and the enroll command by itself. **Tailscale** ships first:
  paste an auth key or sign in through a link the page shows you, then publish at
  `https://<host>.<tailnet>.ts.net`.
  
  It is a new kind of PLUGIN rather than four integrations wired into the stack,
  so the same store, install door and admin gate that govern agent plugins govern
  these, and anyone can publish one for a network we have not thought of. A
  network plugin describes and the host executes: it returns commands, parses
  their output and names a credential, but never spawns a process, writes a file,
  edits your config or reads a credential back.
  
  Three things it will tell you rather than let you discover:
  
  - **What needs root, and that this server will not do it.** Every mesh VPN
    installs a daemon as root, and the server has no terminal to answer a
    password prompt. Those commands are shown to copy, never run behind a button
    that could only fail. For Tailscale that is the whole install.
  - **What a browser will refuse at each address.** A mesh address over plain
    http is encrypted end to end and still will not do passkeys or `Secure`
    cookies. Publishing adds an address to the trusted origins, which is safe;
    promoting one to the server's base URL moves where passkeys work, which is
    opt-in and says so.
  - **Which networks work on this machine at all.** Support is declared per
    platform, so a row reads "not available on macOS" instead of offering a
    button that returns an error.
  
  Headscale, NetBird and Cloudflare Tunnel follow. Cloudflare will refuse to
  publish until a Cloudflare Access application covers the hostname, and the
  server will verify that assertion itself — it reaches the public internet,
  which the rest of these do not.

- [`5b0e8e0`](https://github.com/subshell-ai/subshell/commit/5b0e8e058a071832305777b66bdc08e87ce54a92) Thanks [@theogravity](https://github.com/theogravity)! - An enrolled node can be updated from the dashboard — including one this server refuses to talk to.
  
  `POST /api/nodes/:id/update` replaces a node's agent binary with the release
  this server can speak to, and restarts it into the new version. Owner or
  `edit`, cookie only, audited.
  
  The part that makes it useful is what happens to a refused agent. An agent
  below the version floor or speaking a different protocol used to be closed
  4406, which left an ordinary-looking offline row and a machine only a shell
  could fix. It is now **held**: the socket stays open, the node stays offline
  for every other purpose, and the plane can still send it the one command that
  repairs it. Node views carry `held` so a page can say which machines are in
  that state and why.
  
  The agent has no REST credential, so the download link carries a single-use
  token good for one file, one platform and ten minutes — rather than widening
  what a node key can do.

- [`80eaa2b`](https://github.com/subshell-ai/subshell/commit/80eaa2bea9c08cda0203014ea0d87a31f17b8009) Thanks [@theogravity](https://github.com/theogravity)! - `subshell-server update` and `subshell-server backup`, and the transaction that makes an update reversible
  
  Until now there was no update path at all for a headless install: nothing ever
  told an operator that a newer server existed, and nothing had ever copied the
  database before running a migration over it. This is the foundation of the one
  described in `docs/superpowers/specs/2026-09-15-updates-design.md` — the server's
  own half; the dashboard, the node half and the desktop apps build on it.
  
  **`subshell-server update`** installs a newer server over this one. It replaces
  the binary the SERVICE DEFINITION names — never a path by convention, because
  writing `~/.local/bin/subshell-server` on a host whose unit points elsewhere is
  an update that reports success and changes nothing. Ten steps and nine of them
  refusals: a checkout (update it with git), an unwritable directory, an empty
  release source, a downgrade without `--force`, a transaction already open, a
  downloaded binary that will not say what it is, and a restart that would close
  every live subshell. `--check --to <version> --from <file> --force --yes --json
  --no-restart --rollback`.
  
  **The new binary finishes or reverts the transaction.** An updater process
  cannot see the future boot, but the booting binary can see the past update — so
  the backup, the `.previous` binary and a marker are written by whoever swaps,
  and consumed by whoever boots. Migrations pass and the server listens: audited
  (`server.update`, actor null), `.previous` and the marker deleted. Migrations
  fail: the database is restored from the backup, the previous binary is renamed
  back, the failure is recorded, and the process exits so the service manager
  brings the old version up on the old database. That last part is not belt and
  braces — Kysely refuses a database carrying migration names it does not know,
  so an old binary cannot boot on a new database at all.
  
  **`subshell-server backup`** takes a snapshot on demand: `VACUUM INTO` a single
  file with no `-wal`/`-shm` beside it, 0600 in a 0700 `<dataDir>/backups/`,
  newest `SUBSHELL_DB_BACKUPS_KEEP` kept (default 5, `0` = keep forever). Every
  update takes one first.
  
  **`status --json` gains `paths.binary`, `paths.backups`, `binary` and
  `backups`** — which file an update would replace and how that was decided, and
  what there is to roll back to. Nothing in TypeScript knew the first of those
  before; only the desktop app's Rust read a service definition.
  
  **`SUBSHELL_NODE_RELEASE_URL` is now `SUBSHELL_RELEASE_URL`,** with no alias:
  the same release list answers for the server's own update, so the name stopped
  being the node agent's. Empty still means air-gapped and still disables every
  network fetch. Every app release now also publishes a `release-manifest.json`,
  and the node release a plane offers is the newest one whose manifest says it
  speaks this server's protocol — not merely the newest above the agent floor,
  which could install an agent the plane cannot talk to.

- [`7206636`](https://github.com/subshell-ai/subshell/commit/72066364b0742d9f25374423a5dd215725ace33e) Thanks [@theogravity](https://github.com/theogravity)! - An admin updates the server from the dashboard, and sees the whole instance's versions in one place
  
  **Server Settings → Updates** is a new page: what this server is running, what
  it could be running, one press to change it, and — beside it — every enrolled
  node and both desktop apps.
  
  The Server card is the one with a button. It runs the same steps
  `subshell-server update` runs, in this process: download the release asset,
  verify the digest the same release published, prove the binary says what it is,
  back up the database, swap with two `rename(2)`s, and exit for the service
  manager. The page follows the job by phase (downloading with its byte count,
  verifying, backing up, installing, restarting), then waits for the server to
  come back — and it is the RETURN that decides the outcome, not the swap: the
  new binary either completes the transaction at boot or reverts it, and the page
  reports "the update to 0.7.0 failed and 0.6.0 was restored" when it reverted.
  
  What it refuses is most of what it does. `POST /api/admin/server/update` is
  cookie-admin only, bearer keys refused, audited with the admin as actor before
  anything starts, and answers 409 for each of: no release source configured,
  nothing supervising this process, a checkout or an unwritable binary, a
  transaction already open (including one a `subshell-server update` opened in a
  terminal), no newer release, a downgrade, and a service definition that would
  close every running subshell — the last being the only one a press can
  override, exactly as the restart dialog's forced path does.
  
  `GET /api/admin/updates` answers the whole page in one read, so the three cards
  cannot disagree about which release list they saw. Node rows report their
  version, platform triple and state; updating one from here arrives with the
  node half of this work, and until then every row says so rather than offering a
  button that does nothing.
  
  The bundled-server offer that lived on Server Settings → Service has moved here
  as a line inside the Server card. "This app ships a newer server" and "the
  release source has a newer server" are two answers to one question, and on two
  pages a person had to choose which to believe.

### Patch Changes

- [`563346b`](https://github.com/subshell-ai/subshell/commit/563346b0b4bbe1c6ed0345fd558ead9cbb808400) Thanks [@theogravity](https://github.com/theogravity)! - The registration gate counts ACCOUNTS, not `user_meta` rows
  
  "Has anybody registered yet" decides three things: whether an absent
  `allow_registrations` row means open, whether `GET /api/setup/status` still
  reports `needsSetup`, and whether the first-run `/api/setup/*` window is
  public. All three counted `user_meta`, which is a ROLE side-table written by a
  separate better-auth `after` hook, rather than the accounts themselves.
  
  Nothing was reopened by this in practice, and the fix is worth describing
  precisely rather than alarmingly. The two tables do diverge on every instance
  — `ensureSystemUser` INSERTs straight into `user` and mints no meta row — but
  that divergence is in the safe direction, so a healthy instance's gate behaved
  correctly. What the old counter could not survive was a REAL account whose meta
  row was missing: it would have read as an empty instance, reopening
  registration and re-publishing the public setup window with no settings row and
  no audit event to show for it. A latent hole, closed before anything grew into
  it.
  
  One counter now answers the question — `UsersRepository.countRealAccounts()`,
  over `user`, excluding the service account, which can never sign in — and the
  registration gate, the setup probe, the boot handoff line and
  `subshell-server status` all read it. `UserMetaRepository.countUsers()` is
  gone; a second "how many users" counter is exactly the drift this closes.
  
  `subshell-server status` also stops calling a readable database unreadable: it
  reads better-auth's `user` table now, which is created one line later at boot
  than the app tables, so a boot that died between the two is reported as an
  instance with no admin account rather than as disk corruption.
- Updated dependencies []:
  - @internal/pane-runtime@1.0.0

## 0.6.0

### Minor Changes

- [`152bdb5`](https://github.com/subshell-ai/subshell/commit/152bdb5da7dfc483e0c1032ecb4c03b1ce76f33b) Thanks [@theogravity](https://github.com/theogravity)! - Headless setup carries the sequence the desktop assistant carries.
  
  `subshell-server init` is now the whole first run: it writes config.env as
  before, then asks whether to run the server in the background and start it at
  login (default yes, `--no-service` to skip), and ends by naming the address to
  open — `Open http://…/setup in a browser to create the admin account.` Nothing
  said that before: not `init`, not `configure`, not `service install`, not the
  boot log, not `status`. `service install` prints the same line when run alone,
  and the boot log says it once while no account exists.
  
  - `install-server.sh` installs the control plane in one command: it resolves the
    platform, downloads the newest `server-v*` binary, verifies the published
    digest **before** the first `chmod +x`, installs to `~/.local/bin`, and runs
    `init`.
  - `status` gained a `setup` line saying whether the admin account exists — the
    first question an operator has, from the command they are told to run first.
  - `configure` warns about the LAN-bind trap: a wildcard bind with a loopback
    base URL and no trusted origins is the configuration whose only symptom is a
    403 "Invalid origin" naming nothing. The validator is shared, so the
    dashboard's Addresses card inherits it.
  - The browser `/setup` wizard has a tmux row, detection-first, with an Install
    button where the package manager needs no privilege. `POST
    /api/setup/tmux/install` is admin-cookie only and refuses anything
    `sudo`-prefixed.
  - Settings → General has a "Finish setting up" card listing only what is still
    undone: tmux, supervision and lingering, LAN sign-in, the placeholder auth
    secret, no agent CLI on this host. It renders nothing when there is nothing
    left.
  - The agent-CLI installer has a second door: the control-plane node's harness
    card can install one, so skipping the wizard's agent step is recoverable.
  - The Add-node dialog says what the one-liner will do to the machine, and its
    success line links to the node that arrived.
  
  Interactive prompts are now rendered with `@clack/prompts`.

- [`5cfcd19`](https://github.com/subshell-ai/subshell/commit/5cfcd19e7c59b5222a4ddc3b210edf5a413eaea4) Thanks [@theogravity](https://github.com/theogravity)! - Nodes can be taken out of service without being unenrolled.
  
  Until now the only way to stop subshells landing on a machine was to remove
  someone's access to it, which meant the control-plane host had a switch nobody
  else did — and that switch was really share surgery wearing a toggle's clothes.
  There was no way at all to say "this machine is busy being worked on, send it
  nothing for an hour."
  
  **Maintenance** is that, on every node including the server's own. A node in
  maintenance stays enrolled and keeps answering everything else — service
  control, logs, detection, restart, config — and simply takes no new subshells.
  Turning it on stops the subshells already running there, so the confirmation
  names how many and warns that their owners are told; those owners get a push
  saying the machine went into maintenance rather than a crash notice.
  
  It can be set from either end. In the browser it is a switch on the node's page
  and an item in the Nodes list menu, owner-only (an admin for the server's own
  host). At the machine it is `subshell maintenance on|off|status` — useful when
  you are already at the keyboard, and the only option when the plane cannot
  reach the node. Whichever end moved last wins, and the node's page says which
  one it was.
  
  A node in maintenance stays visible in the launch picker, greyed and labelled,
  rather than disappearing: it is a machine with a reason and a way back, and one
  that vanishes just looks lost. Trying to launch there anyway now says the node
  is in maintenance instead of failing with a server error.

- [`b1b7ca2`](https://github.com/subshell-ai/subshell/commit/b1b7ca2df9c80968ef1563617258c8e9d01c792b) Thanks [@theogravity](https://github.com/theogravity)! - Split a running subshell into a workspace. The subshell page gains a **Split**
  button that opens the add-subshell picker; the two subshells land side by side
  in an unsaved workspace you can name later with **Save workspace…** or throw
  away with **Discard**. Unsaved workspaces stay off the Workspaces page and the
  sidebar, are discarded automatically once they hold fewer than two panes, and
  the subshell page links back to the workspace it is on.

- [`44b3f8f`](https://github.com/subshell-ai/subshell/commit/44b3f8fe612be94cd35fc034199ea1599d00f5e8) Thanks [@theogravity](https://github.com/theogravity)! - The Service page answers "will this survive a reboot?" instead of offering a switch.
  
  Server Settings → Service was designed inside the Subshell Server app and then
  shown to every browser, which put a choice on screen that most machines cannot
  make: a headless Linux box was offered "With the Subshell Server app", disabled,
  under a note telling you to go change it in an app that machine does not have.
  And the control beneath it, **Start at login**, asked the wrong question. It
  reads as being about a desktop login; an operator who does not want a GUI thing
  switches it off and discovers at the next reboot that their server is gone.
  
  Worse, on Linux that switch was never the whole answer. A `systemd --user`
  service runs inside its owner's login session, so an *enabled* unit still stops
  the moment that user logs out — unless the account **lingers**. The fix is one
  command, `loginctl enable-linger $USER`, and nothing in the app had ever told
  you whether your machine needed it. The installer printed the advice once, to a
  terminal, on a machine most people never open a terminal on.
  
  So in a browser the card now states one fact — *comes back after a reboot,
  without anyone logging in* / *comes back when you log in, and stops when you log
  out* / *will not come back after a reboot* — and offers a remedy only when the
  answer is unsatisfying: the lingering command, a **Start automatically** button,
  or the install command. Lingering is now measured rather than guessed at, so the
  page says which machine you have instead of explaining both. Inside the Subshell
  Server app nothing changes: there the choice is real, the vocabulary is native,
  and the radios, the confirmation dialog and the login switch all stay.
  
  A node's Runtime card answers the same question in the same words, with the
  caveat it used to print for every Linux node replaced by that machine's own
  answer. `subshell service status` and `subshell-server service status` report
  it too, and the installer now mentions lingering only when you actually need it.
  
  Enrolled nodes have to be updated for this one. Reporting the fact needed a new
  field on the wire, so the node protocol steps to 9 and the minimum agent version
  to 0.7.0 — an older agent is refused at connect, as at every previous bump. Cut
  and publish the `node-v0.7.x` release before anyone reaches for the enroll
  download: until it exists the server has no agent binary it is willing to fetch.

- [`6b13c2c`](https://github.com/subshell-ai/subshell/commit/6b13c2c8c456b7ee8a2ba72a7c0bc2b5b4bde521) Thanks [@theogravity](https://github.com/theogravity)! - The user roster is a dedicated admin page at `/settings/users`, and adding a user is a dialog opened from its header. The dialog asks with the same form the first-run setup uses (name, email, password, confirmation, the password rule stated up front) plus a role. `POST /api/users` now takes a `name`, and the roster returns one. The old `/users` page is gone.

- [`1f51f9d`](https://github.com/subshell-ai/subshell/commit/1f51f9d9d57798b78c3806bb940eff2ace13fd79) Thanks [@theogravity](https://github.com/theogravity)! - Admins can disable a user account, which signs them out everywhere and refuses every credential they hold, including the bearer tokens their running subshells authenticate with. Enabling restores it. Nobody can disable or re-role their own account, since an admin who removes their own administration cannot undo it without another admin. The Add user dialog asks for the role first, and both role controls on the page spell each role one way. Display names are normalized and capped like every other person-chosen label, on the admin route and at first-run sign-up.

### Patch Changes

- [`fe46712`](https://github.com/subshell-ai/subshell/commit/fe467122bbb010b5340180b94739d182177689c0) Thanks [@theogravity](https://github.com/theogravity)! - An agent install whose output overflows says so again.
  
  Installer output is capped at 64 KiB, and a longer run is meant to end in
  `[truncated]` so the setup screen tells you the log is not the whole story.
  The counter deciding that only advanced while it was still under the cap, so
  it could report "we filled up" but never "there was more" — and since a pipe
  hands over power-of-two sized reads against a power-of-two cap, landing
  exactly ON the limit is the common case, not the rare one. A chatty installer
  therefore dropped everything past 64 KiB in silence, which reads as an
  installer that stopped talking rather than a log that was cut.

- [`5fa2c5a`](https://github.com/subshell-ai/subshell/commit/5fa2c5a0eadcf9c87d2bb7e932607b1a6c6cfb18) Thanks [@theogravity](https://github.com/theogravity)! - The Locations card (config file, data directory, database, logs, node artifacts, service definition) moved from Server Settings → Service to Server Settings → Status, where the read-only facts live; the Runtime card now shows the database size only.

- [`fac6d2c`](https://github.com/subshell-ai/subshell/commit/fac6d2cfcd3bc7db39a24692f5f213f67e93f4af) Thanks [@theogravity](https://github.com/theogravity)! - The first run on a Mac now says what macOS will ask and why — Notifications,
  Files and Folders, Photos, and the Background Items banner — requests the one
  the app owns, and never blocks on the answer. A permission that is missing is
  named at the moment it bites: a banner when a "waiting for you" notification
  could not post, a notice when the image picker opens with Photos blocked, and
  "Blocked by macOS" in the directory picker when the server cannot list a
  folder. Each carries a **Fix…** that opens the assistant, where a declined
  permission offers **Open System Settings**. Preferences → Notifications shows
  the live macOS state.

- [`c8f227b`](https://github.com/subshell-ai/subshell/commit/c8f227b0845748fdcc007f8a43050f38a8fedbb6) Thanks [@theogravity](https://github.com/theogravity)! - Two Nodes fixes.
  
  Server Settings → Status now counts the control-plane host among the online nodes. "Online" was the live agent-socket registry alone, which the server's own launch target can never appear in because it runs no agent — so an instance whose only node is the server read "0 online · 1 enrolled" forever, beside a Nodes page showing that same machine online.
  
  A node row no longer crushes its name. On a node with several detected harnesses the badges pushed the name column down to about one character, rendering a letter per line under an ellipsis. The name now keeps a minimum width, and the harness chips are what give way: three show inline and the rest sit behind a "+N more" button that expands them in place. The OS, status, "inventory stale" and ownership badges are always visible.

- [`63a9fa0`](https://github.com/subshell-ai/subshell/commit/63a9fa05fbd47a930f66549131b86025052f90aa) Thanks [@theogravity](https://github.com/theogravity)! - Server Settings → Status now reports the effective registration gate. It read the stored setting under an open-by-default fallback, so an instance that had never touched the setting showed an amber "open" in Security posture while the Registration toggle correctly showed "Closed" and every sign-up was refused.

## 0.5.0

### Minor Changes

- [`21f3904`](https://github.com/subshell-ai/subshell/commit/21f3904d82bbaf2ddee3980a372768b08d09ac9b) Thanks [@theogravity](https://github.com/theogravity)! - "Open in browser" in the dashboard, from two places: a row at the bottom of the
  sidebar that opens whatever route you are on, and an item in a subshell's
  actions menu (the ⋯ menu and the sidebar's right-click menu) that opens that
  subshell. Both appear only inside a desktop app — a browser tab already is the
  browser — and both hand the page to your default browser, with your profile,
  your password manager and your extensions. You will be asked to sign in there,
  because a browser carries no session from the app's window.
  
  Under it, the SPA learned that there are two desktop apps rather than one.
  Chrome that belongs to Subshell Server — the overlay title bar, the server
  pill, native notifications, and the update, reset and supervision cards — is
  now gated on being inside THAT app specifically, so none of it appears in
  Subshell Client's window, where the commands behind it do not exist.

### Patch Changes

- [`0209117`](https://github.com/subshell-ai/subshell/commit/02091170f2eae4e8c584a020c742849505572096) Thanks [@theogravity](https://github.com/theogravity)! - Typing in a terminal no longer freezes every other pane on the machine.
  
  Every tmux command the pane path runs — a keystroke, a resize, a screen
  capture, the grid readback, the liveness, title and exit-code probes — was a
  synchronous child process, so for as long as it took, the whole server was
  stopped: no other pane's output pump, nobody else's frames, no HTTP. On a
  loaded host that was measured at 60-70 ms per keystroke, which one person
  typing paid and everyone else's terminal paid with them. Those commands now run
  without blocking, on both the control-plane host and the node agent, and a tmux
  that stops answering now fails the keystroke after fifteen seconds instead of
  leaving that pane's keyboard silently dead.
  
  Keystrokes for one pane still reach tmux in the order they were sent —
  including the text-then-Enter pair that delivers a prompt — on the
  control-plane host and on a node alike.
  
  Separately, on a node: a burst of frames arriving together (a paste, or fast
  typing) could be verified out of order, which the agent read as a replay attack
  and answered by dropping its connection — taking every subshell on that machine
  offline until it reconnected. Frames are now handled strictly in arrival order.

## 0.4.0

### Minor Changes

- [`9aa9df9`](https://github.com/subshell-ai/subshell/commit/9aa9df95b80c8e87bdfc4336598906e5a295f185) Thanks [@theogravity](https://github.com/theogravity)! - The Addresses form on Server Settings → Service checks what you typed before sending it, and says what is wrong under the field it is about. The rules are the server's own — the same ones `subshell-server configure` applies — so the form cannot refuse a value the server would have taken, or accept one it would not. Save is now "Save and restart", and goes through the same confirmation as the Restart button, since saving an address the server is not listening on was never the point; cancelling that confirmation still leaves the change saved. Each field explains the mistake it invites — which bind address is the permissive one, and that a browser at an unlisted address is refused at sign-in with "Invalid origin" — instead of one sentence glossing all four.
  
  Where a restart would close running subshells, the dashboard now names the command that fixes it (`subshell-server service install`) rather than telling you to "reinstall the service definition", which is not something the dashboard can do. It no longer warns about a service definition on machines that have none.
  
  Both About boxes read "Desktop app" and "CLI", the same words the downloads carry. Subshell Server's said "Server" and "Subshell Server" — two programs named one word apart, usually showing the same version.
  
  For developers: `bun run dev:desktop-server` points the dashboard window at the SPA's dev server when one is running, so edits to the dashboard hot-reload. It never did before — that window loads the installed binary's embedded SPA — and the Service and Status pages say so while it is in effect.

- [`0c28447`](https://github.com/subshell-ai/subshell/commit/0c284472414e5040d29639edfd8fa3089c26d847) Thanks [@theogravity](https://github.com/theogravity)! - Server Settings → General gains a switch for whether people other than admins can add their own machines as nodes. It is on by default and on every existing instance, which is the behaviour up to now: anyone signed in could mint a setup key and bring a machine in. Turned off, adding a node becomes an admin act — and because registering a node hands this instance command execution on that machine under its own user, that is a reasonable thing for an operator to want to hold.
  
  Turning it off stops new setup keys being handed out; it does not revoke the ones that already exist. Those expire after 24 hours, or an admin can delete them on the Nodes page, which is the act that revokes. The settings card says so rather than leaving it to be discovered.
  
  Admins are never affected, the same way an admin can create a user while sign-up is closed. Where someone cannot add a node, the button is not shown at all and the page says who to ask instead of offering something that would be refused.

- [`47e340d`](https://github.com/subshell-ai/subshell/commit/47e340dd04355551c5f4b84df03e0247b7e9e99a) Thanks [@theogravity](https://github.com/theogravity)! - Harnesses show their real marks instead of an emoji. `subshell.icon` now names
  an image file inside the plugin package rather than a glyph, each built-in
  ships its vendor's own logo, and the control plane serves it at
  `GET /api/plugins/<id>/icon`. A plugin that declares no icon renders a
  monogram. The mark shows wherever a harness is listed: first-run setup, the
  agent picker, Settings → Plugins (installed and catalog alike) and a node's
  harness list.

- [`f73f29a`](https://github.com/subshell-ai/subshell/commit/f73f29a3ba94c019537b8414e3a36c0662b9cb53) Thanks [@theogravity](https://github.com/theogravity)! - Profiles are **presets** now, and the rename is the least of it. A preset is one agent's saved launch customisation — env, flags, settings, auto-restart — and it has one job now: it is OPTIONAL. Launching needs only an agent and a folder.
  
  That optionality is what deleted the machinery. Every launch once required a row, which is why the server seeded a blank **Default** profile per user and per plugin at four seams and refused to delete it. A fresh instance now has zero presets and can launch immediately; every preset is deletable, and deleting one nulls the reference on the subshells that used it, whose next restart falls back to the plain launch rather than failing.
  
  **Upgraded instances lose the seeded Default rows too.** Migration `0027` deletes every row the old seeder marked and frees the subshells that pointed at them, so an upgraded instance is presetless of Defaults exactly like a fresh one — a blank phantom preset beside the new "None" would resurrect the deleted concept. Every preset **you** created converts unchanged — including one you NAMED "Default": the purge hunts the seeder's flag, never the string. But an **edited seeded Default is removed WITH the seeded rows** — your customisation lived on a row the seeder flagged, and the flag is what marks it for deletion, not the text inside. Copy anything you need out of it before upgrading.
  
  **A preset name is now unique per agent, per user, ignoring case.** It always claimed to be — `0001-init.ts` documented the invariant while the index enforced nothing — which is how an agent asking for a preset by name could get whichever row sorted first. Migration `0028` adds the real constraint, and create and rename answer 409 on a collision, the way workspace names already did. Existing duplicates are **renamed, never deleted**: the oldest keeps the name and the rest take " (2)", " (3)" in creation order, each keeping its own capitalisation. The only way to notice is if you were deliberately running two same-named presets for one agent — in which case they were already indistinguishable in every picker.
  
  Presets no longer pin a node. The pin was the biggest part of the launch form's state machine and of the divergence between web and mobile; with the agent chosen first, node compatibility is decided by the agent, and the node picker's own default rules are unchanged.
  
  Agents on the instance list presets through MCP (`list_presets`) and launch with `create_subshell` taking `harness` plus an optional `preset`.
  
  **Enrolled nodes must update their agent.** The node protocol moves to 7 — the launch frame's `profile` field becomes `preset`, wire-shaped and not semantic — and the gate is exact-match, so a lagging agent is refused with a named version to install (the floor is 0.5.0). Both desktop apps ship in the same cut, re-bundling the CLI each wraps; cut the release as `app=all`. SPA work ships embedded in the server binary, which is why it has no changeset of its own.

- [`c88536a`](https://github.com/subshell-ai/subshell/commit/c88536a50d815d31b11eeb976d77c6cc9192bec0) Thanks [@theogravity](https://github.com/theogravity)! - Registration is closed by default. An instance used to ship accepting sign-ups from anyone who could reach it until an admin noticed and turned them off; the permissive state is the one an operator should have to choose.
  
  The exception is what makes the default possible rather than a softening of it: sign-up stays open while the instance has **no users at all**, because the first account registered becomes the admin. Without that, a closed empty instance could never mint the one person able to open it, and a fresh install would be bricked behind a sign-up form that refuses. The door is open exactly until someone walks through it, and closes behind them. An admin who wants open registration afterwards turns it on under Settings → General, and that is recorded in the audit trail.
  
  Nothing changes for an instance that has already answered the question: an explicit yes or no is still honoured exactly as before, and a corrupt setting still fails closed.

- [`3f0b87a`](https://github.com/subshell-ai/subshell/commit/3f0b87af6bb858f16fef765f6428a8d5e7c5a5d2) Thanks [@theogravity](https://github.com/theogravity)! - The sidebar now appears from 683px of viewport width instead of 1024px, so a window that is too narrow to tile a workspace still keeps its navigation. The two were one number, which meant a window had to be wide enough for a split workspace before it was allowed to show where you are. Below 683px the hamburger drawer takes over as before — that is where a 240px rail starts costing more than a third of the window.
  
  Phones and tablets are unchanged: a touch-primary device keeps the drawer until 1024px either way, since a rail beside a phone-width page leaves a strip of content and a finger wants the drawer regardless.

- [`f0503c8`](https://github.com/subshell-ai/subshell/commit/f0503c8eb88a3e9902201ae3e059100139c06d20) Thanks [@theogravity](https://github.com/theogravity)! - Type is five roles, not six: the 12px `caption` was too small to read and has
  been removed, so `detail` (13px) is the floor and carries what caption did —
  chips, timestamps, versions, monospace output. Quiet text is separated from
  loud text by colour and weight rather than by a third size. `lint:design`
  refuses `text-xs` and `text-caption`, which matters because Tailwind still
  generates `.text-xs` from its own defaults once the token is deleted.
  
  Everything a control says about itself is now one size: its help text, a "set
  by the environment" note, a saved-vs-running line, a validation error. Settings
  → Service explained a toggle at 13px and the field below it at 12px, and a
  plugin's description was 12px in one card and 14px in another. Form labels also
  gained the air under them they were meant to have — the label was `display:
  inline`, which silently discards a vertical margin. The mobile app follows the
  same scale.

### Patch Changes

- [`3f0b87a`](https://github.com/subshell-ai/subshell/commit/3f0b87af6bb858f16fef765f6428a8d5e7c5a5d2) Thanks [@theogravity](https://github.com/theogravity)! - Subshell tiles are now one fixed size rather than stretching to divide the row. Widening the window used to shrink a card — crossing into a second column split the row under the single card that was there, so a bigger window gave you a smaller tile. Only the number of tiles per row changes with the window now; each one stays the same size wherever you see it.
- Updated dependencies []:
  - @internal/pane-runtime@1.0.0

## 0.3.0

### Minor Changes

- [`90972be`](https://github.com/subshell-ai/subshell/commit/90972bef8023c7a5896f1578169673934702bd0e) Thanks [@theogravity](https://github.com/theogravity)! - Agent CLIs are installed by the control plane on an admin's request (`POST /api/setup/agents/:id/install`, built-in ids only, audited), from the setup assistant's Add an Agent screen. Subshell Server no longer carries its own installer table or the `desktop_install_agent` command; its status page points at the dashboard instead.

- [`3bcbf6a`](https://github.com/subshell-ai/subshell/commit/3bcbf6ae3e668ca37431ace52624aaea4ddc29ab) Thanks [@theogravity](https://github.com/theogravity)! - A sidebar item can be a group now — a label with a chevron that opens to pages — and both navigations use one.
  
  In the web UI the admin pages are one **Server Settings** group: General, Users, API keys, Plugins, Status, Audit log. The old Instance page was a scroll of unrelated cards, so it split: system API keys and the audit trail are pages of their own, the local-launch switch moved to the control-plane host's own node page beside its allowed directories, and Plugins is in the rail instead of behind a header button. Users joined the group, and a member's rail no longer lists it — the roster stays readable by URL and in the sharing picker. No route moved.
  
  In Subshell Server's console, Addresses is a setting, so it sits under a **Settings** group with the tray and reset section, which is now called **Application**. Overview, Logs and About are unchanged.
  
  A group follows where you are: it opens when you are on one of its pages and shuts when you leave, and the chevron overrides that until you navigate again.

- [`0898438`](https://github.com/subshell-ai/subshell/commit/0898438649cb9b08e8caf8dc4abc114bebc96c5c) Thanks [@theogravity](https://github.com/theogravity)! - Server Settings → Service: a new admin page for how this server is deployed. Addresses (port, bind address, public base URL, trusted origins) are edited in the dashboard and written through the CLI's own validator, so a browser and `subshell-server configure` produce the same file. The page shows what config.env saves against what the running process booted with, so an edit made over ssh is visible without the dashboard having written anything. The server can restart itself, but only where its service manager reports this very process, so a hand-run server is never exited into nothing. Data locations and the service definition are listed for copying.
  
  The server now keeps its own log file at `<data dir>/logs/server.log`: one file, JSON lines, 0600, capped at 200 KB and replaced when full, the same on every platform and never copied into memory. An admin can read its tail from any browser. A debug-logging switch, off by default, is an instance setting applied live with no restart; while on, the file carries debug lines and one line per HTTP request. `SUBSHELL_DEBUG_LOGGING` forces it on and makes the switch read-only.
  
  Node detail shows how an enrolled node's agent runs — supervision, service state, config and log paths, whether tmux was found — and can restart it. An About dialog, for every user rather than admins only.
  
  New admin routes: `GET /api/admin/server`, `PATCH /api/admin/server/config`, `POST /api/admin/server/restart`, `GET /api/admin/server/logs`, `PUT /api/admin/server/logging`. New node route: `POST /api/nodes/:id/restart`. `BACKEND_LOG_LEVEL`, which nothing read, is removed.

- [`ee87b8d`](https://github.com/subshell-ai/subshell/commit/ee87b8dcf16fe80ecd3bf3e9ea1cb2dde69824ac) Thanks [@theogravity](https://github.com/theogravity)! - The new-subshell form stops asking where to run when there is only one answer: on an instance with no nodes of its own, the Machine field is gone. A second machine brings it back, even if only one of them can take a subshell today.
  
  Switching off launching on the server now applies to admins as well. It always read as a setting about the instance, but an admin's instance-wide access quietly exempted them from it — so the one person who could turn it off was the one person it did nothing to. The server's node page stays visible and manageable to them, which is the way back.
  
  With nowhere left to launch, the form says so and offers the two ways out: switch the server back on, or add a node. Anyone can add a node; the first button appears only for someone who can actually take it, and everyone else is told who can.

- [`a93ba71`](https://github.com/subshell-ai/subshell/commit/a93ba711fed459654b2ddf0c964bda1d4e994135) Thanks [@theogravity](https://github.com/theogravity)! - A node gets the management surface the control plane already has for itself. Its page is now sectioned — Overview, Service, Configuration, Logs — and from any browser you can start, stop, restart, install or uninstall the agent's service, read what that machine logged, and point it at a different control plane. Most nodes are headless, so this is the only place those questions can be asked at all.
  
  Stopping and uninstalling are the node owner's alone, and say so before they run: every command reaches a node over the agent's own connection, so nothing here can start an agent that is not running — reversing either needs a shell on that machine. Repointing is the owner's too; it hands the machine a new address to dial and takes it off this instance.
  
  The agent now writes its own log file, capped and replaced when full, because its console output goes to a journal on Linux and a file on macOS and neither can be read from a browser.
  
  Subshell Client's setup assistant no longer carries a colophon under every screen. What the app is, which versions are running and under what terms is a screen you ask for — from the tray, or from the About panel in the macOS menu bar.
  
  Node agents need updating alongside the server: the node protocol changed, and the two ship together.
  
  The Service buttons now refresh the page they act on. Installing a service left the card still saying "not installed" — the node page does not poll, and the mutation wrote nothing back — so every verb but Restart looked like it had done nothing until you navigated away and came back. Restart, which has to wait for the agent's own socket to return, shows a spinner while it waits.
  
  On macOS, whether the agent starts at login is read from `RunAtLoad` OR `KeepAlive`, not `RunAtLoad` alone. `KeepAlive=true` starts the job either way (measured), so a plist with `RunAtLoad=false` was reported as "does not start at login" about an agent that does.
  
  The node's Log card follows at one second — the server's own cadence — instead of offering a Refresh button beside a line saying it already refreshes every five seconds. It asks nothing while its tab is hidden. Pausing stops the asking, so you can read something without the next poll moving it. Both log scrollers — this one and the server's — can now be reached and scrolled from the keyboard.
  
  Where a node runs under systemd, "starts at login" now says what it does not cover: a user service stops when its owner logs out, and `loginctl enable-linger` is what keeps it up. The agent's installer already said so, to a terminal on a machine most people never open one on.
  
  A node's agent has a debug-logging switch, matching the server's: off by default, applied live, persisted on that machine so a restart does not end a debug session, and read-only while `SUBSHELL_DEBUG_LOGGING` is set in the agent's own environment. It reveals nothing yet — the agent writes no debug-level lines, and the card says so rather than leaving you to discover it by flipping the switch — but the control is now where the log is, which on a headless node is the only place either can be reached.
  
  Reading a node's log no longer fills the server's own. Request lines are written at debug into one 200 KB file that is replaced when full, and the node log poll was not exempt — so with debug logging on, a single open node page would have destroyed the history it was turned on to read.
  
  A node's page keeps itself current. It never polled, so a node that went offline kept a full runtime card — pid, uptime, every Service verb enabled — until you navigated away and came back.

- [`d10ec2d`](https://github.com/subshell-ai/subshell/commit/d10ec2d9993833b5e2437ec81d9a30d07d43b6c0) Thanks [@theogravity](https://github.com/theogravity)! - Harness hooks no longer require `bun` on the pane's machine.
  
  Claude Code's attention and conversation-identity hooks ran `bun -e '<inlined
  JS>'`, which assumed a bun on the pane PATH — true of the container image the
  assumption was written for, false of every desktop install. There, every
  session opened with `/bin/sh: bun: command not found`, notifications never
  fired, and the server never learned the in-pane conversation id after `/clear`,
  `/resume` or `/fork`, so a restart could resurrect a stale conversation.
  
  The reporting moved into the binary itself: both `subshell-server` and
  `subshell` now serve `report attention <kind>` and `report session`, and the
  control plane resolves which of them the PANE's machine has — its own for
  `local`, the node's reported self-invocation for an agent — and hands the
  plugin that command. A plugin given no reporter omits its hooks rather than
  baking a command the pane cannot run. Nothing on a pane's machine needs a
  runtime it did not already have.
  
  The node protocol is bumped to 4: `ready.selfInvoke` replaces
  `ready.mcpLaunch`, carrying the self-invocation WITHOUT its subcommand so the
  plane appends `mcp` or `report` to one reported fact. Server and agent ship
  together, as the protocol's exact-match rule already requires.

- [`eabe4b0`](https://github.com/subshell-ai/subshell/commit/eabe4b0b9c108e92fa6438e64fe2bd56d79bc068) Thanks [@theogravity](https://github.com/theogravity)! - Whether the server runs in the background, and whether it starts at every login, are two questions you can answer instead of two things the setup screen assumed.
  
  `subshell-server service enable` and `service disable` arm and disarm start-at-login without touching the running process, and `service install --no-autostart` installs a service that runs now but does not come back. The dashboard's Service page carries the same switch (`POST /api/admin/server/autostart`), which is the one service control a served page gets — it changes nothing about the running process, so the page asking for it cannot take itself down. It is disabled with the reason where the question has no answer: nothing installed, the desktop app running this server, or a manager that would not say.
  
  The Subshell Server setup screen's "Start it in the background, and at every login" is now two checkboxes, both checked by default. Unchecking the first runs the server as the app's own child — alive while the app is open, stopped when you quit, with running subshells kept — and the dashboard reports that honestly, so Restart server keeps working there.
  
  Switching between the two later is a "How this server runs" card on the Service page, with both modes always shown and the machine's own marked. Picking the other one IS the choice: it confirms in a dialog on that page, which lists what the switch will do and warns when this machine's service definition is old enough that removing it would close every running subshell. A browser on the LAN sees the card read-only, with a line saying where it can be changed. A server nobody supervises — started by hand, in a container — now shows neither mode rather than claiming the background one. The switch is recorded in the audit trail as `server.supervision.request`.
  
  On macOS, "starts at login" is now which directory the launchd plist lives in rather than a key inside it. `RunAtLoad=false` does not stop a `KeepAlive=true` job (measured), and `launchctl disable` makes "running now but not at login" inexpressible while leaving a mark that survives uninstall.
  
  Two supervisor faults behind "the app runs the server" are fixed. Stopping a server while it was waiting to respawn after a crash could wedge the supervisor for the life of the app — every later Start did nothing, silently — and a Start that arrived while the previous loop was still winding down told that loop a server was wanted and then put it back to sleep for the rest of its respawn delay.

- [`2d9ca95`](https://github.com/subshell-ai/subshell/commit/2d9ca95be904d938efd5cd47430aeb12ce531108) Thanks [@theogravity](https://github.com/theogravity)! - The setup wizard is a setup assistant: full-window screens with one decision each, dots instead of a step rail (continuing the desktop app's three when opened from it), and an Add an Agent screen that leads with what is detected, with install help collapsed until asked for and no plugin switches. Harness rows carry their plugin `type`.

- [`d789c45`](https://github.com/subshell-ai/subshell/commit/d789c45d64c9f77fb8af043f397e9f87f31a188b) Thanks [@theogravity](https://github.com/theogravity)! - Fetch a missing node agent binary instead of 404ing.
  
  A server installed from a release tarball has an empty node-artifacts
  directory, so the "Add a node" install command failed on every machine until
  someone ran `bun run release:node` from a checkout or copied files in by hand.
  The repository is public now, so the server reads the same release it was
  telling you to copy from.
  
  It is lazy on purpose. Nothing is downloaded until a machine actually asks for
  that platform, so a fleet that is all Linux never spends anything on the macOS
  builds, and an instance nobody enrols against never touches the network. The
  first install on each platform takes a little longer while the download
  happens; later ones are served from disk.
  
  The bytes are checked against the digest the release publishes as they stream
  past, and a mismatch fails the download rather than caching bad bytes. When a
  newer release appears, binaries this server downloaded from an older one are
  removed; anything you published yourself is left alone.
  
  Set `SUBSHELL_NODE_RELEASE_URL` to point somewhere else, or to empty to turn
  downloading off entirely — an air-gapped instance behaves exactly as before,
  warning included.

### Patch Changes

- [`335ab2e`](https://github.com/subshell-ai/subshell/commit/335ab2e542d29a6c7da0a6017a497a3249175a86) Thanks [@theogravity](https://github.com/theogravity)! - The launch form no longer asks for a subshell name: the server names one after its start time, the pane's own title takes over, and renaming is a deliberate act on a subshell that exists ("Edit title" in its actions menu). The setup assistant's first-launch screen also leads with plain words — **Machine** and **Agent** — and teaches "node" and "profile" in a line underneath, rather than opening with two nouns a ninety-second-old account has never met. Every other launch surface keeps the bare nouns, and the clone dialog keeps its name box, where naming the copy is the whole decision. The phone's new-subshell tab drops its name field to match.

- [`5fe5a7b`](https://github.com/subshell-ai/subshell/commit/5fe5a7b2730428332b281a820353fa20a25510cc) Thanks [@theogravity](https://github.com/theogravity)! - Setting up again after a reset no longer fails with "launchctl bootstrap failed (exit 5): Input/output error" on macOS. Removing a service does not take it out of launchd's hands immediately, and the install was reading the plist file on disk to decide whether the previous one needed removing — a file a reset had already deleted while the job was still leaving. The install now always clears the old registration and waits for the domain, retrying only while launchd says it is busy; a genuinely bad service definition still fails with launchd's own words (launchd answers the same code for some malformed plists, so those now wait out the retry before reporting).
  
  Resetting the Subshell Server app also restarts the app, which is what takes you back to first-run setup instead of leaving a dashboard open on an instance that no longer exists — including when the dashboard is set to close to the tray, where it was previously hidden rather than closed and could be brought back pointing at a server that was gone.
  
  In Subshell Client, opening About twice in quick succession no longer loses the second request.

- [`2fb6f62`](https://github.com/subshell-ai/subshell/commit/2fb6f6223c2c1d0c27a59e18d0081540f7054bf7) Thanks [@theogravity](https://github.com/theogravity)! - Starting a subshell and creating a profile are dialogs now, not pages. `/new` used to render a second copy of the launch form as a full-page card — same title, same fields, same buttons as the dialog the rail already owned — and the Profiles page pushed its list down to make room for a create card. Both raise a dialog over the page they belong to. `/new` still works as a deep link; it opens the dialog and hands the page under it to the subshells list.

- [`b09dae4`](https://github.com/subshell-ai/subshell/commit/b09dae4bffb2a3d26911d952299956b50186ad51) Thanks [@theogravity](https://github.com/theogravity)! - The setup assistant's Welcome screen shows the full Subshell wordmark instead of the `/s` app icon, and both frames — the native page and the server's own `/setup` screens, which are one specification — center their column in the window rather than pinning it below a fixed top margin.

- [`9720d07`](https://github.com/subshell-ai/subshell/commit/9720d079ecbb7e1d2540b68f335b96e03280586a) Thanks [@theogravity](https://github.com/theogravity)! - Pane output reaches the terminal in milliseconds instead of a second.
  
  The tail that carries a pane's output to an attached browser used `fs.watch`
  for immediacy, with a 1000ms interval behind it described as a "safety net for
  missed watch events". On macOS that safety net was the whole transport:
  measured on bun 1.4.2, a watch on a file appended by ANOTHER process — which is
  exactly what tmux `pipe-pane` is, `sh -c 'cat >> log'` — fired 0/10 in one run
  and 1/3 in another, while reporting in-process writes reliably. So every
  keystroke's echo waited for the next tick: 698ms on average, with every sample
  within 2ms of the rest, the signature of a fixed timer rather than an event.
  
  That is why typing and resizing felt seconds behind: a keystroke reaches tmux
  in ~5ms, but nothing carried its echo back until the poll came round.
  
  The poll is now named for what it is and runs at 50ms, measured end to end at
  6ms median / 50ms worst case through the real launcher against a real pane. It
  costs one `stat` per tick per ATTACHED pane (9.4µs, so ~0.19ms of work per
  second per pane) and the pump only exists while somebody is watching. The watch
  stays as the optimization it always was, on the platforms that honour it.
  
  All three copies of the mechanism are fixed — the WS attach source, the local
  launcher's tail, and the node agent's, so panes on a macOS node gain the same.
  
  The existing tests could not have caught this: they append in-process, the one
  case `fs.watch` reports reliably. The new ones append from another process, as
  pipe-pane does.
  
  Opening or reattaching to a subshell is also several times faster. The fit-
  then-repaint step before the replay was sized for a TUI that repaints once
  and goes quiet: a pane animating a spinner (an agent thinking) never gave it
  150ms of quiet, so it ran to its 1500ms deadline on every attach, and a pane
  that never repaints at all (a plain shell) burned every no-growth grace in
  sequence. Measured with the real functions against real panes: 1.55s and
  1.18s. Two changes, both keeping the mechanism and its purpose ("improves the
  first paint only; correctness lives in the gap-free join"): a same-size reopen
  no longer resizes at all — tmux makes that a no-op, no SIGWINCH fires, and
  the 450ms wait for a repaint that could not come is gone; and the wait after a
  real resize now caps at 300ms with a 60ms quiet window that falls between an
  animation's frames instead of waiting for it to stop. Same measurement after:
  193ms animating, 363ms idle. Both attach paths share one helper now, so they
  cannot drift.

- [`faba929`](https://github.com/subshell-ai/subshell/commit/faba9293787aec8c56f1fcef228e90b928ce85f2) Thanks [@theogravity](https://github.com/theogravity)! - The profile dialog's Harness picker lists what is installed first, matching the launch pickers — on a fresh machine the one selectable row used to sit under four "(not installed)" ones. The ordering rule is now one shared, tested function rather than a copy per picker. The directory picker's panel also flows inline instead of floating: inside a dialog it is a child of a scroll container, which clipped it, so browsing for a working directory showed a panel cut off at the dialog's edge.

- [`d372792`](https://github.com/subshell-ai/subshell/commit/d372792a276c3761030378dd0df2acb21455bd9d) Thanks [@theogravity](https://github.com/theogravity)! - The launch pickers list what you can actually launch first. A fresh machine has one agent installed and a Default profile for every other one, so the only usable row could render sixth, under five greyed "not installed on this node" rows. Greying rather than hiding is unchanged — the reasons are still there to read — but they now sit below the rows a hand can land on. The node picker follows the same rule, and within each group the existing order is untouched.
- Updated dependencies []:
  - @internal/pane-runtime@1.0.0

## 0.2.0

### Minor Changes

- [`8cc452a`](https://github.com/subshell-ai/subshell/commit/8cc452a1085debece9d0b1a27080ff037330880a) Thanks [@theogravity](https://github.com/theogravity)! - **Plugins live on the control plane. Nodes execute.**
  
  `<SUBSHELL_SERVER_DATA_DIR>/plugins/` is the instance's one plugin store. An admin installs, enables and uninstalls at **Settings → Plugins** (`/api/plugins`; the writes are cookie-admin because installing runs third-party code in the process that holds the node signing keypair). One install arms every node, and it seeds every user a Default profile for the harness; on first boot the built-ins are seeded into the store once, keyed on a completion marker, so first-run setup needs no network. Disabling is an instance-level state (`plugin_state`, an absent row means enabled): it hides the plugin's profiles everywhere and blocks its launches, and re-enabling brings the same rows back untouched. There is no per-node flag on either side. Uninstalling first says what it will destroy (the impact endpoint feeds the dialog: profiles, their owners, Defaults, running subshells); `mode=delete` also removes every profile using the harness, Defaults included, and running subshells are unaffected either way. Registry installs still verify the announced sha512 over the raw bytes, unpack through a reader that refuses links, traversal and oversize, and swap atomically from a staging load-check, and they fetch from `SUBSHELL_PLUGIN_REGISTRY_URL` (`subshell-server status` prints it); malformed specs are a 400 before anything is fetched. A built-in id always resolves to the copy compiled into this build; a registry package claiming one is logged once and not loaded. The anonymous setup route is built-in ids only, with no spec field, as before.
  
  A node now knows only how to execute. A `launch` carries the argv built on the control plane, with `@@HARNESS_BINARY@@` in the binary slot, plus the rule for resolving it (`argv` and `resolve`, both required), and the harness's MCP dialect (`mcp.args` / `mcp.env`) alongside the registration file's content; the node resolves the binary at the moment of spawn, substitutes, and launches, so a stale cached path still cannot break a launch and an absent binary is still refused there. Detection is a command the plane sends, with manifest data, when someone asks: opening a node's page, pressing Re-check, or launching. The node probes the named binaries and answers with raw version text; `parseVersion` is plugin code and runs here, and the parsed answer is cached with the time it was probed. For resume, the node's `ready` event reports its `homeDir`, and every `detect` command also names the environment variables the plane's enabled harness manifests declare (`subshell.hostEnv`) — the node answers the values it has for exactly those names, never a scan. The control plane computes the transcript path from the home and the answered values, and a generalized `path_exists` command asks the node whether it is there.
  
  Gone with this: the `subshell plugin install|update|uninstall|list` verbs and `subshell configure --registry-url` (they now refuse as unknown), the per-node `POST`/`DELETE /api/nodes/:id/plugins` routes, the signed `plugin_install` / `plugin_uninstall` commands, `probe_resume` (replaced by `path_exists`), the plugin set from the inventory event, and the `nodes.plugins_json` mirror (migration 0026, which also creates `plugin_state`). A `plugins/` directory left in an agent data dir by a previous version is inert residue: this release neither seeds, refreshes, nor deletes it, and an older `config.json`'s `registryUrl` key is dropped on the next rewrite.
  
  **This is node protocol 3 and requires upgrading agents and the server together.** It is the first BREAKING bump of the restarted numbering: `launch` without `argv`/`resolve` names a spawn no plugin-less node can perform, so it is refused at the parse, and the exact-match gate refuses a v2 agent outright.

- [`22739d3`](https://github.com/subshell-ai/subshell/commit/22739d3599647febb355ef07f42bec0c063020cc) Thanks [@theogravity](https://github.com/theogravity)! - A built-in `terminal` plugin: a plain shell in a subshell pane, with no agent and nothing to install.

### Patch Changes

- [`da0dfaf`](https://github.com/subshell-ai/subshell/commit/da0dfaf6e2af6f913f81cd0bf1647fcb30505eb9) Thanks [@theogravity](https://github.com/theogravity)! - Harness detection finds a harness installed through a version manager, says why a binary was not found, and reports when it last looked.
  
  The lookup ladder tries the manifest's env override, then PATH, then the manifest's known install locations, then the version-manager layouts: managers that keep versioned bin directories are globbed directly (nvm, fnm, n, newest version first), and managers with a stable one are searched there (volta, asdf, mise, pnpm, bun, yarn). A static list cannot cover the first class, because the directory carries a node VERSION, and nvm initializes in `~/.bashrc`, which a non-interactive login shell returns early from. A login-shell PATH rung stays as the last resort for managers with no predictable layout; it is bounded and cached, and it is the only rung that runs a shell profile.
  
  A lookup that fails reports `not-on-path` or `override-invalid`, so a mis-set `CLAUDE_PATH` is named instead of being answered with an install command that cannot help, and `no-binary` says the plugin declares none. Every entry carries the time it was probed, which is what lets a cached answer be labelled last-known with its age, and what distinguishes the control-plane host (probed live on every read) from an enrolled node (read from the cache) on screen.
  
  The version probe is bounded, and the deadline holds even when the harness leaves a child holding its stdout.

- [`f0ed8a7`](https://github.com/subshell-ai/subshell/commit/f0ed8a7021164eb1458f1c4153d3b08d89a1980c) Thanks [@theogravity](https://github.com/theogravity)! - **The node page reports what the machine can RUN.** The harness card on a node's page was still a plugin manager after the plugin move: its Install and Remove buttons POSTed to a per-node route that no longer exists, and its "not usable" and "restart the agent" notices described plugin loading in the control-plane process, which is not a fact about one machine.
  
  The card is detection output now. One row per plugin the instance has installed, each saying whether this machine found the program it drives, at which version, and when it was last checked; a row leads with the plugin's display name from the instance store's manifest (the node view carries it), not its raw id; a stale cached answer is labelled last-known instead of pretending to be live. Rows for plugins the instance dropped are simply gone, and a plugin that fails to load in the server is said where it belongs, on Settings → Plugins, which the card now links to. Its one control is Re-check, offered to anyone the server's re-check gate accepts (the node's owner or an `edit` grantee) on enrolled nodes only (the control-plane host probes live on every read).

- [#38](https://github.com/subshell-ai/subshell/pull/38) [`6a3daa8`](https://github.com/subshell-ai/subshell/commit/6a3daa8956f7d42658da5b55db03d104ef013468) Thanks [@theogravity](https://github.com/theogravity)! - `subshell-server status --json` now reports `paths` (dataDir, database, logsDir, nodeArtifacts) so the desktop app's reset deletes exactly what it shows.
- Updated dependencies []:
  - @internal/pane-runtime@1.0.0

## 0.1.2

### Patch Changes

- [#34](https://github.com/subshell-ai/subshell/pull/34) [`e94135f`](https://github.com/subshell-ai/subshell/commit/e94135fee80751f08774fc882d212b92bc6bb195) Thanks [@theogravity](https://github.com/theogravity)! - Make the addresses an instance answers to configurable, so signing in from
  anything other than loopback no longer fails with 403 "Invalid origin". The
  allowlist was derived from the port, a *concrete* `HOST` and `APP_BASE_URL` —
  and on the default `0.0.0.0` bind the host is skipped and the base URL defaults
  to `http://localhost:<port>`, leaving only the two loopback spellings. A phone
  or a second hostname on the LAN sent an `Origin` nothing matched, and neither
  key was reachable from the desktop.
  
  Subshell Server console: **Public base URL** and **Other addresses browsers
  will use** join port and bind address, seeded from what the server reports and
  sent whole on save. `subshell-server configure` gains `--trusted-origins`
  (entries validated by component and stored canonicalized, so a trailing slash,
  a mixed-case host, expanded IPv6 or an explicit `:443` all work; wildcards and
  embedded credentials are refused), and `status` reports `TRUSTED_ORIGINS` plus
  per-entry `problems` — what a browser will *do* with a value the boot accepted,
  and which config layer supplied it — which the console shows beside the field.
  
  Node: `subshell configure --server <url>` repoints an enrolled node at a moved
  control plane without re-enrolling — it keeps the node id, node key and pinned
  control key, spends no setup key and mints no second node row (`enroll`, the
  only previous route, did all three). Subshell Client gains a matching
  **Repoint this node…** control, warns when its own control-plane address and
  the node's have drifted apart, and repoints both together.
  
  Fixes found along the way, all pre-existing:
  
  - `localOriginsFor` built its derived entries by string concatenation, so on a
    port-80 deployment `http://<host>:80` matched nothing a browser sends (80 is
    the scheme default) — the LAN address 403'd while `localhost` worked, from an
    entry that looked like it covered it. Every entry is now serialized through
    `URL.origin`.
  - `configure --port 080` was accepted and written, and the server then could
    not boot — nor could `status` or `configure`, which import the same module.
    The port must now be the canonical integer the boot accepts.
  - A mixed-case scheme (`HTTP://host`) was stored verbatim, and the node's dial
    URL is built by replacing the scheme with a case-sensitive match, so the
    agent tried to open a WebSocket to `HTTP://host/ws/node` and never connected.
  - `init --yes` reset every key it was given no flag for, so changing the port
    from the console silently repointed `DATABASE_PATH` and discarded a
    customised `APP_BASE_URL`. Stored values are now the defaults in every mode;
    flags still win. A value already on disk that this tool would not write is
    preserved with a warning rather than blocking the run.
  - `subshell enroll --server "  http://x  "` stored the padded string, which
    became a dial URL with spaces in it.

## 0.1.1

### Patch Changes

- [`ac5125d`](https://github.com/subshell-ai/subshell/commit/ac5125d22b231d3a51112e0110171e7b18f44efb) Thanks [@theogravity](https://github.com/theogravity)! - Fix `config.env` silently not applying under launchd (crash-looped macOS
  installs booting on defaults — `constants.ts` now applies the layer itself at
  import; systemd deployments were unaffected). `service status` reports the
  manager verbatim (`launchd: spawn scheduled`, and an unanswerable manager is
  `unknown`, not `stopped`) and names the log file (`logPath`), and
  `status` survives a PATH without `netstat`.
  
  Subshell Server console: reveal config.env, the server, the service
  definition and the log file in the file manager; the base URL is now "control
  plane URL" and opens in the system browser; port/host can be changed from
  every step; Start/Install are disabled with install advice while tmux is
  missing; installing a service is one click that also starts it; and the
  console re-probes after service verbs instead of landing on "installed but
  not running". The macOS login-items entry now reads Subshell Server with its
  icon instead of the signing organisation.
  
  Both desktop apps: close-to-tray now defaults ON, clamped off (switch
  disabled, refusal kept honest) on desktops where no tray answers.
  
  The node side got the same treatment. `subshell service status` reports the
  manager verbatim (crash-throttle `spawn scheduled`, and an unanswerable
  launchd is `unknown` with its stderr, not a confident "stopped") and names
  its log file; the macOS login-items entry for a node now reads Subshell
  Client with its icon. Subshell Client's page opens the control plane in the
  system browser, shows the log location and the manager's own words, and
  disables Enroll / Install / Start / Restart — with the install command named
  — while tmux is missing; its install button now says it also starts, because
  that is what the CLI does.
