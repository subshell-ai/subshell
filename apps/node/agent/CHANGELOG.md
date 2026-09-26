# @internal/node

## 1.2.0

### Minor Changes

- [#239](https://github.com/subshell-ai/subshell/pull/239) [`ef7031c`](https://github.com/subshell-ai/subshell/commit/ef7031cc85ee6beb6d8e5307e798ad45442da719) Thanks [@theogravity](https://github.com/theogravity)! - feat(node), feat(desktop-client): the node role gets its reset doors (issue [#232](https://github.com/subshell-ai/subshell/issues/232)). New CLI verbs: `subshell reset` stops the daemon, closes this machine's pane servers, removes the service definition, and deletes the data directory, the daemon lock and `config.json` (the node key's only home) last, keeping the binary; `subshell uninstall` adds the binary and asks separately, default NO, whether the data goes too (`--reset-data` is the scripted yes). Consent is the machine's NAME typed at the prompt or `--confirm <name>`; `--yes` is refused by name, and once consent is given a step that cannot run is reported and the clear continues. The Subshell Client's tray gains **Reset…**, raising the page's existing typed-hostname dialog from any state. Docs: the node CLI reference gains the verbs and a reset/uninstall section.

### Patch Changes

- [#231](https://github.com/subshell-ai/subshell/pull/231) [`107e945`](https://github.com/subshell-ai/subshell/commit/107e945afac4c2739419d5cbbc1ea8ae715d559c) Thanks [@theogravity](https://github.com/theogravity)! - fix(node), fix(client): the [#225](https://github.com/subshell-ai/subshell/issues/225) invalid state self-heals and can no longer be installed. The node agent now ignores a loopback `nodeWsUrl` persisted beside a remote `serverUrl` (the residue a server whose base URL was never configured leaves behind, surviving a reset that keeps this file) and dials the plane `config.json` actually names; same-machine loopback pins are untouched. The Subshell Client's register chain skips its enroll act only for a same-plane retry, so a machine carrying an old registration to a different server re-enrolls behind the existing confirm rather than silently starting a node bound to the wrong plane.

## 1.1.0

### Minor Changes

- [#210](https://github.com/subshell-ai/subshell/pull/210) [`f19fed4`](https://github.com/subshell-ai/subshell/commit/f19fed456ba1783b34fbe848d247a8253ab95e7f) Thanks [@theogravity](https://github.com/theogravity)! - Typing into a pane that has exited now answers honestly. `send_to_subshell` failed with an internal server error while a remote pane's process had exited but its row still read "running"; the send is now refused with a clear "restart it first" before anything is typed. The sidebar's needs-attention bell now clears when you type into the pane, not only when you (re)open it, fixing the flag that would not clear while you were already interacting with the subshell. Subshells an agent launches through `create_subshell` are recorded as cross-agent comms: they are created with the notification bell off (still togglable), they collect in a new "Cross-agent comms" sidebar section that is closed by default (each row naming its machine, remembered open per device), and the pane's own page says so. The MCP briefing and tool descriptions now teach an agent that a pane it opened is its own to terminate or delete when the exchange is done. The green "printing" dot blinks again while a pane produces output: the output time stamp was saved without announcing itself, so under the event-driven feed no client ever learned the pane was printing (a pane on another machine never blinked at all, as nothing else writes that stamp there). And the rail's status marks sit centered on the name line: the unseen-push bell rode a pixel off the dot and both floated above the text, so bell rows and dot rows down the rail read as a crooked column (operator screenshots).

- [#212](https://github.com/subshell-ai/subshell/pull/212) [`c3cf1d7`](https://github.com/subshell-ai/subshell/commit/c3cf1d775e590f7fa0a1d4c3aa392d50ada6065e) Thanks [@theogravity](https://github.com/theogravity)! - Intel Macs (darwin-x64) are a published target again, for every component. `install-server.sh`, the server-rendered node enroll one-liner, self-update, and the downloads route resolve an Intel host to the `darwin-x64` artifact instead of refusing it by name. The desktop apps publish a second Mac image, `Subshell-<App>-Desktop-<version>-darwin-x64.dmg`, cross-built by `tauri build --target` on the Apple Silicon runner, and `install-client.sh` now installs it on an Intel Mac instead of refusing. The release pipeline cross-builds and exec-smokes CLI binaries under Rosetta; the desktop smoke verifies the bundle's signing chain, the staple, and the nested sidecar's Mach-O slice.
  
  On the marketing site the macOS download button becomes a split control with an Apple silicon / Intel menu. The choice is capability-driven: `releases.json` now carries each desktop release's verified asset list (read from the release's own signed `release-manifest.json`), and the menu appears only when the newest cut actually ships the Intel image. No version numbers are hardcoded anywhere on the page.

## 1.0.0

### Major Changes

- [#184](https://github.com/subshell-ai/subshell/pull/184) [`711b5fa`](https://github.com/subshell-ai/subshell/commit/711b5fa4e8ab31db801800fc1733b0c370c78e58) Thanks [@theogravity](https://github.com/theogravity)! - Marked 1.0.0. The control plane, the node daemon, and both desktop apps
  all mark their first stable release. This entry changes no behavior; it
  records the milestone, and the entries below it are what the milestone is
  made of.

### Minor Changes

- [#177](https://github.com/subshell-ai/subshell/pull/177) [`f77b8a0`](https://github.com/subshell-ai/subshell/commit/f77b8a03fc1f92b9ccc480744f0df2860d020b3a) Thanks [@theogravity](https://github.com/theogravity)! - The node ↔ control-plane link is now encrypted end to end. Every `/ws/node` connection negotiates a fresh key with libsodium's `crypto_kx` (each side authenticates against the long-term identity it pinned at pairing), and after that the socket carries only ratcheted `crypto_secretstream` ciphertext, never resynced. A server on plain `http://` no longer puts launch commands, pane bytes, or bearer tokens on the network in the clear; whoever can see the node's network can no longer read it.
  
  This is a hard protocol cutover (13 → 14, minimum node version 0.17.0) with no plaintext fallback. Deploy order: server first, then nodes. Nodes enrolled before the link existed pair themselves on their first connect after updating (the agent mints its keypair and registers it over the socket its bearer key already authenticates), and rotating a node's key re-provisions the link identity through the same self-heal. A node that skips or fails the handshake is refused with close code 4410 and retries with its backoff, never silently degraded to plaintext.

- [#170](https://github.com/subshell-ai/subshell/pull/170) [`ac9ec22`](https://github.com/subshell-ai/subshell/commit/ac9ec2284b0ee2a9e5a962a2caa9332dcd02ddf9) Thanks [@theogravity](https://github.com/theogravity)! - Nodes now age out their own pane logs. A subshell's transcript (every byte the terminal rendered, typed secrets and pasted tokens included) lives in a log file on the machine that ran the pane, and until now the only node-side deletion was the control plane commanding it at delete time: a node that was offline for the delete kept the transcript indefinitely, and a terminated-but-kept subshell kept it for the life of the machine. The agent sweeps its own disk instead (one pass at boot, an hourly pass after it, with no dependence on the plane being reachable), deleting the log of any subshell whose pane its tmux census does not find live, older than a window configured on the node itself: `SUBSHELL_LOG_RETENTION_DAYS` / `SUBSHELL_LOG_RETENTION_HOURS` (the environment wins), else the matching `logRetentionDays` / `logRetentionHours` fields of `config.json`, else a default of one day, deliberately shorter than the server's 30, because a node is not where transcripts should accrete. `0` days and `0` hours together keep everything forever. A running pane's log is never swept (it is the live replay buffer), a liveness probe that cannot answer counts the pane running, and only pane-log name shapes inside the data dir (never a symlink) are ever touched. This is a tightening on upgrade: an unconfigured node deletes non-running transcripts older than a day. The window now has a setter on the machine itself: the node's loopback dashboard shows the effective days and hours with the layer each came from (environment, `config.json`, or the default) and writes changes to `config.json`, which the next hourly sweep picks up without a restart. A field the environment forces is read-only there, named by its variable, the same rule the debug-logging switch follows; the plane has no counterpart route, because the policy belongs to the machine whose disk it ages. The boot sweep is started before the agent's first connection to the plane but no longer waits for it, and the liveness census probes concurrently, so a wedged tmux can slow a sweep but can no longer stall a node's connection. Every refusal at that setter, a validation 400 as much as an env-forcing 409, writes a line to the agent's own log, because there is no audit row on this surface and the log IS the machine's record of its own decisions.

### Patch Changes

- [#170](https://github.com/subshell-ai/subshell/pull/170) [`ac9ec22`](https://github.com/subshell-ai/subshell/commit/ac9ec2284b0ee2a9e5a962a2caa9332dcd02ddf9) Thanks [@theogravity](https://github.com/theogravity)! - An update started from the node's own loopback dashboard can no longer be refused by a stale fact. During the daemon's boot window the page re-proves supervision with one live service-manager query and now carries that answer into the executor, instead of the executor re-reading the same boot-time report, still null, and answering "not supervised" to a node the page had just proved supervised. A caller with no proof, which is every plane-commanded update, keeps the old refusal exactly.
  
  The force option now states its own limit: a downgrade the control plane will not accept leaves the node held offline for about ten minutes and is then reversed automatically, so the card says that beside the checkbox instead of letting the success line imply a durable downgrade.
  The same threading now covers the service card. With no daemon in the process (the standalone dashboard), the service route decided pane safety from a fresh manager read but used to word its refusal from the daemon report the route had just fallen back past, so a machine whose fresh read answered `unknown` ("nobody could read the definition") got the CERTAIN sentence ("would close every subshell"). The resolved report's `paneSafety` now rides to the wording, exactly as the update route's proof already does; a `kills` answer keeps the certain sentence, and a `liveRuntime` test seam pins both halves.

- [#180](https://github.com/subshell-ai/subshell/pull/180) [`b28726a`](https://github.com/subshell-ai/subshell/commit/b28726a67fa5f5190358eff9845e5822de6b5b7d) Thanks [@theogravity](https://github.com/theogravity)! - Dialog and tab-strip polish, and the provider admin's sharper edges. Dialog actions stay in one right-aligned row and dialog headers stay left, always: shadcn's viewport breakpoints (stack under 640px, center until 640px) tested the WINDOW, so page zoom or a narrow shell re-stacked buttons and centered text inside a comfortably wide dialog. Page tab strips (Users, Logs, Nodes) are content-sized now instead of stretching two labels across the page; the equal-share switch stays for in-row controls. The copy icon shrank to sit inside value rows. On Settings → Auth: the provider form shows its slug id live under the name, the remove confirmation lists its effects and names the exact row (slug id and issuer) and notes that re-adding the same slug id restores the accounts, close-capable toggles are DISABLED with a tooltip when a provider is the last open one (the 409 remains the enforcement, it just stops being the introduction). The `cli-node` bump covers only the smaller copy icon, which the node dashboard shares.

- [#173](https://github.com/subshell-ai/subshell/pull/173) [`766d4a7`](https://github.com/subshell-ai/subshell/commit/766d4a7b30546c3f03130fe5596eddfc486af3a8) Thanks [@theogravity](https://github.com/theogravity)! - Notifications get quieter. A Stop hook no longer rings "Done, waiting for you" while the session is parked on background work; approval pushes fire only for the notification types that genuinely need a human; a pane pushes at most once until its owner opens it, escalation excepted; and the sidebar dot becomes a bell for exactly as long as a push sits unanswered.

- [#170](https://github.com/subshell-ai/subshell/pull/170) [`ac9ec22`](https://github.com/subshell-ai/subshell/commit/ac9ec2284b0ee2a9e5a962a2caa9332dcd02ddf9) Thanks [@theogravity](https://github.com/theogravity)! - Every name is normalized the same way, and the attach journal line can no longer be forged. Manual subshell renames, named creates and both workspace name doors now run the human-typed name through the shared `normalizeLabel` instead of a bare trim; a hand-typed name no longer carries escape bytes into the restart journal line or another user's sidebar, and a name that is nothing but invisible characters is refused (subshells, workspaces) or becomes an unnamed create (a create never 400ed on a blank name and still does not). `normalizeLabel` itself hardened: NFC first (so two spellings of one name compose to one string and the cap counts characters of the canonical form), Unicode format characters dropped (bidi overrides, zero-width joiners and spaces, soft hyphen, BOM, emoji tag characters: the invisible half of what CR/LF do to a log line), the emoji presentation selectors dropped, and unpaired surrogates dropped, which nothing downstream could render or compare anyway. Node names and device labels inherit all of it (the node patch is that inheritance: a name typed on the machine is now stored the same rule the plane applies). Separately, the per-attach `ws attach` journal line clamps its User-Agent to the characters real UAs actually contain BEFORE slicing to 90 (a client can no longer close the quoted field, break the line, or mint a second record in the forensics the operator greps), and a disabled account's session cookie is refused on the no-token WS attach path, the same `accountDisabled` check every REST surface already applies.

- [#169](https://github.com/subshell-ai/subshell/pull/169) [`78fd431`](https://github.com/subshell-ai/subshell/commit/78fd4318fd6721da2b41cfaa32a65889dc2f26e1) Thanks [@theogravity](https://github.com/theogravity)! - Fix the fresh-terminal replay so typing lands on the visible prompt.
  
  The attach replay ended with the client's cursor at the bottom of the grid
  while the pane's cursor sat at the prompt near the top, so every live byte
  (echo included) painted below the visible prompt (the "prompt at the top,
  typing off-screen" report). The replay now ends with an absolute move to the
  pane's real cursor: a new `pane_cursor` node command (protocol 12 → 13) feeds
  it, and an older agent that cannot answer simply gets the previous behavior.
  A booting pane's first frame now waits for the shell's first paint instead of
  shipping the blank grid, the log file is waited for (the whole-grid poll
  fallback stays for panes that never get one), and bytes already queued at a
  booting viewer are dropped rather than replayed on top of the capture, which
  double-painted prompt sequences into ghost prompts.

- [#170](https://github.com/subshell-ai/subshell/pull/170) [`ac9ec22`](https://github.com/subshell-ai/subshell/commit/ac9ec2284b0ee2a9e5a962a2caa9332dcd02ddf9) Thanks [@theogravity](https://github.com/theogravity)! - The node's update paths match the server's hardening and two dashboard truths become honest. `subshell update --rollback` and the loopback dashboard refuse to install a `<binary>.previous` that cannot run (it is probed with `version` before the rename, and the automatic 4406 revert records the failure instead of swapping in an unbootable copy); the rollback copy is now made atomically, so an interrupted copy can never leave a truncated one. The probe carries the server twin's bounds as well (stdin ignored, stdout drained, a 10-second hard timeout), so a rollback copy that never exits is refused as unable to run instead of hanging the boot before the exit its service manager is waiting for. Live writes to `config.json` (the dashboard's retention card and debug-logging switch, and `subshell configure`) now go through one fresh re-read merge, so concurrent writers can no longer revert each other's fields on the file that also holds the node key. And the node's own Settings page reports whether its hourly retention sweep is actually scheduled, so its copy promises the next sweep only when one will run and says "at the next restart" when the daemon armed no timer.

- [#170](https://github.com/subshell-ai/subshell/pull/170) [`ac9ec22`](https://github.com/subshell-ai/subshell/commit/ac9ec2284b0ee2a9e5a962a2caa9332dcd02ddf9) Thanks [@theogravity](https://github.com/theogravity)! - The node's pane-log retention sweep can no longer delete the transcript of a subshell that restarted while the sweep was running. The pass censused tmux once at the top and then walked the files; a restart landing in that window reuses the same log path append-only with the old mtime intact, and with the default window of ONE DAY almost any aged file is a candidate, so the sweep unlinked a live transcript out from under the capture child, and the pane kept writing the dead inode until a relaunch. Every eligible file is now re-probed with a fresh `hasSubshell` immediately before its own unlink; a probe that cannot answer counts the pane running, the census's own unknown-is-not-dead rule. An orphan log (no record to probe) still ages out: that is what a missed delete leaves behind.

- [#170](https://github.com/subshell-ai/subshell/pull/170) [`ac9ec22`](https://github.com/subshell-ai/subshell/commit/ac9ec2284b0ee2a9e5a962a2caa9332dcd02ddf9) Thanks [@theogravity](https://github.com/theogravity)! - A service definition nobody could read is now refused with the honest sentence. The destructive verbs (node `stop`/`uninstall`/`restart`, node `update`, the server's own restart and update) already fail closed when the supervision definition reports `unknown` or nothing at all: one refusal code, because an unreadable definition is not evidence of safety. But the WORDING promised, with certainty, that every pane would die. Only a definition that actually answered `kills` earns that sentence now; `unknown` and no-report-at-all say the definition could not be read, on the plane's node surfaces, the node's own loopback dashboard, and the server's own restart and update routes alike.

- [#176](https://github.com/subshell-ai/subshell/pull/176) [`db5951a`](https://github.com/subshell-ai/subshell/commit/db5951ae26bbc8cd4ea6a32be3114b84df786396) Thanks [@theogravity](https://github.com/theogravity)! - "Waiting for you" now clears on agent nodes. The only alive-path clearer was the plane's idle watcher, which can only observe a log on the plane's own disk, so a pane running on a node stayed amber from its last Stop or approval until the process died, however hard it worked. Claude Code's hooks now report a third attention kind, `resumed` (prompt submitted, or a tool starting after an approval), and the pane's own report clears the stamp from wherever it runs; it never reads the hook payload and never rings. Rollout: update the nodes FIRST, then the Server. The Server ships the new hook, and an older `subshell` binary rejects `resumed` as an unknown argument with exit 2, which Claude Code reads as a blocking error on every prompt and tool, so a node left behind stalls its panes until it updates. An updated node against an older Server is harmless: the report is a silent no-op there.

- [#170](https://github.com/subshell-ai/subshell/pull/170) [`ac9ec22`](https://github.com/subshell-ai/subshell/commit/ac9ec2284b0ee2a9e5a962a2caa9332dcd02ddf9) Thanks [@theogravity](https://github.com/theogravity)! - Two round-3 audit fixes to how a node updates its own binary. The `update` executor (for the plane-commanded path and the node's loopback dashboard alike) now refuses a command that names a version not NEWER than the running agent, so the downgrade refusal is no longer only the plane's: a confused or compromised control plane cannot walk an agent backwards by accident. `force` answers the refusal (the loopback dashboard offers an explicit "allow a downgrade" through the same executor, which is the keyboard act a well-behaved plane never pairs with force), and an equal version is refused even under force. And the swap itself (the node's own port of the server's shape) no longer moves the live path: `<binary>.previous` is made a second name for the running agent (a hardlink, or a flushed copy where links are refused) and ONE `rename` lands the new bytes over the running image, which is measured safe. The old two-rename order had a window where neither name held a bootable agent, the boot-revert living inside the missing binary, so a kill or power loss there meant a hand at a keyboard on a deliberately headless machine; now every crash state leaves a bootable binary at the unit's path, and `subshell update --rollback` reads the same `.previous` it always did.

- [#182](https://github.com/subshell-ai/subshell/pull/182) [`6955725`](https://github.com/subshell-ai/subshell/commit/6955725c3f45d0945adc18dae6234f4b44814fa4) Thanks [@theogravity](https://github.com/theogravity)! - The no-em-dash voice rule applied to shipped copy: every string a person reads on a screen or in a terminal now carries its breath with a comma, colon, parentheses, or a full stop. The tray update item reads "Update available: Subshell Server 0.8.0" (both apps), the node window title "Subshell Client: Node", network plugin hints, both CLIs' refusals and prompts, and the browser-rendered error messages lose their dashes, and so do the /docs endpoint descriptions, the shared MCP tool descriptions, and the desktop apps' permission prose. No wire name, error code, id, or log line changed.
- Updated dependencies [[`711b5fa`](https://github.com/subshell-ai/subshell/commit/711b5fa4e8ab31db801800fc1733b0c370c78e58)]:
  - @subshell-ai/plugin-api@3.0.0
  - @internal/pane-runtime@1.0.0

## 0.15.1

### Patch Changes

- [#160](https://github.com/subshell-ai/subshell/pull/160) [`f0e71d2`](https://github.com/subshell-ai/subshell/commit/f0e71d20862705ebaf50d74939d4b7f9688e06ba) Thanks [@theogravity](https://github.com/theogravity)! - Fix terminal input lag on nodes: keystrokes now echo as fast as they are typed instead of appearing only on a later key (Enter). The pane's live view is fed by `tmux pipe-pane`, whose child was `cat >> <log>`. On hosts where `/usr/bin/cat` is **uutils coreutils**, `cat` buffers a partial write to a regular file, so a keystroke echo — a tiny, newline-less write — never reached the log until an Enter-sized burst flushed it; the browser froze on the last flushed chunk. The capture child is now the binaries' own `pane-log --file <path>` verb, an unbuffered `readSync`→`writeSync` copy that flushes every read and creates the log 0600, identical on macOS and Linux and immune to which `cat` is installed. `subshell` and `subshell-server` both gain the verb; `cat >>` stays only as a no-child fallback. The earlier proxy/LAN-latency explanation was wrong — the keystrokes were arriving instantly; only the capture stalled.

## 0.15.0

### Minor Changes

- [#144](https://github.com/subshell-ai/subshell/pull/144) [`646f7f2`](https://github.com/subshell-ai/subshell/commit/646f7f205229b059ba755c9f1ad2a841d78ba695) Thanks [@theogravity](https://github.com/theogravity)! - Subshell Client's Service section now offers what Subshell Server's does,
  adapted to a node: the background arrangement stated in one card, a
  run-at-login switch under it, the lifecycle verbs (Start when the node is
  down; Stop, Restart and Uninstall when it is up), and an
  install-and-start door for a machine whose node CLI is installed but has no
  service keeping it running. The switch is greyed with the exact update
  sentence on an agent older than this release, because only 0.15.0 gained the
  verb to write the answer with. On both the Status and Service screens the
  state chip now reads in the screen header, between the title and the
  subtitle.
  
  Status grew the two halves of Subshell Server's Status section it was
  missing: the path facts carry their own inline Reveal button (the Service
  bar's two buttons moved onto the rows whose value is the path, each opening
  only the fact it is already showing), and a Node log pane tails the agent's
  own log while the section is open.
  
  Behind the switch, the node CLI gains `subshell service autostart on|off`:
  it arms or disarms login start for an installed service and touches nothing
  that is running. `subshell service status --json` answers the same fact
  under its own name, `autostart`, so an older agent without the field still
  probes (the switch reads `enabled` there). The copy names no service managers. The named thing is the Subshell Node
  Service, the card states the CURRENT condition ("Currently the Subshell Node
  Service runs in the background, but does not automatically start on
  startup."), and the "Start automatically on startup" switch carries help that
  says what flipping it changes, in each of its states.

- [#146](https://github.com/subshell-ai/subshell/pull/146) [`410a0c1`](https://github.com/subshell-ai/subshell/commit/410a0c1234929187e8c0080392c31c7b36e4b1cf) Thanks [@theogravity](https://github.com/theogravity)! - The Subshell Client's Control Plane section is now a LIST of control planes
  to connect to, not one address tied to the node: add an address, open a row
  in the dashboard or the system browser, copy its URL, remove one — and the
  address this machine's node reports to sits pinned at the top badged "this
  node", not removable here because detaching a machine is the Service
  section's act, not this list's. The section is a bare table with the add on
  the bottom bar, and every confirmation in the app — removing a row,
  uninstalling the service, un-enrolling, replacing the node CLI, spending a
  setup key — now answers in a dialog instead of a panel grown inside the
  section it belongs to.
  
  Service gained the node's own binding acts in an "Enrolled to Control Plane"
  card: Re-enroll… opens the enrollment wizard, seeded with the current
  address, so re-binding the machine is the same walk as binding it the first
  time — and its two-phase confirmation is what guards overwriting a live
  configuration; and Un-enroll… stops the service, removes its definition and
  deletes the node's configuration and key. Running subshells keep running, and
  the card says so before it asks; the control plane keeps its node row until
  its owner deletes it there. A press now owns its wait: the button keeps its
  spinner and the state chip reads "Restarting…" until the node is confirmed
  back up, or the thirty-second window says it is not, and the momentary
  problem notes stay quiet while the machine is coming back from a press. What
  remains after that is said as a warning; a step that went fine leaves no
  receipt line.
  
  The node CLI gains `subshell unenroll [--yes] [--json]` for the same act
  from the terminal. It deletes only the daemon lock and the configuration —
  the data directory, the installed binary and every live pane stay — and it
  refuses a running daemon UNCONDITIONALLY (it holds the config in memory and
  would keep the plane seeing an online node), and refuses running subshells,
  listing them, unless --yes.
  
  The same wave finished the reset chain's first real runs: `subshell service
  uninstall` now treats launchd's "No such process" as the goal reached (a stop
  already booted the job out — reporting the second bootout as failure stalled
  every macOS reset between stop and delete), and the client's chain carries the
  same tolerance for older installed CLIs, refuses outright while a daemon still
  answers its lock file, and sends the app to the beginning of the walk when the
  chain completes.
  
  The tray menu now mirrors the section: a **Control Plane** submenu lists every
  saved address - the one this machine's node reports to first - and each opens
  **Open in App** or **Open in Browser**. **Open Last** replays the most recent
  plane open through the door it used. "This machine..." reads Open Client App,
  and the submenu repaints itself whenever the list or the node's binding
  changes. Reset Everything now clears the app's saved control planes too, so
  the app lands at the beginning again after a reset, as the ruling asked.

- [#150](https://github.com/subshell-ai/subshell/pull/150) [`366112d`](https://github.com/subshell-ai/subshell/commit/366112d1c25f1346e9abb573b30f34b8071138ae) Thanks [@theogravity](https://github.com/theogravity)! - Rotated keys have a way home. `subshell configure` takes `--key`: it stores the rotated node key the node's page shows once in that machine's own config, keeping the node's identity and spending no setup key, and it refuses an `nsk_` setup key by name so the two credentials cannot be confused at a terminal. On the node page, Rotate key is now a dedicated card that ends with the two copyable commands which install the new key and bring the node back, plus a Client App tab saying plainly that Subshell Client takes a setup key and registers a new node, so a node key belongs on the command line. The rotate response's guidance line names the real command at last; the `subshell config` verb it used to name has never existed.

## 0.14.3

### Patch Changes

- [#128](https://github.com/subshell-ai/subshell/pull/128) [`72be530`](https://github.com/subshell-ai/subshell/commit/72be53097f2628eb1d2e20a575826108ddac5e0f) Thanks [@theogravity](https://github.com/theogravity)! - A refused download now reports the control plane's own message, so the remedy it names reaches the node's log instead of only the HTTP status.

## 0.14.2

### Patch Changes

- [#120](https://github.com/subshell-ai/subshell/pull/120) [`54bb50d`](https://github.com/subshell-ai/subshell/commit/54bb50d43dcd76d9fb3b9c5d5a71de48164de711) Thanks [@theogravity](https://github.com/theogravity)! - Terminal input now queues and retries on reconnect: keystrokes are acknowledged, retried if the connection drops, and large pastes are chunked so no frame exceeds what a node accepts. The node also stops queueing your typing behind its other work, so keys land while captures and probes run.

## 0.14.1

### Patch Changes

- [#114](https://github.com/subshell-ai/subshell/pull/114) [`e746277`](https://github.com/subshell-ai/subshell/commit/e746277e24d1ca8d81e79d7de57b4d9022ea8453) Thanks [@theogravity](https://github.com/theogravity)! - UI copy in the node dashboard and the shared node-admin cards now follows the new two-sentence, no-em-dash style rule: service and control-plane explanations were tightened to at most two sentences with their em dashes replaced, and the maintenance confirmation keeps its load-bearing consequence while dropping the reassurance clause already recorded in `docs/security.md`.

## 0.14.0

### Minor Changes

- [#97](https://github.com/subshell-ai/subshell/pull/97) [`1877b4b`](https://github.com/subshell-ai/subshell/commit/1877b4bb1eaf81f820478b22f1382e51a6c9b91f) Thanks [@theogravity](https://github.com/theogravity)! - A node now serves its own admin dashboard on loopback. `subshell run` binds it
  beside the daemon (and `subshell dashboard` runs the page without the daemon, to
  fix a machine whose agent is stopped); it is on by default, `SUBSHELL_DASHBOARD=0`
  opts out, `--dashboard-port`/`SUBSHELL_DASHBOARD_PORT` moves it off `:3090`.
  
  Three pages — Status, Settings, Updates — answer the machine about itself, so the
  box is operable headless with or without a plane, on the same host as the server.
  No login: everything the local CLI lets this OS user do, the page can do, and it
  binds `127.0.0.1` only (the DNS-rebinding Host check, the cross-origin Origin
  check, and a JSON-content-type requirement on every mutation are the access
  control). Updating is the same signed-manifest trust chain as `subshell update`;
  the allowed-dirs list is read-only here because the plane owns it and re-pushes
  on every reconnect. The compiled `cli-node-v*` binary carries the pages embedded.

## 0.13.0

### Minor Changes

- [#93](https://github.com/subshell-ai/subshell/pull/93) [`b87d11d`](https://github.com/subshell-ai/subshell/commit/b87d11d65de43b44c1495e6317cfd37a17619b4c) Thanks [@theogravity](https://github.com/theogravity)! - Release tags now read `<form>-<role>-v`: the control plane publishes under
  `cli-server-vX.Y.Z` and the node CLI under `cli-node-vX.Y.Z`, matching the
  `desktop-server-v` / `desktop-client-v` pair. Artifact file names are
  unchanged.
  
  This is a hard cutover with no compatibility fallback: a binary reads only its
  own compiled-in prefix, so an installation from before this release will never
  see this release, or any after it. Reinstall from `install-server.sh` (or
  re-run the node enroll one-liner) rather than waiting for self-update.
  
  Riding that cutover: the signed `release-manifest.json` renames its
  `minAgentVersion` field to `minNodeVersion`, and `GET /api/admin/status` renames
  `versions.minAgent` to `versions.minNode`. The manifest field is wire format
  inside signed bytes, so it could only move in a release that already makes every
  earlier one unreadable — which the tag change does.

## 0.12.0

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

### Patch Changes

- [`decd321`](https://github.com/subshell-ai/subshell/commit/decd3211cedd9536c36985202d4f82b1e8d15520) Thanks [@theogravity](https://github.com/theogravity)! - Signed releases: the update paths stop trusting the release source (spec 2026-09-17). Every release now carries `release-manifest.json` plus a detached minisign signature over its exact bytes (`release-manifest.json.sig`), made with the same publisher keypair the desktop apps' updater uses — one key now guards all four components — and every install digests come from the manifest's signed `assets` map instead of the release source's `.sha256` sidecar. `subshell update`, `subshell-server update`, the dashboard's Server and node update flows, and the downloads route's lazy artifact fetch all verify the signature against a pubkey compiled into the product before anything is downloaded or replaced, and an unsigned or unverifiable release is refused by name rather than offered. `update --from` stays signature-free — a file the operator named is their decision.
  
  Node protocol 12: the `update` command carries the verified manifest and its signature, and the agent re-verifies both against its own compiled-in key before swapping, so a node's trust is the publisher's, not its plane's. Agents below protocol 12 are no longer sent update commands at all (they would ignore the new fields); the Nodes and Updates pages say so and name the by-hand verb. Server and agent must ship together: this node release is 0.11.1, one patch above the new `MIN_AGENT_VERSION` floor of 0.11.0. The floor has one consequence a fleet admin will feel: nodes running agents below 0.11.0 are not offered updates at all — each must be updated by hand once on the machine (`subshell update` at its keyboard, or a reinstall) before the page can keep it current from there.
  
  Operator action: `release.yml` now refuses every CLI shard, not just the desktop ones, when `TAURI_SIGNING_PRIVATE_KEY` is unset, and the publish job merges the per-shard manifests into one signed release manifest.

## 0.10.2

### Patch Changes

- Updated dependencies [[`b68c249`](https://github.com/subshell-ai/subshell/commit/b68c2495e2beea0b470d089dd9ec705f46d669e8), [`e69d619`](https://github.com/subshell-ai/subshell/commit/e69d619de7221bbeb1d55c0b4a8602b816303492), [`dbccc29`](https://github.com/subshell-ai/subshell/commit/dbccc29d411a519039d15197b08c9d063fa892f3)]:
  - @subshell-ai/plugin-api@2.1.2
  - @internal/pane-runtime@1.0.0

## 0.10.1

### Patch Changes

- Updated dependencies [[`a5c9810`](https://github.com/subshell-ai/subshell/commit/a5c9810308afed92f1da95841a6c6fe4de65d5ea)]:
  - @subshell-ai/plugin-api@2.1.1
  - @internal/pane-runtime@1.0.0

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
