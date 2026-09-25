# @internal/desktop-server

## 1.0.1

### Patch Changes

- [#197](https://github.com/subshell-ai/subshell/pull/197) [`cec0f3a`](https://github.com/subshell-ai/subshell/commit/cec0f3a68c7d99f06da2ce3cf71a471064fbaec0) Thanks [@theogravity](https://github.com/theogravity)! - Four assistant fixes from the first-run report. The tmux gate now says "Waiting for tmux to be installed". On a Mac with no package manager, the Homebrew install steps show by default instead of hiding until the button is pressed. The Photos permission prompt is fixed: it never appeared on the installed app because PhotoKit's consent request was made off the main thread, and it is now dispatched to main. The permission buttons are short ("Allow", "Open Settings") with the row named in each button's accessible label.

## 1.0.0

### Major Changes

- [#184](https://github.com/subshell-ai/subshell/pull/184) [`711b5fa`](https://github.com/subshell-ai/subshell/commit/711b5fa4e8ab31db801800fc1733b0c370c78e58) Thanks [@theogravity](https://github.com/theogravity)! - Marked 1.0.0. The control plane, the node daemon, and both desktop apps
  all mark their first stable release. This entry changes no behavior; it
  records the milestone, and the entries below it are what the milestone is
  made of.

### Minor Changes

- [#180](https://github.com/subshell-ai/subshell/pull/180) [`b28726a`](https://github.com/subshell-ai/subshell/commit/b28726a67fa5f5190358eff9845e5822de6b5b7d) Thanks [@theogravity](https://github.com/theogravity)! - Text size on Linux now answers Ctrl+= / Ctrl+- / Ctrl+0 in every window of both desktop apps. Until now those keys lived only on the macOS menu bar (a GTK menu bar is per-window chrome, so Linux carries none), leaving the tray's Text Size submenu as the only door, and no door at all on a session with no tray host. The tray submenu and the shared zoom ladder are unchanged.

### Patch Changes

- [#176](https://github.com/subshell-ai/subshell/pull/176) [`db5951a`](https://github.com/subshell-ai/subshell/commit/db5951ae26bbc8cd4ea6a32be3114b84df786396) Thanks [@theogravity](https://github.com/theogravity)! - Subshells: state reads as one dot everywhere. The cards' corner chips and the list's STATUS column are gone; both draw the status dot (with the unseen-notification bell) beside the title. Green is now the ALIVE family: bright for printing, dim for quiet-but-running, with the printing dot blinking like Claude Code's in-progress work (still under reduced-motion), and gray means not-running only. An unreachable node is red, not amber. The tile view segments by machine on the sidebar's own grouping and labels, the card's machine pill retired with the chip, and the page grew a machine filter that narrows both views (default All). The Server assistant's setup wizard joins the same motion rule: its in-progress checklist spinner now sits behind the reduced-motion gate, like every other animation.

- [#182](https://github.com/subshell-ai/subshell/pull/182) [`6955725`](https://github.com/subshell-ai/subshell/commit/6955725c3f45d0945adc18dae6234f4b44814fa4) Thanks [@theogravity](https://github.com/theogravity)! - The no-em-dash voice rule applied to shipped copy: every string a person reads on a screen or in a terminal now carries its breath with a comma, colon, parentheses, or a full stop. The tray update item reads "Update available: Subshell Server 0.8.0" (both apps), the node window title "Subshell Client: Node", network plugin hints, both CLIs' refusals and prompts, and the browser-rendered error messages lose their dashes, and so do the /docs endpoint descriptions, the shared MCP tool descriptions, and the desktop apps' permission prose. No wire name, error code, id, or log line changed.

## 0.15.0

### Minor Changes

- [#151](https://github.com/subshell-ai/subshell/pull/151) [`9f56e80`](https://github.com/subshell-ai/subshell/commit/9f56e8078c80ab6d7848960d1d4fbb892ed62076) Thanks [@theogravity](https://github.com/theogravity)! - Reset in the Subshell Server assistant now opens as a dialog over the standing section instead of replacing the window. It keeps the delete plan, the disclosures and the typed-hostname gate, and turns its own dismissal inert while the chain runs. On a machine whose server is running, the rail's Status opens a real status screen, the server's facts and log tail with one Open dashboard button, instead of bouncing through the setup handoff.

- [#151](https://github.com/subshell-ai/subshell/pull/151) [`9f56e80`](https://github.com/subshell-ai/subshell/commit/9f56e8078c80ab6d7848960d1d4fbb892ed62076) Thanks [@theogravity](https://github.com/theogravity)! - A new preference chooses what launching Subshell Server opens on a machine whose server is already running: the dashboard, or the app's own assistant window. The default is the dashboard, which is what every launch does today. It is set from the "Open on launch" row on the assistant's How Your Server Runs screen, and it saves as soon as you change it.

- [#151](https://github.com/subshell-ai/subshell/pull/151) [`9f56e80`](https://github.com/subshell-ai/subshell/commit/9f56e8078c80ab6d7848960d1d4fbb892ed62076) Thanks [@theogravity](https://github.com/theogravity)! - The Subshell Server tray's first item is now "Open Control Plane In App"; it still asks the server which home this machine is owed. A new "Open Server App" sits beside it and raises the app's own window directly, no probe and no server question. That door existed before only through Check-for-Updates, which is not where someone looking for the window would think to press.

### Patch Changes

- [#153](https://github.com/subshell-ai/subshell/pull/153) [`9e8fa3b`](https://github.com/subshell-ai/subshell/commit/9e8fa3bb9d09c450448f4440b6c937bb6bee8e2c) Thanks [@theogravity](https://github.com/theogravity)! - The tray's "Open Server App" no longer flashes. On a running server it was opening the assistant, which handed off to the dashboard and closed itself; it now opens on the standing Status screen and stays. The tray also groups its doors: "Open Control Plane In App" and "Open in Browser" above a divider, "Open Server App" below it. On the Status screen the app's version moved to the top beside the other facts and is joined by the running server's CLI version, and the resolution-rung label under the binary path ("named by the installed service", and its siblings) is gone. The redundant "Server Addresses" tray item is gone too — the assistant's own rail already carries that screen. And the assistant now says "control plane" wherever it once said "dashboard": the Status button, the ready handoff, the Set Up address row, and the supervision launch option.

## 0.14.1

### Patch Changes

- [#146](https://github.com/subshell-ai/subshell/pull/146) [`410a0c1`](https://github.com/subshell-ai/subshell/commit/410a0c1234929187e8c0080392c31c7b36e4b1cf) Thanks [@theogravity](https://github.com/theogravity)! - The supervision and setup screens name no service managers any more. The named thing is the Subshell Server Service; the background option states the CURRENT condition ("Currently the Subshell Server Service runs in the background, but does not automatically start on startup."), the switch reads "Start automatically on startup", and its help says what flipping it changes. Same pattern the client now uses.

## 0.14.0

### Minor Changes

- [#142](https://github.com/subshell-ai/subshell/pull/142) [`67f3196`](https://github.com/subshell-ai/subshell/commit/67f31966cc7bf0707bcb9152ff125ffad653dd78) Thanks [@theogravity](https://github.com/theogravity)! - The client's rail gains Service and Control Plane: the node's machinery (install offer, service verbs, pane-safety rewrite, the node's reveals) and the plane address's home (the configured address, the way to change it, the node's repoint machinery) move out of the status screen, which keeps machine state and shows its facts inline. The status screen's node-update doors are gone; the Update section is the door. The install button speaks for itself: the standing explainer paragraph is gone, and what the copy does is said at the confirmation. On Subshell Server the assistant's supervision section is labeled Service, the reset confirmation rides the rail, and the reset room keeps no Cancel.

## 0.13.0

### Minor Changes

- [#136](https://github.com/subshell-ai/subshell/pull/136) [`106ee7f`](https://github.com/subshell-ai/subshell/commit/106ee7f73ef7cd627192b443f5a8072aa195ba85) Thanks [@theogravity](https://github.com/theogravity)! - The assistant's rail gains Reset as its fifth, destructive-styled section: the door moves into the sidebar while the reset screen stays full-window, so nothing competes with the chain running. With the rail present it is the navigation — the standing screens' leave buttons (Back on How it runs, Back on Addresses, Close on Update) render only where the rail does not, keeping the way out for screens that have none.

- [#134](https://github.com/subshell-ai/subshell/pull/134) [`99e7ee0`](https://github.com/subshell-ai/subshell/commit/99e7ee0022df53204c71242241b24e9d7a7c128f) Thanks [@theogravity](https://github.com/theogravity)! - The server desktop assistant gains a sidebar rail of standing options — Status, Update, How it runs, Addresses — on an onboarded machine's standing screens, and only there: the first-time experience, reset, permissions and boot stay full-window. The recovery screen's Show Details disclosure is gone; its facts, log tail and last output render inline in the Status section, fed while the section is up.

### Patch Changes

- [#130](https://github.com/subshell-ai/subshell/pull/130) [`ade0066`](https://github.com/subshell-ai/subshell/commit/ade006677ee6918d298a1aa3f6c78218685a7779) Thanks [@theogravity](https://github.com/theogravity)! - The recovery screen's secondary actions stack one per row instead of running together on a single line, and they take a press reliably: the background poll no longer tears down and rebuilds the screen every 1.5 seconds when nothing has changed.

- [#132](https://github.com/subshell-ai/subshell/pull/132) [`03270bd`](https://github.com/subshell-ai/subshell/commit/03270bd5831f6b4b6098129fe242fa5eb409dbf8) Thanks [@theogravity](https://github.com/theogravity)! - The assistant window is rebuilt in React. The hand-built DOM render (wizard.ts and the assistant/ modules) is replaced by components over the same pure decision modules, with every string, gate and latch carried over as it was; the shared Frame now lives in `@internal/assistant`, and the screens compose the shadcn kit the client assistant uses. Behavior is unchanged: first run, recovery, update, reset and permissions work as before.

## 0.12.1

### Patch Changes

- [#114](https://github.com/subshell-ai/subshell/pull/114) [`e746277`](https://github.com/subshell-ai/subshell/commit/e746277e24d1ca8d81e79d7de57b4d9022ea8453) Thanks [@theogravity](https://github.com/theogravity)! - UI copy in the Subshell Server assistant now follows the new two-sentence, no-em-dash style rule: the reset, update and permission explanations were tightened to at most two sentences with their em dashes replaced by colons, semicolons or sentence splits, and every fact cut is already carried by the docs.

## 0.12.0

### Minor Changes

- [#108](https://github.com/subshell-ai/subshell/pull/108) [`540eb46`](https://github.com/subshell-ai/subshell/commit/540eb4671143236582d5c0e959da5b0743a8a923) Thanks [@theogravity](https://github.com/theogravity)! - Subshell Server re-ships with the current control plane inside it (server 0.15.x). Desktop users get, through the bundled binary: the machine-scoped folder picker (switching Machine in the launch form re-homes the working directory to that node's own recents/home; Recent, Favorites and the star follow the browsed machine; a constrained node can no longer seed a directory its caller cannot launch in), the consolidated Settings → Logs page with a paginated audit trail, and the fix that lets a never-published instance lazy-fetch node artifacts (the missing `node-artifacts/` directory is created on demand). The app itself is unchanged — this release is the bundle that carries the server forward.

## 0.11.2

### Patch Changes

- [#102](https://github.com/subshell-ai/subshell/pull/102) [`8331f41`](https://github.com/subshell-ai/subshell/commit/8331f411c373a3cef4d9c04c3aabbbabfed660aa) Thanks [@theogravity](https://github.com/theogravity)! - Re-cut bundles the 0.14.0 server binary, so Subshell Server desktop users get
  this release's dashboard work — the sidebar grouped by machine, the row
  tooltips, and the header's status dot. The app itself is unchanged; what moved
  is the server it ships, which is the only server these installs ever get
  (spec 2026-09-18: the app ships the server it installs).

## 0.11.1

### Patch Changes

- [#93](https://github.com/subshell-ai/subshell/pull/93) [`b87d11d`](https://github.com/subshell-ai/subshell/commit/b87d11d65de43b44c1495e6317cfd37a17619b4c) Thanks [@theogravity](https://github.com/theogravity)! - The update screens say less. Both assistants dropped the paragraph explaining
  that the download is signature-checked and that the app restarts, and Subshell
  Server's offer dropped its subtitle — the rows already carry the versions, and
  a sentence restating them was a second thing to keep true.
  
  One sentence survived the subtitle: a restart that fails after the install
  landed still says so, as a note under the table, because that is an outcome no
  row can show and the Try Again button would otherwise appear unexplained.

## 0.11.0

### Minor Changes

- [#91](https://github.com/subshell-ai/subshell/pull/91) [`3de2795`](https://github.com/subshell-ai/subshell/commit/3de279580f049ef821c406a64f681cc9617258c0) Thanks [@theogravity](https://github.com/theogravity)! - The tray's update item opens the update window, signed in or out
  
  Pressing **Check for Updates…** now opens the update screen, which does the
  checking and shows the result. It used to run the check in the background and
  open nothing — the whole answer landed on the tray item's own label, which the
  press had just closed the menu on, so there was no visible response at all and
  an update that was found took a second press to reach.
  
  Signed in that was merely awkward: the sidebar says the same thing and its
  Update button opens this screen. Signed out there is no sidebar, so the tray
  was the only route to updating and it led nowhere. Both labels now open the
  same window.
  
  The screen's **Not Now** and **Later** buttons were one button's worth of
  meaning in two, so they are now a single **Close**.

## 0.10.1

### Patch Changes

- [#89](https://github.com/subshell-ai/subshell/pull/89) [`5eab666`](https://github.com/subshell-ai/subshell/commit/5eab6660a7b98c4172243a48758057d71cdf2d6f) Thanks [@theogravity](https://github.com/theogravity)! - Setting an https address for your server no longer locks the app out of it.
  
  The app kept opening its own window on `http://127.0.0.1:<port>`, and a server
  whose public address is https marks its session cookies so a browser will not
  keep them on an http page — so the window explained why it could not sign in
  and offered nothing to do about it. It opens on the address you configured now,
  and the field says what to expect: a restart and a sign-in.
  
  Only an https address moves the window. Every other setting opens exactly where
  it always did.

## 0.10.0

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

## 0.9.0

### Minor Changes

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

## 0.8.1

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

## 0.8.0

### Minor Changes

- [#77](https://github.com/subshell-ai/subshell/pull/77) [`ffca436`](https://github.com/subshell-ai/subshell/commit/ffca43632642776c7ccdc6a6ef3e4278367910cf) Thanks [@theogravity](https://github.com/theogravity)! - The Subshell Server assistant greets you again: first run — and every first run after a Reset — opens on the Welcome screen (wordmark, one sentence, Continue) before the zero-touch setup chain fires itself. The intro is inert by design; nothing is installed, configured, or written until you press Continue, and the automatic setup after it is unchanged.

- [#74](https://github.com/subshell-ai/subshell/pull/74) [`a2ebcc3`](https://github.com/subshell-ai/subshell/commit/a2ebcc34e7444ee78fbec9efd0f60d181c3ed232) Thanks [@theogravity](https://github.com/theogravity)! - First run now provisions itself: opening the app on a clean machine installs the bundled server, service and start with no button press — the only stops are tmux when it is missing, and a final **Continue** over the ticked checklist, so the finished run is read rather than watched out of the corner of an eye as the dashboard takes the screen. An available app update is now visible where it wasn't: the tray item names it and opens the update screen, and the update screen gains **Later**. The About facts move to the standard app-menu panel. (spec 2026-09-17-zero-touch-desktop-setup)

## 0.7.2

### Patch Changes

- [#68](https://github.com/subshell-ai/subshell/pull/68) [`d1f9a20`](https://github.com/subshell-ai/subshell/commit/d1f9a20f8ffe0468aa77d1dafcc9bc4c195be3d1) Thanks [@theogravity](https://github.com/theogravity)! - The "What macOS Will Ask" screen now shows three rows, and the Photos row has a button. Background Items went: the banner it explained is real, but the row had no state to read, no pane to open and nothing to press, so it could never change — and a row that can never change is prose standing in the column a person reads for decisions. Photos gained **Allow**, which is not the no-op it first sounds like: the panel that normally raises that prompt is this app's own image picker, so a sheet raised here arms exactly what the picker would otherwise arm later — one question, asked on a screen that has already said what it is for. It asks at the same access level the row reads, so sheet and row answer one question, and once the answer is in the way back is System Settings, as it was.
  
  Two things underneath had to change for the button to be honest. The renderer hardcoded the label "Allow notifications" and the notifications handler for every row that could ask, so an allow-row for Photos would have shown one permission's name on a button that spent the other's — the words and the request now travel on the row, and the handler lookup is a `Record` over a closed union, so a third ask without its handler is a compile error. And `request_photos` needed its non-macOS stub plus registration in the command list: `cargo clippy` on a Mac cannot see what Linux compiles, and the missing half would have shipped green from a laptop.

- [#69](https://github.com/subshell-ai/subshell/pull/69) [`bd38e1b`](https://github.com/subshell-ai/subshell/commit/bd38e1b47c03baf0cf53f8d263a5a35450631868) Thanks [@theogravity](https://github.com/theogravity)! - The Set Up screen now names the address the dashboard will run at — a "Dashboard URL" row above the supervision question, showing the chosen base URL when one exists and the CLI's own `http://localhost:<port>` derivation otherwise. It is live: typing a new port under "Customize port and addresses…" moves the row with every keystroke, without the re-render that would take the cursor out of the field. This is the deleted plan rows' address half returned by request (operator's call): the install row stays gone, and what came back is not a promise of what setup will do but the address the reader dials afterwards.

## 0.7.1

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

## 0.7.0

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

## 0.6.0

### Minor Changes

- [`fac6d2c`](https://github.com/subshell-ai/subshell/commit/fac6d2cfcd3bc7db39a24692f5f213f67e93f4af) Thanks [@theogravity](https://github.com/theogravity)! - The first run on a Mac now says what macOS will ask and why — Notifications,
  Files and Folders, Photos, and the Background Items banner — requests the one
  the app owns, and never blocks on the answer. A permission that is missing is
  named at the moment it bites: a banner when a "waiting for you" notification
  could not post, a notice when the image picker opens with Photos blocked, and
  "Blocked by macOS" in the directory picker when the server cannot list a
  folder. Each carries a **Fix…** that opens the assistant, where a declined
  permission offers **Open System Settings**. Preferences → Notifications shows
  the live macOS state.

### Patch Changes

- [`152bdb5`](https://github.com/subshell-ai/subshell/commit/152bdb5da7dfc483e0c1032ecb4c03b1ce76f33b) Thanks [@theogravity](https://github.com/theogravity)! - The first-run assistant passes `--no-service` to `subshell-server init`, which
  now offers to install the service itself. The app keeps installing it with its
  own autostart choice, so nothing about the assistant changes; without the flag
  it would ask a question the assistant had already answered.

## 0.5.0

### Minor Changes

- [`21f3904`](https://github.com/subshell-ai/subshell/commit/21f3904d82bbaf2ddee3980a372768b08d09ac9b) Thanks [@theogravity](https://github.com/theogravity)! - **Open in Browser**, in the tray menu and under View, right below "Open
  Subshell Server" — it hands whatever the dashboard is showing to your default
  browser. The dashboard's own sidebar grows the same row.
  
  A desktop window is a webview: no address bar, no second tab, and no way to
  reach the page you are looking at from the browser where your passwords and
  profiles live. This is that way. Note that the browser will ask you to sign in
  (a webview's session does not cross), and that the address opened is the
  loopback one this app manages — so a passkey works there only if your server's
  public base URL is the loopback address too.
  
  The page asks for a PATH and nothing more; the app supplies the address. It
  cannot be pointed at another host.

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
