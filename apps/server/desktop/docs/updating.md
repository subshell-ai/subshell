# Updating the app and its server deep dive

The two-phase update act, the install transaction and the publisher keypair:
the "Installing the bundled server is a TRANSACTION, not a copy" and "Updating
in one act" sections, lifted verbatim from `apps/server/desktop/AGENTS.md`.
Read this before touching `app_update.rs`, `boot_resume`, the update screen,
or the updater signing setup.

## Installing the bundled server is a TRANSACTION, not a copy

**`desktop_install_server` has two paths, and the split is whether there is an
installed CLI to ask** (spec 2026-09-15 § 7.1):

- **A REPLACE of the managed copy** (`probe.managed`: the binary this machine
  actually runs IS `~/.local/bin/subshell-server`) runs
  `<installed> update --from <staged sidecar> --yes --no-restart --json`. What
  that buys is the whole reason the verb exists: the database is backed up,
  `pending.json` is written, `<binary>.previous` is kept, and the NEW binary
  either completes the transaction at boot or reverts it. Before this, the
  desktop replace was the one update path on the machine with no backup behind
  it and nothing to roll back to.
- **A first install** keeps `sidecar::install_bundled`. There is no installed
  CLI to run, and writing a file where none was is not a transaction.

Three details that are not obvious from the diff:

- **`install_server_now` is the wrapper, `install_bundled_server` is the act.**
  The wrapper exists for one line: an install that SUCCEEDED clears the update
  marker (spec 2026-09-18 § 5), because the marker means "the CLI this app
  ships is not installed yet" and that has stopped being true. Every door (the
  update screen's press, the boot resume, the first-run chain) goes through
  the wrapper, so "the bundled CLI is installed now" has one writer rather than
  one per caller. A FAILURE leaves the marker, which is what lets the next boot
  try again inside the attempt bound.
- **The flags are a CONTRACT, held in one place.** `desktop-core`'s
  `cli_update::update_args` spells them for both apps, and its tests pin the
  exact list. `--yes` because the consent happened on the screen that named the
  versions; `--no-restart` because only the app can take the restart in app
  supervision mode, and because the node app deliberately never restarts.
- **The old `stop_first` closure is gone, and nothing lost a guarantee.** It
  only ever fired when `probe.managed` was true (exactly the path that now
  goes through the CLI), and the CLI's swap is a `rename(2)` a running process
  does not notice.
- **A server older than the verb falls back to the plain copy, and SAYS so.**
  Every `subshell-server` that existed on 2026-09-15 predates `update` (0.6.0
  was cut before it was written), so without a fallback the app's offer would
  fail with a usage dump on exactly the upgrade it exists for. The fallback is
  `install_bundled`, the same `rename(2)` swap this path used before, and the
  screen carries `legacy_install_summary`'s sentence: *Installed 0.7.0 over
  0.6.0. No database backup was taken: the previous server predates the update
  command, so this install cannot be rolled back automatically.* Naming the
  missing backup is the whole point: someone who later needs to undo this has
  to learn it now, not when they go looking for a `.previous` that is not there.

  **What makes that safe is how NARROW the detection is.**
  `cli_update::lacks_update_verb` requires the run to have finished (`code`
  is `Some`), to have failed, and to carry `unknown command 'update'` in its
  own output (the marker only a command dispatcher prints, for a word it does
  not know). It is keyed on the MARKER rather than the exit code because the
  two CLIs disagree: `server-v0.6.0` exits **1** (`error(USAGE); exit(1)`) and
  `node-v0.8.0` exits **2** (`fail(2, UsageError)`), both measured at the tags.
  Every other failure (the pane guard, an unwritable binary, a digest
  mismatch, a version the file does not confirm, an update already in progress)
  is still a failure, because falling back on any of those would skip the
  backup while reporting success. `classify_update` is split out from the run
  precisely so that decision is testable without a test able to reach
  `install_bundled` and write into someone's own `~/.local/bin`.

## Updating in one act

`src-tauri/src/app_update.rs`, `tauri-plugin-updater`, `control::boot_resume`,
and the one `update` screen (spec 2026-09-15 § 7.2; spec 2026-09-18).

**One press updates the app AND the server that app ships**, because on a
desktop machine those were never independent: each bundle SHIPS the CLI it
wraps, so `desktop_install_server` installs precisely the copy a new bundle
would bring. The act is **two phases separated by the relaunch**, and the order
is forced rather than chosen: the new app carries the newer server, so
installing the server first installs the OUTGOING bundle's copy and leaves the
machine behind again the moment the app lands.

**It is a SELECTION, and that is not a reversal** (spec 2026-09-18 § 13). The
screen is a table: one row per component (what it runs, what it would become,
and a checkbox where there is something to do, ticked by default), plus one
Force box below it. With both halves behind, both are ticked and one press does
both, which is the paragraph above unchanged. What the table adds is the case
where the two halves point in DIFFERENT directions, and it was a real machine:
an operator at app 0.8.1 with a `subshell-server` they had updated by hand to
0.10.1 was told the screen would install a server older than the one they were
running. The CLI row was pushed whenever the app was behind, and the subtitle
promised "installing it also installs the server it ships", while the ladder's
answer was `adopt-installed`; so phase 2 would have answered `Resume::Clear`
and installed nothing. The ACT was never unsafe; the DISPLAY was false.

Three rules the table keeps, each with the defect behind it:

- **A row with nothing to do states WHY, never a disabled checkbox.** "Not now"
  with no reason is what sent the operator looking for a bug. The cell is short
  ("you run a newer one", "not this app's", "could not check", "up to date");
  the long form is a sentence under the table, which is what `notes` is.
- **Force governs the pane-safety refusal and nothing else.** It is the one
  refusal a person may overrule; it is UNTICKED by default (an override that
  arrives pre-accepted is not an override), and it renders only where a
  definition would actually refuse. It may **never** install an older bundled
  CLI over a newer installed one: boot's migrator is forward-only, so that is
  data loss rather than a choice to present, which is why the adopt-installed
  row explains `subshell-server update --from <file>` instead of offering a box.
- **The selection crosses the relaunch as the marker's PRESENCE.** A cleared
  CLI row writes no `PendingBundledInstall` at all, so phase 2 does not run:
  there is no second field for the two to disagree about. That is why
  `desktop_install_app_update` takes two booleans now (below).

| | phase 1 | phase 2 |
|---|---|---|
| runs in | the process the person pressed in | the build that came up |
| does | download, verify, install the bundle | install the bundled server, restart the service |
| ends by | writing the marker, then `app.restart()` | clearing the marker |

Four things about the seam:

- **The marker is written BEFORE the relaunch, never after** (`app_update::install_app_update`,
  in the same `SettingsState::update` that clears the stale notice; one lock,
  one save). A crash between the two must leave a machine that knows what it
  was doing. `PendingBundledInstall` and the pure `resume_decision` live in
  `crates/desktop-core`, shared with Subshell Client; what each app DOES with
  `Resume::Install` does not, because this one restarts a service and that one
  deliberately does not.
- **The marker converts an OFFER into a continuation and never decides there is
  work.** `resume_decision` re-asks the machine (the bundled version against
  the installed one, the same comparison `decide_server` makes), so a marker
  whose work turns out to be done (a hand `subshell-server update` in between)
  is cleared without acting. It is therefore impossible for a marker to cause
  an install the probe would not have offered anyway.
- **The attempt is counted at the FIRE, not at the offer**:
  `install_server_now`, the one door every install goes through, spends one
  before it acts, and `boot_resume` counts nothing. It counted at the offer
  until 2026-09-18, which made `MAX_RESUME_ATTEMPTS` (2) a bound on BOOTS: two
  launch-and-quits reached the limit having never attempted an install, and the
  screen then said the install had failed twice (review). Counting before the
  act still spends one on a crash INSIDE the install, which is the case the
  bound exists for, and it is where Subshell Client counts too. At the limit
  the marker STAYS (so the screen can still name the update and offer Try
  Again), and nothing fires by itself.
- **The pane-safety consent crosses in the marker's `forced`.** The confirm
  happens in phase 1 and the restart it consents to happens in phase 2, in
  another process, so re-asking would be asking again for something already
  granted on a screen nobody chose to open. It is the page's Force box that
  answers now (§ 13.2); it used to be read in Rust at the press, on the
  grounds that the command took no argument. Rust still NARROWS it:
  `install_app_update` ANDs the page's answer with `control::pane_risk_now`,
  the twin of the page's `paneRisk`, so a page asking to force a restart no
  definition would refuse gets an ordinary one. A Try Again on the phase-2
  screen is a FRESH consent, and the box is live under it, seeded from what the
  marker recorded.

**Two things here differ from Subshell Client STRUCTURALLY**, and both are
worth stating because the two apps' docblocks would otherwise read as
contradicting each other (review, 2026-09-18). The wire names are NOT among
them: `pendingInstall`, `halted`, `{ fromAppVersion, forced, halted }` and the
Rust `PendingInstall` are this app's spelling and the shared one.

- **Who raises the screen.** This app decides at BOOT, in Rust (`lib.rs`'s
  `setup`, through `boot_resume`), because a ready machine would otherwise
  open the dashboard and never show the assistant at all. The client decides
  in the WEBVIEW, and that is sound there for a reason worth recording rather
  than assuming: `windows::open_at_startup` always opens its node window, so
  a page that can raise the screen is guaranteed to exist. Were that to
  change, the client would need this app's boot branch.
- **Who clears a marker whose work is done.** Here `resume_view` is READ-ONLY
  (a poll that merely renders never writes), and `boot_resume` is the one
  place a spent marker is dropped. The client's `resume_view` clears it on the
  poll instead. Both are defensible; this one is the stricter rule, and the
  cost is that a marker which becomes pointless while the window is open
  survives until the next boot, where it reads as `None` anyway.

The screen itself is `ui/src/lib/update-act.ts` (pure, every judgment, and
the only thing in this app that CAN be tested, since `ui/src/__tests__/` has
no DOM harness). `install_server_now` is the one place the marker is cleared on
success, which is why the act itself moved into `install_bundled_server`:
every door (the press, the boot resume, the first-run chain) installs through
the wrapper.

Four more things carry the weight of the app half specifically:

- **The plugin is pointed at ONE release, chosen here.** It wants a static
  manifest URL, and this repository publishes four components under four tag
  prefixes; so `check_app_update` reads the same release LIST every other
  component reads (`desktop-core`'s `release_feed`, whose `RELEASE_API` is
  held equal to `packages/subshell-protocol/src/releases.ts`'s
  `DEFAULT_RELEASE_API` by an `include_str!` test), picks the newest
  `desktop-server-v*` by SEMVER, and only then sets
  `endpoints([<that release>/latest.json])`. `SUBSHELL_RELEASE_URL` repoints
  the list; an EMPTY value turns the whole thing off, the same air-gapped
  answer the server has.
- **The trust is a compiled-in public key**, so a compromised release host can
  WITHHOLD an update and cannot supply one. That is strictly stronger than the
  CLI path, where the digest and the bytes come from the same source.
- **The launch check is once a day and opens nothing.** `settings.json`'s
  `lastUpdateCheckAt` / `lastUpdateVersion` are the whole mechanism
  (`release_feed::due_for_check`); the only output is the tray item's label.
  A window that appeared on its own because a release was cut is the automatic
  update this design explicitly does not have (spec § 14).
- **The tray item is two labels and ONE act: it opens the screen**
  (operator's call, 2026-09-18, replacing spec 2026-09-17 § 5.2's branch).
  `update_label()` stays pure: `Update available: Subshell Server {version}`
  once a check knows, `Check for Updates…` otherwise, but both press through
  to `arm_and_raise(update)`, so the label announces and never re-routes.

  It used to branch, and the quiet half was a dead end. An unknown version ran
  `check_now`: a forced background check that opened NOTHING, whose whole
  answer landed on this item's own label, which the press had just closed the
  menu on. So a machine with no update known gave no visible response at all,
  and one with an update waiting took two presses with a menu reopen between
  them. Signed in that is merely poor, because the SPA's footer row says the
  same thing and its `[Update]` opens this screen; **signed out there is no
  sidebar, so the tray was the only door to updating and it led nowhere.**
  Reported 2026-09-18 on an app at 0.8.0 with `desktop-server-v0.10.1`
  published, a reachable release source, and a stored `null` from a check that
  had honestly found nothing hours earlier, three facts that each look like
  the bug and none of which was.

  Opening is strictly MORE than the check was rather than a different act: the
  screen runs `runUpdateCheck(false)` on entry and renders checking / up to
  date / available with the install press, so "Check for Updates…" opens a
  window that checks, which is the macOS convention. `check_now` is deleted
  with the branch: the forced check lives where its answer is visible.
- **The dashboard can now SEE the stored answer** through `desktop_app_update`,
  the read-only seventh `main` command: no argument, no fetch,
  `{ currentVersion, availableVersion }` from `PackageInfo` and the one
  settings field the check writes. It never checks; both update VERBS stay
  `wizard`-only (spec 2026-09-17 § 5.3; `docs/security.md` carries the
  accounting).
- **The check does NOT ride the 1500 ms poll.** Every other fact on the
  assistant is a probe of this machine; this one is a third party. The screen
  asks on its first render and on Check Again, and nothing else.

**Both commands are `wizard`-only**, and the check is there too even though it
looks harmless: its sibling replaces the application, and the dashboard reaches
this screen by NAME (`desktop_open_assistant({ screen: "update" })`), a
grant it already has. Neither names a LOCATION, which is the whole of the case
for granting them: the release is re-resolved in Rust, so the page asks for
"the newest" and can never name a URL. `desktop_check_app_update` takes no
argument at all; `desktop_install_app_update` takes exactly two booleans, the
§ 13 selection (`forced`, `install_server`). `ipc-acl.test.ts` pins the
parameter list of each and that every argument past the handle is a `bool`: a
`String` there is the parameter this pin has always existed to catch.

**The signing key is the operator's, and losing it is unrecoverable.** One
keypair for BOTH desktop apps (they are one publisher, and a public key is
the publisher's identity rather than the app's):

```bash
bunx @tauri-apps/cli signer generate -w ~/.tauri/subshell-desktop.key
```

`@tauri-apps/cli` by name, not `tauri`: from outside a desktop app directory
`bunx tauri` falls through to npm's retired v1 CLI, which depends on `sharp`
and fails compiling libvips on arm64 macOS (measured 2026-09-15).

The `.pub` contents go into `plugins.updater.pubkey` in BOTH apps'
`tauri.conf.json`, replacing the committed
`REPLACE_ME_WITH_THE_SUBSHELL_DESKTOP_MINISIGN_PUBLIC_KEY` placeholder (which
`assertUpdaterPubkey` in `src/scripts/release.ts` refuses a cut over). The
private half goes into two repo secrets:

| secret | value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the key file's **CONTENTS**, not a path (measured 2026-09-15, tauri 2.11 ignores `TAURI_SIGNING_PRIVATE_KEY_PATH`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the passphrase, or `""` |

**The `.key` in your password manager IS the backup**, exactly as the `.p12`
is. **Losing it means every already-installed app can never auto-update
again**: a new key is a new publisher as far as those installs are concerned,
and the only way back is for every user to download the app by hand.

One local cost, worth knowing before it surprises you: because the pubkey is
configured and `bundle.createUpdaterArtifacts` is on, **`bun run compile`
needs `TAURI_SIGNING_PRIVATE_KEY` set**: tauri refuses with "A public key has
been found, but no private key". Generate a throwaway key for local bundling;
`tauri dev` is unaffected, because it bundles nothing.
