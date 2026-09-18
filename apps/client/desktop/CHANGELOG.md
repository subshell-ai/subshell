# @internal/desktop-client

## 0.6.1

### Patch Changes

- [#83](https://github.com/subshell-ai/subshell/pull/83) [`7c9f1ca`](https://github.com/subshell-ai/subshell/commit/7c9f1ca57e0ffebbb3a4629a76cea62e057e3c5e) Thanks [@theogravity](https://github.com/theogravity)! - Both desktop apps now say so when a tmux install fails, and Subshell Server's
  first run explains what macOS is about to ask.
  
  A tmux install that failed reported one line — whatever the package manager's
  stderr happened to end on — above a button that redrew exactly as it had been,
  so it read as a press that had done nothing. An install that exited zero and
  left no tmux said nothing at all. Both now render a failure card: the app's own
  sentence about what happened, the manager's last word beside it, and the whole
  run behind Show output. The button reads **Try again** and re-reads the machine
  before it spawns anything, so coming back from a terminal where you installed
  tmux yourself just works.
  
  On macOS, Subshell Server's first run ends on the permissions screen — what
  macOS will ask, and why — between "Subshell Server Is Ready" and the dashboard.
  Nothing on it blocks, and it is shown once, on a first run only.

## 0.6.0

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

- [#80](https://github.com/subshell-ai/subshell/pull/80) [`d959af5`](https://github.com/subshell-ai/subshell/commit/d959af54fb17a953f2aed3f48efe9c54e77e27e2) Thanks [@theogravity](https://github.com/theogravity)! - The Enroll step's node name is required. It was optional because `subshell enroll`
  defaulted to the machine's hostname, which is how a laptop ended up on the Nodes page
  under a name nobody had chosen; the CLI requires the argument now, and so does this
  form. The field is also what the control plane will store, character for character —
  the name is normalized by the shared rule rather than sent raw — and a retry after a
  spent key keeps the name you typed instead of making you enter it again. The field's own
  emptiness test runs on that normalized value rather than on the trimmed text, because
  `trim()` strips whitespace and nothing else: a name that is only a stray control
  character looked answered, sent an empty string, and was refused several layers down by
  the Rust command — after the button had been clickable.

## 0.5.1

### Patch Changes

- [`cc18b5a`](https://github.com/subshell-ai/subshell/commit/cc18b5a9c3851cbec35a80f51d807da5c3589868) Thanks [@theogravity](https://github.com/theogravity)! - Every docs link in both desktop apps opens in the system browser
  
  Tauri denies a page's request for a new window — a `target="_blank"` link,
  `window.open` — unless the window carries a handler, and it denies silently.
  Both apps' windows carried none, so every "Docs" link the served pages offer,
  the Tailscale card's among them, looked broken inside the app while working
  in a browser.
  
  Each window now answers the request itself: never an in-app webview (these
  windows' capability files were written for one page each), http(s) handed to
  the person's own system browser, and every other scheme dropped rather than
  handed to the OS.

## 0.5.0

### Minor Changes

- [`e23becd`](https://github.com/subshell-ai/subshell/commit/e23becda75a46db7ae10b22e71aa95a6e555edae) Thanks [@theogravity](https://github.com/theogravity)! - Both desktop apps update themselves, and the CLI they install goes through its own `update`
  
  Two separate things could be out of date on a machine running one of these
  apps, and until now only one of them had an update path at all.
  
  **The app.** Each app checks the project's own release list once a day on
  launch — and never opens a window to say so: the only thing that changes is a
  tray item, which grows "(0.7.0 available)". **Check for Updates…** is there
  whether or not that check has run, and it opens an assistant screen that
  downloads, verifies and installs, then relaunches. The bytes are refused
  unless they carry a signature matching a public key compiled into the app, so
  a compromised release host can withhold an update but cannot supply one. On
  Linux the package goes through dpkg, and the screen says so before the press
  rather than raising an unexplained password sheet. `SUBSHELL_RELEASE_URL`
  repoints the source and an empty value turns it off entirely.
  
  **The CLI each app ships.** Replacing the installed `subshell-server` (or
  `subshell`) no longer copies a file: the app hands the bundled binary to the
  INSTALLED one's own `update --from`. That makes the desktop path the same
  transaction as every other — the database is backed up first, `.previous` is
  kept, and a server whose migrations fail reverts at boot — where before it was
  the one update on the machine with nothing behind it to roll back to. The
  screen now names what moved and where the backup went. A first install is
  unchanged; so is the second step, which is still the app's to take.
  
  A CLI older than the `update` verb — which is every one installed today — falls
  back to the plain copy it used before, and the screen says what that cost:
  *"Installed 0.7.0 over 0.6.0. No database backup was taken: the previous server
  predates the update command, so this install cannot be rolled back
  automatically."* (The node app's says "No rollback point was recorded": an
  agent has no database, and claiming a missing backup would be alarming about
  something that was never going to happen.)
  
  The fallback fires on exactly one thing — the CLI's own `unknown command
  'update'`, on a run that finished and failed. A pane-safety refusal, an
  unwritable binary, a digest mismatch or a version the file does not confirm is
  still a failure, because copying the file anyway would skip the backup while
  reporting success.

## 0.4.0

### Minor Changes

- [`21f3904`](https://github.com/subshell-ai/subshell/commit/21f3904d82bbaf2ddee3980a372768b08d09ac9b) Thanks [@theogravity](https://github.com/theogravity)! - **Open in Browser**, in the tray menu and under View — it hands the control
  plane page you are looking at to your default browser, with your profile, your
  password manager and your extensions. The plane's own sidebar grows the same
  row, and a subshell's actions menu grows one that opens that subshell.
  
  The browser will ask you to sign in: a webview's session does not cross to it.
  
  This is the first thing the control plane's window in this app is allowed to
  ask for. It asks for a PATH and nothing more — the address comes from the plane
  this window is already pinned to — so a page cannot point the browser at a host
  you did not choose. Everything that touches this machine, the agent or the
  service is still reachable only from the app's own node window.

## 0.3.0

### Minor Changes

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

- [`9aa9df9`](https://github.com/subshell-ai/subshell/commit/9aa9df95b80c8e87bdfc4336598906e5a295f185) Thanks [@theogravity](https://github.com/theogravity)! - The Addresses form on Server Settings → Service checks what you typed before sending it, and says what is wrong under the field it is about. The rules are the server's own — the same ones `subshell-server configure` applies — so the form cannot refuse a value the server would have taken, or accept one it would not. Save is now "Save and restart", and goes through the same confirmation as the Restart button, since saving an address the server is not listening on was never the point; cancelling that confirmation still leaves the change saved. Each field explains the mistake it invites — which bind address is the permissive one, and that a browser at an unlisted address is refused at sign-in with "Invalid origin" — instead of one sentence glossing all four.
  
  Where a restart would close running subshells, the dashboard now names the command that fixes it (`subshell-server service install`) rather than telling you to "reinstall the service definition", which is not something the dashboard can do. It no longer warns about a service definition on machines that have none.
  
  Both About boxes read "Desktop app" and "CLI", the same words the downloads carry. Subshell Server's said "Server" and "Subshell Server" — two programs named one word apart, usually showing the same version.
  
  For developers: `bun run dev:desktop-server` points the dashboard window at the SPA's dev server when one is running, so edits to the dashboard hot-reload. It never did before — that window loads the installed binary's embedded SPA — and the Service and Status pages say so while it is in effect.

- [`f73f29a`](https://github.com/subshell-ai/subshell/commit/f73f29a3ba94c019537b8414e3a36c0662b9cb53) Thanks [@theogravity](https://github.com/theogravity)! - Profiles are **presets** now, and the rename is the least of it. A preset is one agent's saved launch customisation — env, flags, settings, auto-restart — and it has one job now: it is OPTIONAL. Launching needs only an agent and a folder.
  
  That optionality is what deleted the machinery. Every launch once required a row, which is why the server seeded a blank **Default** profile per user and per plugin at four seams and refused to delete it. A fresh instance now has zero presets and can launch immediately; every preset is deletable, and deleting one nulls the reference on the subshells that used it, whose next restart falls back to the plain launch rather than failing.
  
  **Upgraded instances lose the seeded Default rows too.** Migration `0027` deletes every row the old seeder marked and frees the subshells that pointed at them, so an upgraded instance is presetless of Defaults exactly like a fresh one — a blank phantom preset beside the new "None" would resurrect the deleted concept. Every preset **you** created converts unchanged — including one you NAMED "Default": the purge hunts the seeder's flag, never the string. But an **edited seeded Default is removed WITH the seeded rows** — your customisation lived on a row the seeder flagged, and the flag is what marks it for deletion, not the text inside. Copy anything you need out of it before upgrading.
  
  **A preset name is now unique per agent, per user, ignoring case.** It always claimed to be — `0001-init.ts` documented the invariant while the index enforced nothing — which is how an agent asking for a preset by name could get whichever row sorted first. Migration `0028` adds the real constraint, and create and rename answer 409 on a collision, the way workspace names already did. Existing duplicates are **renamed, never deleted**: the oldest keeps the name and the rest take " (2)", " (3)" in creation order, each keeping its own capitalisation. The only way to notice is if you were deliberately running two same-named presets for one agent — in which case they were already indistinguishable in every picker.
  
  Presets no longer pin a node. The pin was the biggest part of the launch form's state machine and of the divergence between web and mobile; with the agent chosen first, node compatibility is decided by the agent, and the node picker's own default rules are unchanged.
  
  Agents on the instance list presets through MCP (`list_presets`) and launch with `create_subshell` taking `harness` plus an optional `preset`.
  
  **Enrolled nodes must update their agent.** The node protocol moves to 7 — the launch frame's `profile` field becomes `preset`, wire-shaped and not semantic — and the gate is exact-match, so a lagging agent is refused with a named version to install (the floor is 0.5.0). Both desktop apps ship in the same cut, re-bundling the CLI each wraps; cut the release as `app=all`. SPA work ships embedded in the server binary, which is why it has no changeset of its own.

- [`3f0b87a`](https://github.com/subshell-ai/subshell/commit/3f0b87af6bb858f16fef765f6428a8d5e7c5a5d2) Thanks [@theogravity](https://github.com/theogravity)! - Both desktop apps can now be resized down to 360×240 — a third of the old 1024×640 minimum. That floor existed so the window could never fall below the web UI's 1024px breakpoint and render its narrow, phone-style chrome; the cost was a window too big to park in a corner beside an editor, which is a normal thing to want from a terminal. The narrow layout is a designed one, so crossing that breakpoint is now the user's call. The floor still scales with the app's text size, so the window stays as usable at 200% as at 100%.

## 0.2.0

### Minor Changes

- [`5069f71`](https://github.com/subshell-ai/subshell/commit/5069f716c4be32fd95604465a76afabf6eb5cf4d) Thanks [@theogravity](https://github.com/theogravity)! - Subshell Client has an About section.
  
  At the bottom of the node window: the Subshell wordmark, the app version and
  the agent version on one line, a short line of what the app is, links to the
  website, the licence and the company, and the copyright. The same content
  Subshell Server's console shows under About, so the two apps say the same
  thing about what this is and who owns it.
  
  macOS already had this in the app menu. Linux has no menu bar, so there was
  nowhere to find a version number without knowing the platform's conventions.

- [`c9dbd53`](https://github.com/subshell-ai/subshell/commit/c9dbd5384f75b28e45998755b45d7fe536da804f) Thanks [@theogravity](https://github.com/theogravity)! - Both desktop apps can change their text size. ⌘+ / ⌘− / ⌘0 in the View menu on
  macOS, a **Text Size** submenu in the tray everywhere, and the choice is
  remembered per app. The window showing a control plane's own page follows it
  too, without being granted anything: the level is applied from the native
  shell rather than asked for by the page. The setup assistant's frame grows with
  its text, up to what the display can show.

- [`0898438`](https://github.com/subshell-ai/subshell/commit/0898438649cb9b08e8caf8dc4abc114bebc96c5c) Thanks [@theogravity](https://github.com/theogravity)! - The node window is a setup-assistant-style flow: connect to a server, install the agent, enroll this machine, start the node service, and a connected screen that opens the control plane. Facts about how the agent runs moved to the control plane's Nodes page, which is where a person looking at several machines can see them together. Reset from the native app. The tray preference is a check item in the tray menu.

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

### Patch Changes

- [`5fe5a7b`](https://github.com/subshell-ai/subshell/commit/5fe5a7b2730428332b281a820353fa20a25510cc) Thanks [@theogravity](https://github.com/theogravity)! - Setting up again after a reset no longer fails with "launchctl bootstrap failed (exit 5): Input/output error" on macOS. Removing a service does not take it out of launchd's hands immediately, and the install was reading the plist file on disk to decide whether the previous one needed removing — a file a reset had already deleted while the job was still leaving. The install now always clears the old registration and waits for the domain, retrying only while launchd says it is busy; a genuinely bad service definition still fails with launchd's own words (launchd answers the same code for some malformed plists, so those now wait out the retry before reporting).
  
  Resetting the Subshell Server app also restarts the app, which is what takes you back to first-run setup instead of leaving a dashboard open on an instance that no longer exists — including when the dashboard is set to close to the tray, where it was previously hidden rather than closed and could be brought back pointing at a server that was gone.
  
  In Subshell Client, opening About twice in quick succession no longer loses the second request.

## 0.1.3

### Patch Changes

- [`4045075`](https://github.com/subshell-ai/subshell/commit/4045075c6fce283b8ab695cb16af7d79988c2f64) Thanks [@theogravity](https://github.com/theogravity)! - Subshell Client's settings file can no longer tear.
  
  Both desktop apps share `crates/desktop-core`'s `Settings`, and its `save` was
  one `std::fs::write`. A crash between the truncate and the last byte left JSON
  that `load`'s forgiving parse reads as "no settings", silently discarding the
  user's chosen binary and their control-plane URL. It is now a temp file plus a
  rename in the same directory, so a kill mid-save leaves the previous file
  intact.
  
  Nothing else about this app changes. The fix arrived with the server app's
  first-run work, which needed the same file to be a durable record, and it is
  released here because it is this app's behaviour too.

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
