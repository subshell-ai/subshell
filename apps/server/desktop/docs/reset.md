# Resetting the machine deep dive

The reset chain's guards, ordering, step meter and app-restart mechanics: the
"Resetting the machine" section, lifted verbatim from
`apps/server/desktop/AGENTS.md`. Read this before touching `reset.rs` or the
reset screen.

## Resetting the machine

Entry is the dashboard's Settings danger card (admin + desktop marker,
`apps/server/web`); confirmation and execution are the ASSISTANT's. The remote
page may name a SCREEN, never a path or a command:
`desktop_open_assistant({ screen: "reset" })` parses a closed enum, and
`reset::arm_and_raise` then reads the machine NOW. The five deletion paths
come from the server's own `status --json` (the `paths` block, which is why
that CLI field exists), all-or-nothing: a partial block is refused exactly
like no block, because a subset deleted and reported success is the R1 shape
with a typed hostname in front of it (R17). The plan lives in app state
(`reset::Stash`), not on the page and not re-read mid-chain: the chain stops
and uninstalls the very server whose report names the paths, so asking it
afterward would be asking a dead server where its own data lives (R18). A
half-run leaves the plan stashed; Retry converges.

`desktop_reset` takes ONLY the typed hostname, compared against the one
memoized `machine_hostname()` the screen was rendered from (R15: displayed
value, comparison value, single OnceLock). Two guards, both before the first
mutation: every target passes the shape rules (absolute, never `/`, never
`$HOME`), and the single containment guard refuses any recursive delete that
IS or CONTAINS the managed `~/.local/bin/subshell-server`; BOTH sides are
canonicalized, because a prefix test between a symlinked and a real spelling
passes while the delete still reaches the binary (P3). The default data dir
EQUALS the config dir that holds config.env and that is legal (R13): the
config file is a deletion target, not a keepsake; only the binary is kept.

The order is the confirmation screen's: stop, close the pane servers,
uninstall, delete (database file, pane logs, node artifacts, data dir minus
config.env, config.env last), clear this app's choices, move the windows:
destroy `main`, send THIS page back to `home`, and **restart the app**, which
its own re-probe (now `onboarded: false`) agrees with. With one bundled page the zero-window hazard
(N2) reduces to a single rule: **never close the assistant from inside the
chain.** It is the window the command is running in, and closing it once
`main` is already gone runs the last-window path and quits the app mid-reset.

**The chain is on the meter while it runs (spec 2026-09-13).** A legitimate
reset spends tens of seconds in compiled-CLI spawns and one kill per pane
socket, and a dead button lettered "Resetting…" reads identically to a hang
(reported as one). `ResetStep` (`stop | panes | service | files`) is the Rust
enum behind `desktop-reset-step` frames of `{step, state}`, the page mirrors
it in `lib/reset.ts` beside its own first row (`plan`, the arming round trip),
and the containment is pinned both ways by
`reset_steps_round_trip_and_mirror_the_page`. The states live in the view,
not the DOM (same reason `Show Details` keeps its openness), because
`renderSteps` rebuilds inside a render that runs on the poll's clock. An
unknown wire word drops (`knownStep`): a page newer than its binary is
`tauri dev` HMR's normal condition.

**The manager's "stopped" is a claim the chain now verifies, and the claim
itself was the CLI bug.** Measured 2026-09-13: a service-mode stop returned
success while the process kept running for 90 more seconds, and the deletes
ran anyway; the server's own log filled with `SQLITE_IOERR_VNODE` as its
database went out from under it. Root cause in `apps/server/api/service.ts`:
`bootout` is ASYNCHRONOUS (a fact `domainBusy()` has documented since
2026-09-12), but only the install path ever acted on it, and stop answered
"subshell-server stopped." on bootout's exit-0 alone. CLI stop now polls the
domain until `print` gives the same "no such job" answer `queryService` calls
stopped (30 s budget, `STOP_WAIT_ATTEMPTS`) and fails honestly if the job
never leaves; the tests pin the poll, and two old tests whose `at(-1)`
assertion ended at bootout were updated because they had pinned the lie. The
desktop chain keeps its OWN dial check (`dial_target`, 10 s, after the stop)
because it is the manager-independent half: a server nobody's manager owns
(the hand-run process, a stray on the port) is visible only on the port.
`listen.port` joined the all-or-nothing plan block (R17 applies exactly as to
a path: the page's `refusal` refuses without it, so screen and plan cannot
disagree about "armable"). The app-mode branch needed no second opinion:
`sup.stop` blocks on the pid it signalled and already answers false for a
stop that gave up.

**The tmux sweep skips only when the DIRECTORY agrees there is nothing to
do.** Measured 2026-09-13 and NOT fully explained: a reset chain completed
steps 1–7 with 69 stale `subshell-*` sockets on disk and tmux installed; step
3 skipped silently. The first suspect, `which("tmux")` answering None, was
disproven afterwards by reading `build_path`: it appends the FLOOR (which
includes `/opt/homebrew/bin`) UNCONDITIONALLY, so no probe failure can hide an
installed tmux. The surviving suspect is the directory (an inherited
`TMUX_TMPDIR` pointing the read elsewhere), unconfirmable after the fact
because the launching terminal's environment died with the dev session. The
fix therefore targets silence, not the guess: empty directory skips as
before; sockets present means tmux ran here once, so the sweep goes through
each spawn's own login PATH regardless, a spawn failure keeps ending the chain
as "a pane may have survived", and the skip's log line NAMES the directory it
looked in: if the surviving suspect fires again, it identifies itself.

**A dev build does not restart after a reset.** `app.restart()` re-execs the
binary OUT of the `tauri dev` process tree: the CLI sees its child exit and
quits, taking the Vite server (`beforeDevCommand`) with it, and a debug
binary loads `devUrl`, so the relaunched window renders white against a dead
:5178. Reported 2026-09-13 as "the FTE screen is white" after exactly that.
Under `cfg!(debug_assertions)` (runtime, not `#[cfg]`, so `schedule_restart`
never goes dead-code) the success arm takes the window-move fallback that
already existed for "a restart that does not happen": the live page
re-probes, sees `onboarded: false`, and draws first run in place, from
Welcome, re-armed for the press (apps/server/desktop/docs/assistant.md). Release
ships embedded assets and restarts as designed; the white window was never
a shipped-app bug, and nothing on the reset path branches on build kind
except this gate.
Pane closing goes through tmux's OWN directory rule:
`TMUX_TMPDIR ?? /tmp`, symlink-resolved, `tmux-<uid>/`, and only `subshell-*`
sockets (R1). `cleanSocket` used to join `TMPDIR`, which on macOS names a
per-user `/var/folders` path with no sockets in it; that silent-miss class is
why the rule is one exported function there now (`tmuxSocketPath`,
pane-runtime). The `subshell-` prefix that decides WHICH sockets a reset may
kill is pinned between the two languages by containment: an `include_str!`
test in `reset.rs`, the way the installer table pins its TypeScript twin.

Channel discipline is `desktop_setup`'s, inherited: an in-chain failure
answers `Ok(ActionResult { ok: false, stdout: log, stderr })` with every word
the CLI said up to the stop; `Err` belongs only to refusals that fire before
anything mutated. The screen renders the half-run's log where the human still
is, styled as a failure, with the button re-labelled Retry.

**The reset ends by restarting the app, and three details hold that up.**
Reaching first run by RESTARTING is by construction; reaching it by closing a
window and telling the page to go back was by inference, against a machine
still settling: a draining port answers `ready` for a moment longer, and the
ready path re-opens the dashboard and closes the assistant. Reported on
2026-09-12 as "the reset window closed and the dashboard stayed".

- **`destroy()`, not `close()`, for `main`.** `close()` raises
  `CloseRequested`, which this app answers on `main` by preventing it and
  HIDING the window while close-to-tray is on (the default). A hidden
  dashboard is one tray click from being back on screen pointed at a port that
  no longer answers, which is the other half of that report.
- **`restart()` on the MAIN THREAD.** Off it, Tauri routes through
  `RunEvent::ExitRequested`, which this app prevents while close-to-tray is on
  and a `main` window exists, and then parks the calling thread in
  `loop { sleep(Duration::MAX) }` forever (tauri 2.11.5 `app.rs`). A
  "simplification" to a bare `app.restart()` off-thread hangs silently.
- **The binary is resolved before the restart is attempted.** `restart()` is
  `-> !` and `exit(0)`s when it cannot find the current executable
  (`process.rs`), and a bundle reached through a symlink is enough, so the app
  would vanish with nothing respawned and nothing said. Resolving
  `current_binary` first turns that into the assistant staying on screen.

To check it by hand (it has no automated coverage), reset with close-to-tray
ON and confirm the whole app relaunches into first run, with no dashboard
recoverable from the tray.

**The Reset screen fills the frame on the confirmation, and replaces it for
the chain** (operator ruling 2026-09-22, final word on the layout,
superseding "replaces the frame rather than filling it"). The confirmation
rides the rail (the sidebar stays, reset active), and the pane's title
lives in the frame's `shell("reset")`, keyed on the meter pane. The room is
the RUNNING chain: for `busy || running` the rail is withheld and the view
goes full-window again, because a Back button live through a chain that
stops a service and sweeps sockets is a way out from under a screen that
has none. The safety property did not move; it moved DOWN, to the chain.

**Its label names what is reset.** `RESET_LABEL` is one string, used by the
recovery footer and carried verbatim by the frame's reset title
(`shell("reset")`), and it is
`Reset this server` here and `Reset this client` in the other app (operator's call, 2026-09-12). It was
`Reset ${here()}…`, which rendered "Reset this Mac…" and was wrong twice over:
it read as TRUNCATED, because "Mac" is a prefix of "Machine", the Linux
sibling really is "this machine", and the label ended there under an ellipsis
(it was reported as a layout bug), and it OVERCLAIMED, because "Reset this
Mac" is a sentence that means erase the computer. A destructive label that is
frightening about the wrong thing is worse than one that is frightening: it
teaches people that these labels do not mean what they say. One label now
covers two acts of very different severity (this one deletes the database
holding every user, every API key and the node signing keypair; Subshell
Client's deletes a node's config and key), and what makes that survivable is
that the label is a DOOR rather than the consent: the screen behind it
enumerates the five paths and demands the hostname typed, and the two apps'
windows are titled differently.

The deep link's true worst case, stated so it survives someone checking it
(spec R21): an XSS in a control plane's SPA can raise this app's window to
the reset confirmation, and reaches exactly one read-only command the app
already runs on a timer, and no verb that changes the machine; execution
still needs the hostname typed into a box.
