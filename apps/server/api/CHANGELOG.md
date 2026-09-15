# @internal/server

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
