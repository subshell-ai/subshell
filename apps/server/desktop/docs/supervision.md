# Who runs the server: supervision deep dive

The service-vs-app supervision model, the supervisor's manager-mimicking rules
and the unmeasured macOS login fact: the "Who runs the server" section,
lifted verbatim from `apps/server/desktop/AGENTS.md`. Read this before working
on `supervisor.rs`, `effective_supervision`, or the service verbs.

## Who runs the server

Two answers, and the operator picks at setup ("The assistant":
apps/server/desktop/docs/assistant.md) or later from
**How Your Server Runs** (spec 2026-09-12 server-supervision).

| | a service | this app |
|---|---|---|
| what runs it | launchd agent / systemd user unit | `supervisor.rs`, as a child process |
| survives the app closing | yes | no: "runs with this app" means it |
| comes back at login | when armed (`service enable`) | only if the app does |
| SPA Restart server | works | works, and takes ~5s |

**The DISK outranks the stored preference**, always in that direction
(`effective_supervision`). Someone can install a service from a terminal on a
machine this app last set to app mode; if the preference won, the app would
believe it owned a process it never spawned, and `RunEvent::Exit` would stop
it on quit, taking down a server the operator had just arranged to be
permanent. A manager that will not ANSWER is not evidence of absence, so the
preference stands there rather than flipping a machine's mode on a `launchctl`
hiccup. The probe writes the correction back, single-writer, the way
`mark_onboarded` does.

**`decide()` gains exactly one branch**, and without it app mode has no steady
state: `!installed` would answer `InstallService` forever (the assistant
nagging to install the very thing the operator declined, `mark_onboarded`
never firing, boot never opening the dashboard). In app mode the PORT is the
whole question.

**The supervisor answers a service manager's questions the same way a manager
does**, because that is what makes the rest of the system work unchanged:

- **Respawn on any exit, after five seconds**: `Restart=always` +
  `RestartSec=5` + `StartLimitIntervalSec=0`, the systemd unit's own numbers.
  No start limit, so an EADDRINUSE loop stays a loop the probe reports rather
  than parking in `failed`. A restart someone ASKED for skips that wait; five
  seconds of nothing is right for a crash and wrong for a button.
- **SIGTERM to the MAIN PID, never the process group.** Each local subshell's
  tmux server is a child of the server, so a group signal takes every live
  pane with it: `KillMode=process` / `AbandonProcessGroup=true` are the
  managers' spellings of the same promise. Sent through one bounded
  `kill(1)` spawn rather than a `libc` dependency, the same precedent
  `hostname` set. Ten seconds, then SIGKILL.
- **It names itself to the server** (`SUBSHELL_SUPERVISOR`,
  `SUBSHELL_SUPERVISOR_PID`, `SUBSHELL_SUPERVISOR_LOG`), which the server
  believes only when the pid is its own parent. That is what makes
  `GET /api/admin/server` report `manager: "app"`, `supervised: true` and
  `paneSafety: "keeps"`, so the SPA's Restart button works with no change to
  `performRestart`.

It lives in this app rather than `crates/desktop-core` by the crate's own
rule: Subshell Client's node CLI has its own service and no equivalent mode,
so an abstraction here would be one real consumer and one guess.

**Console output** goes to one file, truncated per spawn: the last run's
output is the thing worth reading after a crash, and it is bounded by
construction. macOS reuses `~/Library/Logs/subshell-server.log`, the path the
plist already names, so `desktop_logs`' fallback finds it with no new rung and
someone switching modes keeps reading one file; Linux takes
`$XDG_STATE_HOME/subshell-server/console.log`, because the unit's journal has
no part in an app-run server.

**Boot starts it and waits** (`BOOT_START_GRACE`, 5s): `spawn` returns when
the process exists, and the window choice needs the PORT. Slower than that
lands on recovery, whose Start is idempotent and whose screen names the last
exit.

**One load-bearing macOS fact is UNMEASURED, and must be confirmed once.**
The whole "starts at login" mechanism rests on launchd auto-loading only
`~/Library/LaunchAgents`, so a plist kept in the config home runs when
something bootstraps it and not at login. That a `KeepAlive=true` job ignores
`RunAtLoad=false` WAS measured (macOS 26.6.2, 2026-09-12); the login half was
not, because measuring it means logging the operator out. On the first machine
to run this: `subshell-server service install --no-autostart`, log out, log
in, and confirm `service status` reports not running and
`launchctl print gui/$(id -u)/dev.subshell.server` answers "Could not find
service". **If it IS loaded, stop and report: the design needs a new
mechanism**, not a patch.

To check the rest by hand (none of it has automated coverage):

1. Launch with box 1 unchecked, start a subshell, quit the app, and confirm
   the pane's tmux server survives (`tmux -L subshell-<id> ls`) while the
   server is gone. This is the pane-safety promise, and no test can prove it.
2. Reset with close-to-tray ON: the whole app relaunches into first run, with
   no dashboard recoverable from the tray.
3. The door both ways from the dashboard's Service page, and the login switch
   on a machine that really has a service installed.
