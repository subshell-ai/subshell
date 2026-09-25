# Service install, autostart, linger, and the manager: the full account

Moved verbatim from `apps/node/agent/AGENTS.md`, which keeps the operational
summary and routes here. Only cross-references into sections that moved were
repointed.

These paragraphs sat under AGENTS.md's "Logging" heading; the logging half
moved to `apps/node/agent/docs/logging.md`.

`service install` refuses without an enrolled config; `service uninstall`
deliberately does NOT (an enabled unit must stay removable whatever config
sits beside it). Until 2026-09-22 the deleted config WAS the unenroll in
practice (a comment, not a verb), and `subshell unenroll` is that comment
made executable: the same two files, `daemon.lock` then `config.json`, with
the refusal protocol `maintenance on` established and nothing else touched.
`service uninstall` keeps its unconditional door regardless; the verb that
removes a unit must never itself require one. Linux: `~/.config/systemd/user/subshell.service`
(`Restart=always`) + `systemctl --user enable --now`; success prints the
`loginctl enable-linger $USER` hint UNLESS this user already lingers (see
below). macOS: `~/Library/LaunchAgents/dev.subshell.client.plist` (KeepAlive,
log at `~/Library/Logs/subshell.log`) + `launchctl bootstrap gui/<uid>`. The
plist carries `AssociatedBundleIdentifiers=[dev.subshell.client]` so System
Settings → Login Items labels the job **Subshell Client** with the app's icon
instead of the signing organization: the label and the association are the
ONE protocol constant `DESKTOP_CLIENT_BUNDLE_ID`, which is also Subshell
Client's own bundle id (the app's tests pin it; `LAUNCHD_LABEL` is that same
constant).

**`--no-autostart` runs it now but does not arm login start**, and each
platform expresses that differently: the mechanism is a port of the server
CLI's (spec 2026-09-12 server-supervision §3.2), not a second design. Linux:
`disable` then plain `start` instead of `enable --now`; the `disable` is not
redundant on a REINSTALL, because `enable` wrote a symlink into
`default.target.wants` that would otherwise survive and make the success line
claim the opposite of what systemd does at login. macOS: **the plist's
LOCATION is the setting.** launchd auto-loads exactly
`~/Library/LaunchAgents`, so a not-at-login definition is the SAME document
written to `<configHome>/dev.subshell.client.plist` instead, and each install
REMOVES the other copy: a leftover in the login directory silently re-arms
autostart at the next reboot. The flag-shaped alternatives were measured and
both fail: `RunAtLoad=false` does not stop a job that also carries
`KeepAlive=true` (which this template needs, and `restart` relies on), and
`launchctl disable` puts a mark in launchd's per-uid override database that
survives `uninstall` and breaks the next fresh install.

Everything that READS a definition therefore asks the disk which of the two
exists (`darwinDefinition`): `service status` reports `enabled` from the
plist's directory rather than its keys, `start`/`restart` bootstrap the path
that is actually there, `uninstall` finds either and clears both, and
`update`'s `serviceExecArgv`, which must name the file the MANAGER runs,
reads the same answer. `ServiceDeps.configDir` exists for exactly this; a
reader without it would report a `--no-autostart` install as "nothing
installed" while the node it wrote is running.

**One path deliberately collapses the two locations, and it is the plane's.**
`NODE_SERVICE_VERBS` carries `install`, and the executor
(`src/commands/service.ts`) calls `installService(deps)` with no options, so a
control plane pressing Install on a node that was registered with
`--no-autostart` RE-ARMS login start and removes the session plist. That is the
honest reading of the request (the frame has no field to say otherwise, and
"install the service" from a plane means the ordinary one), but it is the one
place the "the two locations are kept apart everywhere" rule above does not
hold, so it is written down rather than discovered. Giving the plane a say
would mean a new field on the frame and a protocol bump, which stays a
deliberate omission; what the KEYBOARD and Subshell Client gained on
2026-09-22 (rails addendum) is the day-2 toggle this side used to lack:
`subshell service autostart on|off` (`src/service.ts`'s `setAutostart`, the
node's port of the server CLI's twin). It refuses when nothing is installed,
in `controlService`'s words (an arm/disarm that could write a definition
would be a way to install a service whose config was never checked), and it
interrupts NOTHING running: Linux runs `systemctl --user enable|disable
--no-reload`, never `--now` (which would start or stop the node as a side
effect of a preference about the next login; the `--no-reload` the server's
twin does not pass is this port's one divergence, and it is honest about the
work: no unit CONTENTS change here, only the wants symlink, so the daemon has
nothing to reread), and darwin MOVES the plist between the two locations with
the loaded job entirely unbothered: write first, then remove, so a failed
move leaves the definition exactly where it was. `service status --json`
answers the same fact twice by name: `enabled` is the manager's reading,
`autostart` is the act's, one derivation on both platforms and `null` exactly
together, so an older reader loses nothing and the run-at-login switch reads
the word that says what pressing it does.

`service status` also reports `logPath` (that file on macOS, `null` on Linux:
the unit redirects nothing and the journal holds the output), so a GUI reveals
what the plist names instead of re-deriving a platform path. `AGENT_LOG_HINT`
is the other half of that pair: the `journalctl --user -u subshell.service -f`
line to run where there is no file to name. It lives here rather than in a
consumer because Subshell Client used to hold its own copy, and a hint about
THIS unit that is spelled somewhere else is one that drifts when the unit name
moves. Other platforms:
explicit refusal pointing at `subshell run` inside tmux/screen.
The unit/plist bake the installing shell's `PATH` (`Environment=PATH=` /
`EnvironmentVariables`) so a Homebrew/Nix tmux that passed the enroll preflight
is still found when the service manager, which starts units with a stock PATH,
runs the daemon; spaced paths are quoted in the systemd `ExecStart=`.
Everything is DI'd through `ServiceDeps` (`src/service.ts`) so tests pin the
exact unit/plist text and command sequences without touching systemd.

**`linger` is a second question about starting, not a sharper answer to the
first.** A `systemd --user` unit runs inside its owner's LOGIN SESSION, so
`enabled` buys a unit that comes back when somebody signs in and dies when they
sign out, and most nodes are machines nobody ever signs in to, where that is
a node which is simply not there. `loginctl enable-linger` is what gives the
account a session at BOOT instead, and the defect this closes is that the node
only ever mentioned it once, on stdout, at install time, to a terminal with
nobody at it. `ServiceState.linger` now carries the fact: `service status`,
`--json`, and `ready.runtime.service.linger` (protocol 9), so the plane can
say which of the two this machine is rather than advising every node in the
abstract, and the human view prints it as `survives logout` directly under
`starts at login`, because reading the two together is the whole point.

`null` is reserved for "nobody answered", and two things that look like gaps
are not. On macOS it is `null` and NOTHING is missing: a LaunchAgent's lifetime
IS the login session by design, there is no knob, so the line is omitted rather
than rendered as unknown. And a non-zero `loginctl` whose output says "not
logged in or lingering" is an ANSWER of `false`: logind holds no record of
this user, which means no session and no linger, and it is the ordinary reply
on exactly the headless box this feature is for; reading it as unknown would
blank the field precisely where it matters. A missing `loginctl` or an
unreachable bus is the real `null`. logind is addressed by UID because
`ServiceDeps` already carries one for launchd and `os.userInfo()` throws for a
uid with no passwd entry, which is the ordinary container shape.

**Two pieces of the linger probe are SHARED with the server's twin rather than
ported**, and the line is worth stating precisely, because everything else in
this module is a deliberate duplicate. `lingerProbeArgv`, `lingerFromProbe` and
the CLI's `lingerVerdict` string come from `@internal/subshell-protocol`. The
criterion is **one fact rendered to a HUMAN on two CLIs, which must agree**,
not "parsing versus platform logic", which would sweep in `parseLaunchctlPrint`
and `killModeFromUnitText` and commit the next person to a migration nobody
asked for. Those two feed each port's own state machine, never a user, and the
two sides could legitimately diverge on them tomorrow. `survives logout` is the
other kind: both `service status` commands print it, its regex over
`loginctl`'s error wording is brittle by nature, and correcting one copy would
leave the other quietly wrong on exactly the headless machine the fact exists
for. When to ask and what to do with the answer stay here.

`queryService`/`controlService` (ported from `apps/server/api/src/service.ts`,
2026-09-05; async here, since every seam in this module is) are what
`service status|start|stop|restart` run on. Two platform facts they encode:
the EFFECTIVE systemd `KillMode` comes from `systemctl show` (a unit-file grep
cannot see a drop-in under `subshell.service.d/`), and launchd state comes from
`launchctl print gui/<uid>/<label>`: the legacy `launchctl list` resolves an
IMPLICIT domain and reports a running gui job as absent over SSH, while every
write here targets `gui/<uid>` explicitly. A `print` that answers reports its
state VERBATIM in `detail` (`launchd: spawn scheduled` = the crash-throttle
wait, not a plain stop), and one that fails for anything other than
"Could not find service" (exit 113) is `state: unknown` with the stderr kept:
a manager that would not answer is not the same fact as a daemon that is
stopped. Start is `bootstrap` falling back to
`kickstart -k`; restart is `kickstart -k` (a bare `kickstart` on a running job
changes nothing); stop is `bootout` (KeepAlive undoes a mere kill), and on
Linux `stop`, never `disable --now`: un-enabling is what uninstall is for.

**The pane guard is the reason those live here rather than in the caller.**
This node's subshells run their tmux servers as CHILDREN of the daemon, so a
definition lacking `KillMode=process` / `AbandonProcessGroup=true` SIGKILLs
every live pane on the machine when the daemon is stopped OR restarted. The
current templates carry both, but a host that installed an older node has a
stale definition on disk, so `restart` REFUSES without `--force`, `stop` warns
and proceeds (refusing would only push the operator to `systemctl`, which warns
about nothing), and both fail CLOSED on an unreadable definition. `service
status` reports it as `teardown keeps panes`.
