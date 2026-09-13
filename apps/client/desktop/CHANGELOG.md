# @internal/desktop-client

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
