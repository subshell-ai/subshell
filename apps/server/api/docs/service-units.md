# Service units: the systemd/launchd definitions, autostart, and linger. Moved verbatim from AGENTS.md ("Standalone binary & CLI"); AGENTS.md keeps the summary and routes here.

`service install` (`src/service.ts`) writes `subshell-server.service` under
`~/.config/systemd/user/`, **one owner per host**: the retired `svc.sh` wrote
this same path from the repo's `.env`, so a host upgrading from it must
uninstall that unit before installing this one (README, "Host service"), with
`WorkingDirectory=` and
`EnvironmentFile=` pointed at the config home (systemd and the binary's own
loader read the same file, so they cannot disagree), the installing shell's
PATH baked (a Homebrew/Nix tmux would vanish under the manager's stock
PATH), `StartLimitIntervalSec=0` (Restart=always must survive an
EADDRINUSE crash loop), and `KillMode=process`, the load-bearing one: each
local subshell's tmux server is a CHILD of this unit, so the default
control-group kill SIGKILLs every live pane on stop/restart. A host whose unit
lacks it loses all running subshells on the next `systemctl restart`, and on
a plain `systemctl stop`, since a restart is a stop plus a start (measured,
2026-09-03). `src/service.ts` carries the reasoning; the unit text is pinned by
test. Since 2026-09-05 that hazard is ENFORCED rather than merely documented:
`queryService` asks systemd for the EFFECTIVE `KillMode` (a unit-file grep
cannot see drop-ins under `subshell-server.service.d/`), `service restart`
refuses on a host whose definition would kill panes (`--force` overrides),
`service stop` warns and proceeds, and `service status` reports it as
`teardown keeps panes`. Both destructive verbs fail CLOSED on an unreadable
definition; `unknown` is not evidence of safety.

**On macOS "starts at login" is the plist's LOCATION, not a key inside it**
(spec 2026-09-12 server-supervision), and both flag-shaped alternatives were
measured and rejected; read this before "simplifying" it back to `RunAtLoad`:

- `RunAtLoad=false` does not stop it. The plist carries `KeepAlive=true`,
  which starts a job when it is LOADED regardless. Measured on macOS 26.6.2: a
  throwaway node with that exact pair reported `state = running, runs = 1`
  two seconds after `bootstrap`, while the same node without `KeepAlive`
  reported `runs = 0`. Switching `KeepAlive` to its dictionary form to dodge
  that would break restart-by-exit, which `performRestart` relies on.
- `launchctl disable gui/<uid>/<label>` is worse: a disabled service refuses
  `bootstrap`, so "running now but not at login" cannot be expressed at all,
  and the mark lives in launchd's per-uid override database, survives
  `service uninstall`, and makes the next fresh install fail with the generic
  EIO `bootstrapDarwin` already has to apologise for.

launchd auto-loads exactly `~/Library/LaunchAgents` at login, so **enabled =
the plist is there; disabled = the same document lives in the config home**
and only an explicit `bootstrap` (which `service start` does) loads it. Moving
it restarts nothing (launchd holds the loaded job, not the file), which is
what makes `enable`/`disable` safe for a running server. `queryService` reads
`enabled` from WHERE the definition is, `uninstall` removes both locations,
and the control verbs bootstrap `state.definitionPath` rather than assuming
the login path.

**On Linux "starts at login" is only half the answer, and the missing half is
`linger`.** A `systemd --user` unit runs inside its owner's login session: an
enabled one comes back when that user logs IN and dies when they log out, so a
headless box nobody logs into never starts it at all. `loginctl enable-linger
$USER` is what decouples the two; after it, the same enabled unit comes back
at BOOT with nobody logged in. The defect that closes is an operator who
believed a server was armed because the only switch on screen said "start at
login" and was on, and then rebooted the machine and lost it. `queryService`
therefore reports a SEPARATE `linger` field beside `enabled` rather than
folding one into the other: they are two independent facts, and it is asked
regardless of `enabled`, on the `systemctl show` success branch only.

**The probe's argv and its answer-mapping are SHARED with the node's twin of
this module**, in `@internal/subshell-protocol`, and that is the one exception
to the ports-are-duplicates rule. The criterion is **one fact rendered to a
HUMAN on two CLIs, which must agree**, deliberately not "parsing versus
platform logic", which would also describe `parseLaunchctlPrint` and
`killModeFromUnitText`. Those feed this port's own state machine and never a
user, so the two sides may diverge on them; `survives logout` is printed by
both `service status` commands, and its regex over `loginctl`'s error wording
is brittle enough that correcting one copy would leave the other quietly
wrong on a headless host, precisely what this fact exists to prevent. Each
side still owns its call sites and when to ask.

The probe is `loginctl show-user <uid> --property=Linger`, by UID and never by
username; `ServiceDeps` already carries a uid for the launchd domain target,
and `os.userInfo()` THROWS for a uid with no passwd entry, which is the
ordinary state of a container. Three answers, and the middle one is the one to
get right: `Linger=yes|no` on a clean exit is logind's own word; a NON-ZERO
exit whose output says the user is "not logged in or lingering" is ALSO logind
answering; no session record means no session and no linger, so `false`, not
unknown, and it is the normal reply for a service user on a box nobody logs
into; anything else (no `loginctl` on PATH, no bus to connect to) is a question
that never reached logind, so `null`. It is `null` on macOS too, and that is an
absence of the question rather than an unknown answer: a LaunchAgent's lifetime
IS the login session by design, so there is nothing there to be yes or no
about. `service status` renders it as `survives logout` for a systemd
definition and omits the line entirely for a launchd one.

macOS: launchd agent `dev.subshell.server` →
`~/Library/LaunchAgents/`, log `~/Library/Logs/subshell-server.log` (reported as
`logPath` in `service status --json`: the desktop app reveals it rather than
re-deriving the platform path; Linux reports `null` because the journal holds
the output). The plist carries `AssociatedBundleIdentifiers =
[dev.subshell.server]` so System Settings' Login Items labels the job **Subshell
Server** with the app's icon instead of falling back to the signing
organization, and `WorkingDirectory=` the config home so a relative
`DATABASE_PATH` lands there rather than in `/`. The bundle id is the protocol
constant `DESKTOP_SERVER_BUNDLE_ID`; the plist label, the association and the
desktop app's own identifier must stay one string or the attribution silently
detaches. `service status` reports what launchd says VERBATIM: a crash-throttle
wait shows as `launchd: spawn scheduled`, and a `launchctl print` failure that
is not "Could not find service" (exit 113) is `state: unknown` with the stderr
in `detail`; a manager that would not answer is not the same fact as a service
that is stopped.
