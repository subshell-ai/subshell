# @internal/node

## 0.10.0

### Minor Changes

- [`5b0e8e0`](https://github.com/subshell-ai/subshell/commit/5b0e8e058a071832305777b66bdc08e87ce54a92) Thanks [@theogravity](https://github.com/theogravity)! - The agent can replace its own binary, and a refused one can be rescued from a browser.
  
  `subshell update` installs a newer agent over this one and restarts into it —
  `--check` to see what is available, `--from` to install a local file, `--to` to
  pick a published release, `--rollback` to put the previous binary back. The
  plane can drive the same thing with a signed `update` command.
  
  Every install is a transaction the next process completes: the swap keeps the
  old binary as `<binary>.previous` and writes a marker, and the agent that boots
  either finishes it (the plane accepted this version) or reverts it (the plane
  refused with 4406 — the previous binary goes back and the service manager
  brings it up, on a machine nobody had to visit).
  
  Which file gets replaced is read from **the installed service definition
  first** — the unit's `ExecStart=` or the plist's `ProgramArguments` — and only
  from the running process when no definition names one. That distinction is the
  whole game on a host where `subshell` on your PATH is not the copy the service
  manager runs: resolving from the running process there swapped a binary nobody
  executes, reported success, and let the manager bring the old version back up
  on the next restart. A definition naming an interpreter and a script is refused
  (replacing token one would overwrite `bun` itself), and a definition naming a
  file that is not there is refused too rather than quietly falling back.
  
  Node protocol 10, and the minimum agent version this server family talks to
  rises to 0.9.0 with it. `subshell status --json` now reports the binary an
  update would replace — through that same ladder, so status and update cannot
  name different files — alongside `binarySource` saying which rung answered,
  and the state of any transaction.

### Patch Changes

- [`80eaa2b`](https://github.com/subshell-ai/subshell/commit/80eaa2bea9c08cda0203014ea0d87a31f17b8009) Thanks [@theogravity](https://github.com/theogravity)! - Every agent release now publishes a `release-manifest.json`
  
  A fifth asset beside the three binaries and their digests: the component id,
  the version, this build's `NODE_PROTOCOL_VERSION` and `MIN_AGENT_VERSION`, and
  the commit it was cut from.
  
  It exists so a control plane can answer "can I talk to the agent in this
  release" from 200 bytes rather than by downloading an 80 MB binary — and that
  question was previously not asked at all. The plane offered a node the newest
  release above its agent floor, which on a plane one version behind installs an
  agent speaking a protocol the plane does not: that node enrols, reconnects, and
  is closed 4406 forever. A release carrying no manifest is now refused BY NAME
  rather than guessed at, so the first cut after this is the first one plane-side
  node updates can use.
- Updated dependencies [[`023d795`](https://github.com/subshell-ai/subshell/commit/023d795a57bfba90430b632844c8b05b1709f658)]:
  - @subshell-ai/plugin-api@2.1.0
  - @internal/pane-runtime@1.0.0

## 0.8.0

### Minor Changes

- [`152bdb5`](https://github.com/subshell-ai/subshell/commit/152bdb5da7dfc483e0c1032ecb4c03b1ce76f33b) Thanks [@theogravity](https://github.com/theogravity)! - `subshell setup` is the whole enrollment in one command: it checks tmux, enrols
  the machine, then asks whether to run the agent in the background and start it
  at login (default yes, `--no-service` to skip), and ends by naming the node's
  page on the control plane.
  
  The installer one-liner now invokes it, installs to `~/.local/bin/subshell`
  rather than the directory you happened to run `curl` from, checks tmux before
  downloading, and reattaches the terminal so the question can be answered from a
  piped install. It no longer ends by recommending `subshell run`, a foreground
  process that dies with the SSH session and was the only next step the product
  ever offered.
  
  `enroll` remains the primitive underneath, and its closing line — like the
  offline line in `status` — now names the service verbs before `run`.

### Patch Changes

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

## 0.5.2

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

## 0.5.1

### Patch Changes

- [`f73f29a`](https://github.com/subshell-ai/subshell/commit/f73f29a3ba94c019537b8414e3a36c0662b9cb53) Thanks [@theogravity](https://github.com/theogravity)! - Profiles are **presets** now, and the rename is the least of it. A preset is one agent's saved launch customisation — env, flags, settings, auto-restart — and it has one job now: it is OPTIONAL. Launching needs only an agent and a folder.
  
  That optionality is what deleted the machinery. Every launch once required a row, which is why the server seeded a blank **Default** profile per user and per plugin at four seams and refused to delete it. A fresh instance now has zero presets and can launch immediately; every preset is deletable, and deleting one nulls the reference on the subshells that used it, whose next restart falls back to the plain launch rather than failing.
  
  **Upgraded instances lose the seeded Default rows too.** Migration `0027` deletes every row the old seeder marked and frees the subshells that pointed at them, so an upgraded instance is presetless of Defaults exactly like a fresh one — a blank phantom preset beside the new "None" would resurrect the deleted concept. Every preset **you** created converts unchanged — including one you NAMED "Default": the purge hunts the seeder's flag, never the string. But an **edited seeded Default is removed WITH the seeded rows** — your customisation lived on a row the seeder flagged, and the flag is what marks it for deletion, not the text inside. Copy anything you need out of it before upgrading.
  
  **A preset name is now unique per agent, per user, ignoring case.** It always claimed to be — `0001-init.ts` documented the invariant while the index enforced nothing — which is how an agent asking for a preset by name could get whichever row sorted first. Migration `0028` adds the real constraint, and create and rename answer 409 on a collision, the way workspace names already did. Existing duplicates are **renamed, never deleted**: the oldest keeps the name and the rest take " (2)", " (3)" in creation order, each keeping its own capitalisation. The only way to notice is if you were deliberately running two same-named presets for one agent — in which case they were already indistinguishable in every picker.
  
  Presets no longer pin a node. The pin was the biggest part of the launch form's state machine and of the divergence between web and mobile; with the agent chosen first, node compatibility is decided by the agent, and the node picker's own default rules are unchanged.
  
  Agents on the instance list presets through MCP (`list_presets`) and launch with `create_subshell` taking `harness` plus an optional `preset`.
  
  **Enrolled nodes must update their agent.** The node protocol moves to 7 — the launch frame's `profile` field becomes `preset`, wire-shaped and not semantic — and the gate is exact-match, so a lagging agent is refused with a named version to install (the floor is 0.5.0). Both desktop apps ship in the same cut, re-bundling the CLI each wraps; cut the release as `app=all`. SPA work ships embedded in the server binary, which is why it has no changeset of its own.
- Updated dependencies [[`f73f29a`](https://github.com/subshell-ai/subshell/commit/f73f29a3ba94c019537b8414e3a36c0662b9cb53), [`47e340d`](https://github.com/subshell-ai/subshell/commit/47e340dd04355551c5f4b84df03e0247b7e9e99a)]:
  - @subshell-ai/plugin-api@2.0.0
  - @internal/pane-runtime@1.0.0

## 0.4.0

### Minor Changes

- [`0898438`](https://github.com/subshell-ai/subshell/commit/0898438649cb9b08e8caf8dc4abc114bebc96c5c) Thanks [@theogravity](https://github.com/theogravity)! - The agent reports how it runs when it connects — process start time, whether a service manager supervises it, the service state, its config and log paths, the agent binary, and whether tmux is on its PATH — so a headless node's owner can see all of it from the control plane. It also accepts a `restart` command from its control plane, exiting for the service manager to respawn it; a restart is refused unless the manager started this very process, and refused when the service definition would take the node's running panes down with it unless the caller forces it.

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

### Patch Changes

- [`5fe5a7b`](https://github.com/subshell-ai/subshell/commit/5fe5a7b2730428332b281a820353fa20a25510cc) Thanks [@theogravity](https://github.com/theogravity)! - Setting up again after a reset no longer fails with "launchctl bootstrap failed (exit 5): Input/output error" on macOS. Removing a service does not take it out of launchd's hands immediately, and the install was reading the plist file on disk to decide whether the previous one needed removing — a file a reset had already deleted while the job was still leaving. The install now always clears the old registration and waits for the domain, retrying only while launchd says it is busy; a genuinely bad service definition still fails with launchd's own words (launchd answers the same code for some malformed plists, so those now wait out the retry before reporting).
  
  Resetting the Subshell Server app also restarts the app, which is what takes you back to first-run setup instead of leaving a dashboard open on an instance that no longer exists — including when the dashboard is set to close to the tray, where it was previously hidden rather than closed and could be brought back pointing at a server that was gone.
  
  In Subshell Client, opening About twice in quick succession no longer loses the second request.

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
- Updated dependencies [[`8c7fc57`](https://github.com/subshell-ai/subshell/commit/8c7fc578c1c06185ef2c9538c521ca96b8711946)]:
  - @subshell-ai/plugin-api@1.0.1
  - @internal/pane-runtime@1.0.0

## 0.2.0

### Minor Changes

- [`8cc452a`](https://github.com/subshell-ai/subshell/commit/8cc452a1085debece9d0b1a27080ff037330880a) Thanks [@theogravity](https://github.com/theogravity)! - **Plugins live on the control plane. Nodes execute.**
  
  `<SUBSHELL_SERVER_DATA_DIR>/plugins/` is the instance's one plugin store. An admin installs, enables and uninstalls at **Settings → Plugins** (`/api/plugins`; the writes are cookie-admin because installing runs third-party code in the process that holds the node signing keypair). One install arms every node, and it seeds every user a Default profile for the harness; on first boot the built-ins are seeded into the store once, keyed on a completion marker, so first-run setup needs no network. Disabling is an instance-level state (`plugin_state`, an absent row means enabled): it hides the plugin's profiles everywhere and blocks its launches, and re-enabling brings the same rows back untouched. There is no per-node flag on either side. Uninstalling first says what it will destroy (the impact endpoint feeds the dialog: profiles, their owners, Defaults, running subshells); `mode=delete` also removes every profile using the harness, Defaults included, and running subshells are unaffected either way. Registry installs still verify the announced sha512 over the raw bytes, unpack through a reader that refuses links, traversal and oversize, and swap atomically from a staging load-check, and they fetch from `SUBSHELL_PLUGIN_REGISTRY_URL` (`subshell-server status` prints it); malformed specs are a 400 before anything is fetched. A built-in id always resolves to the copy compiled into this build; a registry package claiming one is logged once and not loaded. The anonymous setup route is built-in ids only, with no spec field, as before.
  
  A node now knows only how to execute. A `launch` carries the argv built on the control plane, with `@@HARNESS_BINARY@@` in the binary slot, plus the rule for resolving it (`argv` and `resolve`, both required), and the harness's MCP dialect (`mcp.args` / `mcp.env`) alongside the registration file's content; the node resolves the binary at the moment of spawn, substitutes, and launches, so a stale cached path still cannot break a launch and an absent binary is still refused there. Detection is a command the plane sends, with manifest data, when someone asks: opening a node's page, pressing Re-check, or launching. The node probes the named binaries and answers with raw version text; `parseVersion` is plugin code and runs here, and the parsed answer is cached with the time it was probed. For resume, the node's `ready` event reports its `homeDir`, and every `detect` command also names the environment variables the plane's enabled harness manifests declare (`subshell.hostEnv`) — the node answers the values it has for exactly those names, never a scan. The control plane computes the transcript path from the home and the answered values, and a generalized `path_exists` command asks the node whether it is there.
  
  Gone with this: the `subshell plugin install|update|uninstall|list` verbs and `subshell configure --registry-url` (they now refuse as unknown), the per-node `POST`/`DELETE /api/nodes/:id/plugins` routes, the signed `plugin_install` / `plugin_uninstall` commands, `probe_resume` (replaced by `path_exists`), the plugin set from the inventory event, and the `nodes.plugins_json` mirror (migration 0026, which also creates `plugin_state`). A `plugins/` directory left in an agent data dir by a previous version is inert residue: this release neither seeds, refreshes, nor deletes it, and an older `config.json`'s `registryUrl` key is dropped on the next rewrite.
  
  **This is node protocol 3 and requires upgrading agents and the server together.** It is the first BREAKING bump of the restarted numbering: `launch` without `argv`/`resolve` names a spawn no plugin-less node can perform, so it is refused at the parse, and the exact-match gate refuses a v2 agent outright.

### Patch Changes

- [`da0dfaf`](https://github.com/subshell-ai/subshell/commit/da0dfaf6e2af6f913f81cd0bf1647fcb30505eb9) Thanks [@theogravity](https://github.com/theogravity)! - Harness detection finds a harness installed through a version manager, says why a binary was not found, and reports when it last looked.
  
  The lookup ladder tries the manifest's env override, then PATH, then the manifest's known install locations, then the version-manager layouts: managers that keep versioned bin directories are globbed directly (nvm, fnm, n, newest version first), and managers with a stable one are searched there (volta, asdf, mise, pnpm, bun, yarn). A static list cannot cover the first class, because the directory carries a node VERSION, and nvm initializes in `~/.bashrc`, which a non-interactive login shell returns early from. A login-shell PATH rung stays as the last resort for managers with no predictable layout; it is bounded and cached, and it is the only rung that runs a shell profile.
  
  A lookup that fails reports `not-on-path` or `override-invalid`, so a mis-set `CLAUDE_PATH` is named instead of being answered with an install command that cannot help, and `no-binary` says the plugin declares none. Every entry carries the time it was probed, which is what lets a cached answer be labelled last-known with its age, and what distinguishes the control-plane host (probed live on every read) from an enrolled node (read from the cache) on screen.
  
  The version probe is bounded, and the deadline holds even when the harness leaves a child holding its stdout.
- Updated dependencies [[`8cc452a`](https://github.com/subshell-ai/subshell/commit/8cc452a1085debece9d0b1a27080ff037330880a)]:
  - @subshell-ai/plugin-api@1.0.0
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
