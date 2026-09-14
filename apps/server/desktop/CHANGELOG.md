# @internal/desktop-server

## 0.4.0

### Minor Changes

- [`9aa9df9`](https://github.com/subshell-ai/subshell/commit/9aa9df95b80c8e87bdfc4336598906e5a295f185) Thanks [@theogravity](https://github.com/theogravity)! - The Addresses form on Server Settings → Service checks what you typed before sending it, and says what is wrong under the field it is about. The rules are the server's own — the same ones `subshell-server configure` applies — so the form cannot refuse a value the server would have taken, or accept one it would not. Save is now "Save and restart", and goes through the same confirmation as the Restart button, since saving an address the server is not listening on was never the point; cancelling that confirmation still leaves the change saved. Each field explains the mistake it invites — which bind address is the permissive one, and that a browser at an unlisted address is refused at sign-in with "Invalid origin" — instead of one sentence glossing all four.
  
  Where a restart would close running subshells, the dashboard now names the command that fixes it (`subshell-server service install`) rather than telling you to "reinstall the service definition", which is not something the dashboard can do. It no longer warns about a service definition on machines that have none.
  
  Both About boxes read "Desktop app" and "CLI", the same words the downloads carry. Subshell Server's said "Server" and "Subshell Server" — two programs named one word apart, usually showing the same version.
  
  For developers: `bun run dev:desktop-server` points the dashboard window at the SPA's dev server when one is running, so edits to the dashboard hot-reload. It never did before — that window loads the installed binary's embedded SPA — and the Service and Status pages say so while it is in effect.

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

- [`f73f29a`](https://github.com/subshell-ai/subshell/commit/f73f29a3ba94c019537b8414e3a36c0662b9cb53) Thanks [@theogravity](https://github.com/theogravity)! - Profiles are **presets** now, and the rename is the least of it. A preset is one agent's saved launch customisation — env, flags, settings, auto-restart — and it has one job now: it is OPTIONAL. Launching needs only an agent and a folder.
  
  That optionality is what deleted the machinery. Every launch once required a row, which is why the server seeded a blank **Default** profile per user and per plugin at four seams and refused to delete it. A fresh instance now has zero presets and can launch immediately; every preset is deletable, and deleting one nulls the reference on the subshells that used it, whose next restart falls back to the plain launch rather than failing.
  
  **Upgraded instances lose the seeded Default rows too.** Migration `0027` deletes every row the old seeder marked and frees the subshells that pointed at them, so an upgraded instance is presetless of Defaults exactly like a fresh one — a blank phantom preset beside the new "None" would resurrect the deleted concept. Every preset **you** created converts unchanged — including one you NAMED "Default": the purge hunts the seeder's flag, never the string. But an **edited seeded Default is removed WITH the seeded rows** — your customisation lived on a row the seeder flagged, and the flag is what marks it for deletion, not the text inside. Copy anything you need out of it before upgrading.
  
  **A preset name is now unique per agent, per user, ignoring case.** It always claimed to be — `0001-init.ts` documented the invariant while the index enforced nothing — which is how an agent asking for a preset by name could get whichever row sorted first. Migration `0028` adds the real constraint, and create and rename answer 409 on a collision, the way workspace names already did. Existing duplicates are **renamed, never deleted**: the oldest keeps the name and the rest take " (2)", " (3)" in creation order, each keeping its own capitalisation. The only way to notice is if you were deliberately running two same-named presets for one agent — in which case they were already indistinguishable in every picker.
  
  Presets no longer pin a node. The pin was the biggest part of the launch form's state machine and of the divergence between web and mobile; with the agent chosen first, node compatibility is decided by the agent, and the node picker's own default rules are unchanged.
  
  Agents on the instance list presets through MCP (`list_presets`) and launch with `create_subshell` taking `harness` plus an optional `preset`.
  
  **Enrolled nodes must update their agent.** The node protocol moves to 7 — the launch frame's `profile` field becomes `preset`, wire-shaped and not semantic — and the gate is exact-match, so a lagging agent is refused with a named version to install (the floor is 0.5.0). Both desktop apps ship in the same cut, re-bundling the CLI each wraps; cut the release as `app=all`. SPA work ships embedded in the server binary, which is why it has no changeset of its own.

- [`3f0b87a`](https://github.com/subshell-ai/subshell/commit/3f0b87af6bb858f16fef765f6428a8d5e7c5a5d2) Thanks [@theogravity](https://github.com/theogravity)! - Both desktop apps can now be resized down to 360×240 — a third of the old 1024×640 minimum. That floor existed so the window could never fall below the web UI's 1024px breakpoint and render its narrow, phone-style chrome; the cost was a window too big to park in a corner beside an editor, which is a normal thing to want from a terminal. The narrow layout is a designed one, so crossing that breakpoint is now the user's call. The floor still scales with the app's text size, so the window stays as usable at 200% as at 100%.

## 0.3.0

### Minor Changes

- [`90972be`](https://github.com/subshell-ai/subshell/commit/90972bef8023c7a5896f1578169673934702bd0e) Thanks [@theogravity](https://github.com/theogravity)! - Agent CLIs are installed by the control plane on an admin's request (`POST /api/setup/agents/:id/install`, built-in ids only, audited), from the setup assistant's Add an Agent screen. Subshell Server no longer carries its own installer table or the `desktop_install_agent` command; its status page points at the dashboard instead.

- [`c9dbd53`](https://github.com/subshell-ai/subshell/commit/c9dbd5384f75b28e45998755b45d7fe536da804f) Thanks [@theogravity](https://github.com/theogravity)! - Both desktop apps can change their text size. ⌘+ / ⌘− / ⌘0 in the View menu on
  macOS, a **Text Size** submenu in the tray everywhere, and the choice is
  remembered per app. The window showing a control plane's own page follows it
  too, without being granted anything: the level is applied from the native
  shell rather than asked for by the page. The setup assistant's frame grows with
  its text, up to what the display can show.

- [`3bcbf6a`](https://github.com/subshell-ai/subshell/commit/3bcbf6ae3e668ca37431ace52624aaea4ddc29ab) Thanks [@theogravity](https://github.com/theogravity)! - A sidebar item can be a group now — a label with a chevron that opens to pages — and both navigations use one.
  
  In the web UI the admin pages are one **Server Settings** group: General, Users, API keys, Plugins, Status, Audit log. The old Instance page was a scroll of unrelated cards, so it split: system API keys and the audit trail are pages of their own, the local-launch switch moved to the control-plane host's own node page beside its allowed directories, and Plugins is in the rail instead of behind a header button. Users joined the group, and a member's rail no longer lists it — the roster stays readable by URL and in the sharing picker. No route moved.
  
  In Subshell Server's console, Addresses is a setting, so it sits under a **Settings** group with the tray and reset section, which is now called **Application**. Overview, Logs and About are unchanged.
  
  A group follows where you are: it opens when you are on one of its pages and shuts when you leave, and the chevron overrides that until you navigate again.

- [`bdb5a5c`](https://github.com/subshell-ai/subshell/commit/bdb5a5c92b4fed7d8f47132a086e7a52a3f03229) Thanks [@theogravity](https://github.com/theogravity)! - The Subshell Server console is four sections behind a sidebar, not one scroll of cards.
  
  Everything used to be on screen at once: a small status chip over a nine-row
  fact list, the action card, the tray checkbox, a log pane and a danger-zone
  disclosure. The window now opens on **Overview**, where a status hero says
  whether the server is running, which version it is and where to reach it, with
  its actions directly underneath and the diagnostic facts below them.
  **Addresses**, **Logs** and **Settings** are their own sections in a sidebar.
  
  - Editing addresses is a place you can go from anywhere rather than a button
    that replaced the page's one card, and it explains itself when a machine has
    nothing to configure yet.
  - The log pane fills its section instead of being capped, and a command's
    output no longer competes with the buttons: each press reports its outcome on
    one line, with a link to the full output.
  - The reset confirmation covers the whole window, so nothing can be navigated
    out from under it.
  - The window opens at 900x640 rather than 720x620.
  
  **About** is a new section: the Subshell wordmark, the app and server versions,
  links to the website, the licence and the company, and the copyright. Its links
  open in your own browser rather than inside the app.

- [`0898438`](https://github.com/subshell-ai/subshell/commit/0898438649cb9b08e8caf8dc4abc114bebc96c5c) Thanks [@theogravity](https://github.com/theogravity)! - Launching the app opens the dashboard when the server is running. The management console is gone: everything it showed lives in the dashboard's Server Settings → Service, which a browser on the LAN and a headless install reach as well. The app keeps one native assistant for what a page the server serves cannot do — first run, a server that is not running, updating the bundled server, and reset. The window follows a port change on its own, so editing the port in the dashboard no longer leaves the app pointed at an address nothing answers on. The tray preference is a check item in the tray menu.

- [`eabe4b0`](https://github.com/subshell-ai/subshell/commit/eabe4b0b9c108e92fa6438e64fe2bd56d79bc068) Thanks [@theogravity](https://github.com/theogravity)! - Whether the server runs in the background, and whether it starts at every login, are two questions you can answer instead of two things the setup screen assumed.
  
  `subshell-server service enable` and `service disable` arm and disarm start-at-login without touching the running process, and `service install --no-autostart` installs a service that runs now but does not come back. The dashboard's Service page carries the same switch (`POST /api/admin/server/autostart`), which is the one service control a served page gets — it changes nothing about the running process, so the page asking for it cannot take itself down. It is disabled with the reason where the question has no answer: nothing installed, the desktop app running this server, or a manager that would not say.
  
  The Subshell Server setup screen's "Start it in the background, and at every login" is now two checkboxes, both checked by default. Unchecking the first runs the server as the app's own child — alive while the app is open, stopped when you quit, with running subshells kept — and the dashboard reports that honestly, so Restart server keeps working there.
  
  Switching between the two later is a "How this server runs" card on the Service page, with both modes always shown and the machine's own marked. Picking the other one IS the choice: it confirms in a dialog on that page, which lists what the switch will do and warns when this machine's service definition is old enough that removing it would close every running subshell. A browser on the LAN sees the card read-only, with a line saying where it can be changed. A server nobody supervises — started by hand, in a container — now shows neither mode rather than claiming the background one. The switch is recorded in the audit trail as `server.supervision.request`.
  
  On macOS, "starts at login" is now which directory the launchd plist lives in rather than a key inside it. `RunAtLoad=false` does not stop a `KeepAlive=true` job (measured), and `launchctl disable` makes "running now but not at login" inexpressible while leaving a mark that survives uninstall.
  
  Two supervisor faults behind "the app runs the server" are fixed. Stopping a server while it was waiting to respawn after a crash could wedge the supervisor for the life of the app — every later Start did nothing, silently — and a Start that arrived while the previous loop was still winding down told that loop a server was wanted and then put it back to sleep for the rest of its respawn delay.

- [`3ff8ac5`](https://github.com/subshell-ai/subshell/commit/3ff8ac5c1811873e70abba3d4e764caa3f047103) Thanks [@theogravity](https://github.com/theogravity)! - First run is a setup assistant: Welcome, Install tmux (only when missing), and one "Set Up" press with a progress checklist, in a fixed window the dashboard then takes over in place. The six-step wizard, its Agents step (which could not detect anything) and its log pane are gone; the dashboard's own setup wizard asks about agents.

### Patch Changes

- [`5fe5a7b`](https://github.com/subshell-ai/subshell/commit/5fe5a7b2730428332b281a820353fa20a25510cc) Thanks [@theogravity](https://github.com/theogravity)! - Setting up again after a reset no longer fails with "launchctl bootstrap failed (exit 5): Input/output error" on macOS. Removing a service does not take it out of launchd's hands immediately, and the install was reading the plist file on disk to decide whether the previous one needed removing — a file a reset had already deleted while the job was still leaving. The install now always clears the old registration and waits for the domain, retrying only while launchd says it is busy; a genuinely bad service definition still fails with launchd's own words (launchd answers the same code for some malformed plists, so those now wait out the retry before reporting).
  
  Resetting the Subshell Server app also restarts the app, which is what takes you back to first-run setup instead of leaving a dashboard open on an instance that no longer exists — including when the dashboard is set to close to the tray, where it was previously hidden rather than closed and could be brought back pointing at a server that was gone.
  
  In Subshell Client, opening About twice in quick succession no longer loses the second request.

- [`b09dae4`](https://github.com/subshell-ai/subshell/commit/b09dae4bffb2a3d26911d952299956b50186ad51) Thanks [@theogravity](https://github.com/theogravity)! - The setup assistant's Welcome screen shows the full Subshell wordmark instead of the `/s` app icon, and both frames — the native page and the server's own `/setup` screens, which are one specification — center their column in the window rather than pinning it below a fixed top margin.

## 0.2.0

### Minor Changes

- [#38](https://github.com/subshell-ai/subshell/pull/38) [`6a3daa8`](https://github.com/subshell-ai/subshell/commit/6a3daa8956f7d42658da5b55db03d104ef013468) Thanks [@theogravity](https://github.com/theogravity)! - First-run setup is now a guided wizard in its own window, and a hostname-confirmed "reset this machine" wipes the instance from the dashboard's Settings danger zone.

- [`e67b068`](https://github.com/subshell-ai/subshell/commit/e67b068a603991536ddad1668a198dc12a981f7c) Thanks [@theogravity](https://github.com/theogravity)! - One-press setup: a machine with nothing installed now gets a single disclosed "Set up and start" button instead of a four-step flow, and the app installs tmux (platform package manager, never a bare sudo) and Claude Code from the console instead of sending the user to a terminal.

### Patch Changes

- [`f760ae0`](https://github.com/subshell-ai/subshell/commit/f760ae048d5952ef727b3001d356f97dab18d1a8) Thanks [@theogravity](https://github.com/theogravity)! - The Subshell Server console moved to TypeScript, Vite and Tailwind (its logic now builds into `ui/dist`; `tauri dev`/`tauri build` run the build as their own before-hooks). Behavior is unchanged except a fix the rebuild caught: after a failed action the console's "That did not work. See the output below." line is no longer erased by the action's own re-probe before it can appear.

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
