# Installing the bundled node, and updating the app: the full account

Moved from `apps/client/desktop/AGENTS.md`, which keeps the operational
summary and routes here. The text below is verbatim.

## Installing the bundled node is a TRANSACTION, not a copy

**`node_install_cli` has two paths, and the split is whether there is an
installed CLI to ask** (spec 2026-09-15 § 7.1):

- **A REPLACE of the managed copy** (`probe.managed`: the binary this machine
  actually runs IS `~/.local/bin/subshell`) runs
  `<installed> update --from <staged sidecar> --yes --no-restart --json`. The
  node has no database, so this buys less than it does on the server side:
  `<binary>.previous`, the `update-pending.json` marker, and the version probe
  that refuses a file which cannot say what it is. It is still the same code
  on every path, which is the point.
- **A first install** keeps `sidecar::install_bundled`: there is no installed
  CLI to run.

Two things went away with the stop, and neither was a loss:

- **The service is no longer stopped**, so `stop_note` and `with_stop_output`
  are gone. They existed because `install_bundled` writes the file the daemon
  is executing; the CLI's swap is a `rename(2)` a running daemon does not
  notice, so there is nothing left for them to warn about. The deliberate
  no-restart is unchanged (`--no-restart` says it), and since spec 2026-09-18
  § 7.1 the screen OFFERS the restart rather than telling the person to start
  something that was never stopped. `rename(2)` leaves the running process on
  its original inode, so after a successful install the file is the new node
  and the daemon is the old one, and nothing on screen used to say so.
- **`node_install_cli` also settles the update marker.** It counts an
  attempt before the install and drops the marker after one that succeeded, so
  every route into the node half (the resumed act, the Retry the screen
  offers once it has halted, and the status screen's own door) is bounded and
  finishing by the same code. An attempt is an attempt whoever asked for it.
- **The flags are a CONTRACT, held in one place.**
  `desktop-core`'s `cli_update::update_args` spells them for both apps, and its
  tests pin the exact list; `update_argv` here is pinned against it, so this
  app can never spell one of them itself.

**A node older than the verb falls back to the plain copy, and SAYS so.**
Every `subshell` node that existed on 2026-09-15 predates `update` (0.8.0 was
cut before it was written), so without a fallback the app's offer would fail
with a usage dump on exactly the upgrade it exists for. The fallback is
`install_bundled`, the same `rename(2)` swap this path used before, and the
screen carries `legacy_install_summary`'s sentence: *Installed 0.9.0 over
0.8.0. No rollback point was recorded: the previous node predates the update
command, so this install cannot be undone automatically.*

**It claims no missing DATABASE backup, unlike the server app's.** The node
has none, and its own `update` takes none either, so naming one would alarm
about something that was never going to happen, which is the defect
`RESET_LABEL`'s history documents at length. What this install really loses is
`<binary>.previous`, so that is what the sentence names
(`cli_update::Unrecorded::Rollback`).

**What makes the fallback safe is how NARROW the detection is.**
`cli_update::lacks_update_verb` requires the run to have finished, to have
failed, and to carry `unknown command 'update'` in its own output. It keys on
that MARKER rather than an exit code because the two CLIs disagree:
`node-v0.8.0` routes usage errors through `fail(2, UsageError)` and exits **2**
where `server-v0.6.0` exits **1**, both measured at the tags, so a number
pinned here would have silently excluded one app. Every other failure stays a
failure: falling back on a pane-safety refusal or a version mismatch would
leave no `.previous` while reporting success.

## Updating the app itself

`src-tauri/src/app_update.rs` and the `update` screen, a near-twin of
`apps/server/desktop`'s, which documents the design once; read it there. What
differs here is only what is `tauri`-typed: the tag prefix
(`desktop-client-v`), the progress event (`node-app-update-progress`), the two
command names (`node_check_app_update` / `node_install_app_update`, both
`node`-window-only), and the screen, which is a React component rather than a
DOM render. Everything with no `tauri` type in it (the endpoint, the tag
parse, the semver pick, the manifest URL, the 24-hour schedule) is
`desktop-core`'s `release_feed`, shared.

Two facts specific to this app:

- **The node CLI is NOT touched by the app install itself**, which is why
  the act has a second half. Replacing this app replaces the node it BUNDLES,
  which is a source to install FROM and is on no rung of the resolution
  ladder, so a running `subshell` daemon keeps running `~/.local/bin/subshell`
  whatever lands. See "Updating is one act" below for what finishes it.
- **The signing key is the SAME one `apps/server/desktop` pins**, because the
  two apps are one publisher and a public key is the publisher's identity
  rather than the app's. One `bunx @tauri-apps/cli signer generate -w
  ~/.tauri/subshell-desktop.key`, the `.pub` contents committed as
  `plugins.updater.pubkey` in BOTH `tauri.conf.json` files, and two repo
  secrets: `TAURI_SIGNING_PRIVATE_KEY` (the key file's **CONTENTS**, not a
  path; measured 2026-09-15, tauri 2.11 ignores the `_PATH` spelling) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. **The `.key` in your password manager
  IS the backup, and losing it means every already-installed app can never
  auto-update again**: a new key is a new publisher to those installs, and
  the only way back is a hand download.

Local cost, same as the other app: because the pubkey is configured and
`bundle.createUpdaterArtifacts` is on, **`bun run compile` needs
`TAURI_SIGNING_PRIVATE_KEY` set**. `tauri dev` bundles nothing and is
unaffected.

## Updating is ONE act, in two phases

Spec `docs/superpowers/specs/2026-09-18-one-update-act-design.md`. **This app
SHIPS the node it drives**. Every desktop bundle carries the CLI it wraps
(root `AGENTS.md`), so "update Subshell Client" and "update the node CLI"
were never independent: the second is the tail of the first. Until 2026-09-18
they were two screens with two buttons whose names differed by a possessive,
and the pair produced a loop that reads as a bug: update the app, and the next
launch's probe sees a bundled node newer than the installed one and asks
again.

There is one screen now, id **`update`** (`components/assistant/update-screen.tsx`,
replacing `app-update-screen.tsx`). `app-update` is DELETED from `NodeScreenId`
rather than aliased (this product has no installed base to keep compatible),
so the tray emits `"update"` and an id this build does not know is ignored, as
it always was. The status screen's **"Update the node to X"** stays where it
is, because that is the natural place to notice the node is behind, but it is
a DOOR to this screen rather than a standalone install (§ 7.4). Beside it sits
**"Check for updates…"**, the same door for a machine that knows of nothing
behind, and it is HIDDEN while the first one shows, because two adjacent
buttons opening one screen under two names is the defect § 1 exists to
remove.

**The two phases are separated by the relaunch, and the marker is what crosses
it.** `node_install_app_update` writes `pending_bundled_install` into this
app's `settings.json` AFTER the install and BEFORE `app.restart()`; never
after, because a crash between the two must leave a machine that knows what it
was doing. The new build reads it back, and four things about how are worth
holding:

- **The decision is shared, the acting is not.** `desktop-core`'s
  `resume_decision(marker, bundled, installed)` answers install / clear / halt
  for both apps; Subshell Server then installs and restarts its service, this
  app installs and OFFERS the restart. The marker converts an offer into a
  continuation and nothing more; whether work EXISTS is still the machine's
  answer, so a marker whose work was done by a hand `subshell update` in
  between is cleared without acting.
- **It rides the PROBE** (`Probe.pendingInstall`, built by `control::resume_view`),
  which is what let the whole thing ship with **no new Tauri command and no
  capability change**. `node_probe` already computes the bundled version
  against the installed one, which is exactly the pair the decision weighs, and
  the page already reads it every few seconds.
- **`node_install_cli` counts and clears.** An attempt is counted before the
  install, the marker dropped after one that succeeded, so the resumed act, the
  Retry, and the status screen's door are all bounded and finishing by one
  piece of code. `MAX_RESUME_ATTEMPTS` is 2: at the limit the marker STAYS (the
  screen still names the update and offers Retry), and only the automatic
  firing stops. That is the one place this design refuses to keep trying on
  someone's behalf.
- **`forced` never crosses into this app.** It is the marker's pane-safety
  consent for a service RESTART, and phase 2 here restarts nothing. A test
  pins that it is absent from what the page is told.

**The wire names are Subshell Server's, and the two divergences that remain are
STRUCTURAL.** `PendingInstall`, `pendingInstall` and `halted` are that app's
spellings, adopted here on 2026-09-18 (this app said `PendingUpdateView`,
`pendingUpdate` and `exhausted`) so a diff of the two update screens shows a
difference in design rather than in vocabulary; they are read side by side
whenever either changes. `attempts` is the field this app had first, and its
rule is now the shared one: **an attempt is counted at the FIRE**, in
`node_install_cli`, because an attempt is an attempt whoever asked for it.
`forced` stays the server's alone, per the bullet above. What genuinely differs:

- **Who raises the screen.** This app does it IN THE WEBVIEW (`app.tsx`, the
  `raisedUpdate` effect: the first probe carrying a marker sets the `update`
  override, once per launch); Subshell Server raises its own in Rust at boot.
  Ours is sound only because **`windows.rs`'s `open_at_startup` opens the node
  window unconditionally**: the webview that reads the probe is guaranteed to
  exist on every launch. That dependency is load-bearing and it is the whole
  reason no Rust-side raise was needed: make the node window conditional again
  and a relaunched update would sit unfinished behind a window nobody opened.
- **Who clears a done marker.** `resume_view` clears it HERE, on the poll that
  noticed, the one write that function makes. The server app's `resume_view`
  is read-only and its boot path does the clearing, which it can be because it
  has a boot path that runs. Nothing of ours runs at boot, so the read the page
  already makes is the only place that can notice.

**Phase 2 ends by OFFERING the restart** (§ 7.1), through the existing
`commands.restart()`, which already surfaces the CLI's verbatim refusal,
offers `--force` behind it and points at *Rewrite the service definition*. The
pane-safety sentence lives THERE and not on the install: the swap is a
`rename(2)` a running daemon never notices, so nothing about installing an
node can close a subshell, while the restart can. Whether to offer it is page
state (`installedNodeHere`), the `ranSetupHere` pattern, because the running
daemon's version is not something any probe here can read.

One shape in `update-screen.tsx` is a fix for a measured defect rather than a
style: the press records the `runner.output` it saw, and a verdict is read only
once a DIFFERENT one arrives. `runner.run`'s `isPending` does not land in the
same commit as the press, so an effect guarded on `busy` alone ran once with
the previous action's output still in place, and read the node install's
success as the restart's, retiring the offer nobody had taken.

**It is a SELECTION, not always both halves** (§ 13, 2026-09-18). One act is a
simplification exactly while the two halves point the same way; when they
diverge it is a claim about the machine that is wrong. They diverge whenever
somebody installs a `subshell` by hand that is NEWER than the one this bundle
ships: `decide_node` ADOPTS it (it never downgrades), so phase 2 would answer
`Resume::Clear` and install nothing, while the screen named that newer version
as a target it would be replaced by, and the press promised the install
underneath it. Reported against Subshell Server; identical here.

So the screen is a table: component, what it runs, what it would become, and a
checkbox where there is something to do. Four rules, each closing one of the
defects above:

- **The table is all-or-nothing.** Where nothing is in question there are no
  rows at all (that is this app's "everything is current", and what
  `upToDate` and `settled` read), and where anything is, BOTH components are
  stated. Asked as two separate gates it could drop a component from a table
  its sibling had opened (review, 2026-09-18): an air-gapped check beside a
  current node said nothing about the node, a current app beside a behind
  node said nothing about the app. Subshell Server states both rows
  unconditionally because it has no empty-table state to protect; this is the
  same rule with one.
- **A row with an available act carries a checkbox, ticked by default**, so
  both halves behind is still ONE press. That default is D1 unchanged.
- **A row with no available act states WHY where its checkbox would be**
  (*runs another binary*, *you run a newer one*, *this build does not say which
  node it ships*, *up to date*, *cannot be checked*), and **never a disabled
  checkbox**, which says "not now" without saying anything. (*installs with the
  app* was one of these until 2026-09-18; that row is a checkbox now, and its
  target cell is what says so.)
- **Both halves are checkboxes, on either footing.** Under an app press the
  node half is that act's TAIL (the node that lands is the NEW bundle's,
  whose version this build cannot know, so the cell reads "ships with the new
  app" rather than a number), but it is still a choice: clearing it makes
  `node_install_app_update(install_node: false)` write NO marker, so phase 2
  never runs and a deliberately older `~/.local/bin/subshell` survives the app
  update. Untick the app instead and the node row becomes an act of its own,
  with the number in hand.

  It was not a choice until review on 2026-09-18, and the reason recorded for
  that is worth keeping as a warning: "the marker carries no selection" was
  true of the command as written and was filed as a structural fact. Subshell
  Server had already disproved it (it makes the marker's PRESENCE the
  selection), so what the sentence actually described was one missing boolean.
- **Every sentence promising the node half reads off `pressInstallsNodeCli`**,
  including the air-gapped refusal's "can still be installed". A promise that
  outlives the half it describes is the defect, not the act.

**There is no Force checkbox here, deliberately** (§ 13.3). Force overrides the
pane-safety refusal on a service RESTART; phase 2 in this app restarts nothing,
it OFFERS the restart, and that offer carries its own override behind the CLI's
verbatim refusal. A control governing nothing, rendered for symmetry with
Subshell Server's screen, would be a promise of the same kind. A test pins its
absence.

The same amendment added one refusal that is not cosmetic: a marker on a
machine running a NEWER node is dropped here as well as in Rust, because
§ 13.2 forbids installing an older bundled CLI over a newer installed one under
any consent, and an auto-firing marker is a consent given before the machine
was in that state.

Everything with a contract rather than a rendering is `lib/update-act.ts`:
which rows the screen states, which of them carry a checkbox and which carry a
reason, which phase it is in, which halves are refused and what the press says
it will do. It is mirrored, not shared, with the server app's: one is React
and one is vanilla DOM, exactly as the tmux screens are, and a diff between
them is the drift signal.
