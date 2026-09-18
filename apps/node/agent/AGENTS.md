# Node agent AGENTS.md

App-specific documentation for `subshell` (`@internal/node`) — the node
daemon: it enrolls with the control plane, holds the `/ws/node` socket, and
executes signed commands (launch/tmux/fs) as the invoking user on its machine.
Design: `docs/superpowers/specs/2026-08-31-nodes-design.md` §7 + the Phase-3
distribution design beside it. Architecture-role prose: the component map in
`apps/docs/content/docs/develop/architecture.mdx`; wire-level contract in
`apps/docs/content/docs/reference/node-protocol.mdx`.

## Commands

```bash
bun run build            # tsdown lib build → dist/index.js|.d.ts (what turbo runs)
bun run compile          # single-file DEV binary ./dist/subshell (host only, --bytecode)
bun run compile:release  # the release pipeline (run it from ROOT as `bun run release:node`)
bun run test             # bun test
bun run verify-types     # tsc --noEmit
```

- `compile:release` (`src/scripts/release.ts`) is deliberately SEPARATE from
  `compile`: cross builds download each target's bun runtime on first use, so
  they must never become a hidden cost of the normal build/test path. Every
  target ships `--bytecode` (risk #9 retired at bun 1.4.0 — spec 2026-09-03
  §5); the pipeline refuses older bun. `SUBSHELL_RELEASE_TRIPLES` scopes a
  subset (CI uses this). Each target publishes as `subshell-node-cli-<triple>` —
  the `cli` says it is the bare binary rather than the `apps/client/desktop`
  app that wraps it (`nodeArtifactFileName`, `@internal/subshell-protocol`);
  the INSTALLED binary is still `subshell`, so an install renames it. Publish
  is atomic (tmp + `rename()` per artifact + fresh `.sha256` sidecar — the
  downloads route's mtime-keyed cache contract) and all-or-nothing (a failed
  target publishes NOTHING). Destination:
  `SUBSHELL_NODE_ARTIFACTS_DIR`, else `<SUBSHELL_SERVER_DATA_DIR>/node-artifacts` (a
  documented duplicate of the server's default in `apps/server/api/src/constants.ts`).
- **`turbo build` wipes the compiled `dist/subshell`** (shared `dist/` with
  the tsdown output) — re-create with `cd apps/node/agent && bun run compile`.
- Workspace deps (`pane-runtime`, `subshell-protocol`, `mcp-core`, `backend-errors`):
  the compiled binary BUNDLES their dists, so `turbo build` must run first —
  `compile:release` preflights and refuses otherwise. The client imports
  packages, never `apps/server/api` code, and never opens the app database.

## Repointing vs re-enrolling

`enroll` is not the way to change a node's address. It overwrites
`config.json`, mints a SECOND node row on the plane, spends a single-use
24-hour setup key, and discards the node key whose only home was that 0600
file — none of which is what "the control plane moved" wants, and that move is
routine (it is what fixing a loopback `APP_BASE_URL` IS). `configure`
(`src/configure.ts`) rewrites the address and keeps the identity.

**It clears `nodeWsUrl`, and that is the load-bearing part.** That field is what
the OLD plane reported about ITSELF at enroll (ledger 17c) and `resolveWsUrl`
PREFERS it over any derivation — so carrying it forward would leave the daemon
dialing the old host while `serverUrl` named the new one, a divergence no
surface displays. Cleared, `wsUrlFor(serverUrl)` derives from the address
actually configured; a plane behind a reverse-proxy subpath re-reports its own
ws URL at its next enroll. Renaming alone does not touch it — the address did
not change.

`normalizeServer` is exported from `enroll.ts` and shared, so a repoint writes
the same spelling an enroll would; two commands disagreeing about one address
is the bug that shape prevents.

**It does not rename, and deliberately takes no `--name`.** `config.json`'s
`name` reaches the control plane in exactly ONE place — the enroll POST body
(`enroll.ts`) — and is absent from `readyEvent` (`daemon.ts`) and the inventory
event. So writing it on a repoint would change what local `subshell status`
prints and leave the Nodes page showing the old name forever. Renaming is the
plane's own operation (`PATCH /api/nodes/:id`).

**It works only between two names for ONE plane.** The identity is kept, so a
genuinely different control plane holds no key bound to this node row and
`/ws/node` refuses the socket 401 (`node-ws-handler.ts`) — the node goes
offline, with the reason only in its own log. Recovering means pointing it back
or enrolling with a setup key from the new plane. Joining a different plane is
an `enroll`, not a `configure`.

## CLI (`src/cli.ts` — hand-rolled parser, no flag library)

```
subshell setup --server <url> --key <nsk_…> [--name <n>] [--data-dir <d>]
               [--no-service] [--yes] [--json]
                                   # THE HEADLESS ENTRY POINT (spec 2026-09-15): tmux
                                   # preflight, then `enroll`, then ONE question — run in
                                   # the background and start at login? — defaulting to
                                   # yes, then the same installService the service verb
                                   # calls, then a line naming the node's page. What the
                                   # rendered install.sh invokes. `enroll` stays a
                                   # primitive beneath it for anyone composing their own
                                   # flow; this is the one a person runs.
subshell enroll --server <url> --key <nsk_…> [--name <n>] [--data-dir <d>] [--json]
                                   # --json prints {nodeId,serverUrl,name,dataDir,configPath}
                                   # (never the nodeKey) so a GUI need not scrape the human line
subshell configure --server <url> [--json]
                                   # repoint an ALREADY-enrolled node at a different
                                   # control plane. Keeps nodeId/nodeKey/
                                   # controlPublicKey, spends NO setup key, mints no second
                                   # node row — the non-destructive answer to "the server
                                   # moved", which `enroll` is not. CLEARS nodeWsUrl when the
                                   # address changes (see above). Restart to apply.
                                   # Takes NO --name: see above. NO --registry-url either:
                                   # it configured the npm mirror the old `subshell plugin
                                   # install` verbs fetched from, and those verbs (and the
                                   # whole node-side plugin concept) are GONE — see below.
subshell run                       # foreground daemon (what the service unit runs)
                                     # NOTE: there is no `subshell plugin` command anymore
                                     # (inversion spec 2026-09-10 §6, Task 7). The node
                                     # holds no plugins: harnesses live on the control
                                     # plane, launches carry the plane-built argv, and
                                     # binary detection is the plane's `detect` command.
                                     # A leftover <dataDir>/plugins/ directory is inert
                                     # residue — NOT seeded, NOT refreshed, NOT deleted.
subshell service install|uninstall # systemd user unit / launchd agent
subshell service status [--json]   # what the service MANAGER reports; always exits 0
subshell service start|stop         # drive an installed service; never installs one
subshell service restart [--force]  # --force overrides the refusal to restart a
                                     # definition that would SIGKILL live panes
subshell maintenance on [--yes]    # take this node out of service (spec 2026-09-14):
                                     # it keeps answering every other command and
                                     # launches nothing. `on` STOPS every subshell
                                     # running here — so without --yes it lists them
                                     # (name · id · cwd), refuses with exit 1 and
                                     # writes NOTHING. No prompt HERE — `maintenance`
                                     # asks nothing, the same shape `service restart
                                     # --force` has. (`run()` as a whole is no longer
                                     # promptless: `setup` asks one question through
                                     # RunDeps.prompt, injected by tests.)
subshell maintenance off           # back in service
subshell maintenance status [--json] # what THIS machine's mirror says; always exits 0
subshell status [--json] [--probe] # lock-file truth; --probe DIALS the plane and
                                     # newest-wins KICKS a running agent — warned loudly
subshell update [--check] [--to <v>] [--from <file>] [--force] [--yes] [--json]
                [--no-restart]     # replace THIS binary with a newer one and restart
                                     # into it. See "Update" below. --rollback is a
                                     # FLAG rather than a subcommand: it is the same
                                     # verb pointed backwards, and a subcommand would
                                     # invite `update rollback --to 0.8.0`
subshell update --rollback [--yes] [--json]
subshell mcp                       # stdio MCP server for a subshell pane (internal;
                                     # configured purely by the SUBSHELL_* pane env)
subshell report attention turn_complete|needs_attention
subshell report session            # out-of-band reporting from a harness HOOK, which
                                     # runs on THIS machine — where the only program
                                     # guaranteed to exist is this binary. Same pane-env
                                     # contract as `mcp`, but an incomplete env is a
                                     # silent exit 0 rather than a usage error: nobody
                                     # typed this, and a hook's stderr and exit code land
                                     # in the user's own session. See mcp-core report.ts
subshell version                   # also `--version` / `-v` — aliased in the
                                     # COMMAND slot only, since argv[0] IS the
                                     # command here (`status --version` stays an
                                     # unknown flag, because it is a typo)
```

`status --json` also carries a `paths` block — `{ configFile, lockFile,
dataDir }`, all absolute — beside the fields above, present whether the node
is online or offline (it names the loaded config, not liveness). It exists so
the client desktop app's reset deletes exactly what THIS CLI names, never a
path the app derived itself — the same rule `subshell-server status --json`
follows for its own reset (design: `docs/superpowers/specs/2026-09-11-native-reset-both-desktop-apps-design.md`
§5.1). The block is absent when no config loaded (the not-enrolled branch):
there is no `dataDir` to name, and a reset with nothing enrolled has nothing to
delete. As with every other field here, the node key is never included,
`--json` or not.

## Logging

`src/log.ts` is the agent's only log surface: **LogLayer** with TWO transports
— the core `ConsoleTransport` and `CappedFileTransport` (`src/log-file.ts`) —
both built on what ships inside the `loglayer` package, so the compiled binary
takes on no third-party dependency for logging. `log(message)` is the common
call; `logger` is there for `withError()` / `withMetadata()` / levels.

**The file exists because the console does not answer the question.** What
happens to the agent's stdout is a different thing on every platform: launchd
redirects it to a file, systemd hands it to the journal, a container sends it
nowhere in particular — which is why `collectRuntime` reports a `logHint`
telling a person to go run `journalctl`. Most nodes are headless, so "read this
machine's log" has to work from a browser, and it cannot be built on an
artifact that only exists on macOS. So the agent writes one bounded file of its
own: `<configHome>/logs/agent.log`, JSON lines, 0600, capped at 200 KB and
REPLACED when full, the same everywhere, served to the plane by
`agent_log_read` and reported as `runtime.agentLogPath`. It is a deliberate
COPY of the server's `utils/log-file.ts` rather than an import — that file is
AGPL and this app is Apache-2.0, so importing the value would entangle the two
licences for sixty lines.

**Debug level is a switch, and it currently reveals nothing.** The file
transport carries a `level` (`info` by default) and `debug-logging.ts` flips it
live — off by default, persisted in `config.json` so a `service restart` does
not silently end a debug session, forced on and made read-only by
`SUBSHELL_DEBUG_LOGGING` in this agent's environment (only `1`/`true` force;
`=0` is a variable somebody left behind, not the environment saying off). The
plane drives it with `set_log_level` and shows it on the node's Log card.

Two things to know before reaching for it. The agent has **no `logger.debug`
call sites**, so turning it on changes what would be recorded rather than what
is — the mechanism went in ahead of the lines by decision, and the card says so
on screen. And the server's equivalent switch is not the same feature: that one
exists for `@loglayer/elysia`'s per-request lines, which is why it carries
security accounting about paths that can hold a setup key. An agent serves no
HTTP and has no equivalent stream — so whoever writes the first debug line here
owns redoing that accounting for whatever it carries.

The console transport is never touched by any of this: what journald or launchd
collects stays at `info`.

Three more things about it are deliberate:

- **The line format is unchanged** from the hand-rolled `console.log` it
  replaced (`[subshell <ISO>] <message>`, via `messageFn`). The daemon's stdout
  is read by whoever runs `subshell run` and by systemd/launchd, and launchd's
  log file stamps nothing itself.
- **`errorSerializer` flattens errors to plain strings.** Handing the console a
  raw `Error` makes Bun's inspector print source context, which inside a
  `--compile --bytecode` binary is the *whole minified bundle* — measured at
  ~25 KB in front of one stack trace. Four lines, no `serialize-error`
  dependency (the server can afford one; a downloaded artifact should not).
- **Tests never spy on `console`.** `__tests__/helpers/capture-logs.ts` swaps
  the TRANSPORT (`logger.withFreshTransports`), LogLayer's own seam. The old
  console spies asserted against which console method a level happens to call,
  so routing through LogLayer blinded eight tests at once — each still passing
  its setup and failing its assertion, with nothing naming the cause.

`service install` refuses without an enrolled config; `service uninstall`
deliberately does NOT (a deleted config is the de-facto unenroll — an enabled
unit must stay removable). Linux: `~/.config/systemd/user/subshell.service`
(`Restart=always`) + `systemctl --user enable --now`; success prints the
`loginctl enable-linger $USER` hint UNLESS this user already lingers (see
below). macOS: `~/Library/LaunchAgents/dev.subshell.client.plist` (KeepAlive,
log at `~/Library/Logs/subshell.log`) + `launchctl bootstrap gui/<uid>`. The
plist carries `AssociatedBundleIdentifiers=[dev.subshell.client]` so System
Settings → Login Items labels the job **Subshell Client** with the app's icon
instead of the signing organization — the label and the association are the
ONE protocol constant `DESKTOP_CLIENT_BUNDLE_ID`, which is also Subshell
Client's own bundle id (the app's tests pin it; `LAUNCHD_LABEL` is that same
constant).
`service status` also reports `logPath` (that file on macOS, `null` on Linux —
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
is still found when the service manager — which starts units with a stock PATH —
runs the daemon; spaced paths are quoted in the systemd `ExecStart=`.
Everything is DI'd through `ServiceDeps` (`src/service.ts`) so tests pin the
exact unit/plist text and command sequences without touching systemd.

**`linger` is a second question about starting, not a sharper answer to the
first.** A `systemd --user` unit runs inside its owner's LOGIN SESSION, so
`enabled` buys a unit that comes back when somebody signs in and dies when they
sign out — and most nodes are machines nobody ever signs in to, where that is
an agent which is simply not there. `loginctl enable-linger` is what gives the
account a session at BOOT instead, and the defect this closes is that the agent
only ever mentioned it once, on stdout, at install time, to a terminal with
nobody at it. `ServiceState.linger` now carries the fact — `service status`,
`--json`, and `ready.runtime.service.linger` (protocol 9), so the plane can
say which of the two this machine is rather than advising every node in the
abstract — and the human view prints it as `survives logout` directly under
`starts at login`, because reading the two together is the whole point.

`null` is reserved for "nobody answered", and two things that look like gaps
are not. On macOS it is `null` and NOTHING is missing: a LaunchAgent's lifetime
IS the login session by design, there is no knob, so the line is omitted rather
than rendered as unknown. And a non-zero `loginctl` whose output says "not
logged in or lingering" is an ANSWER of `false` — logind holds no record of
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
criterion is **one fact rendered to a HUMAN on two CLIs, which must agree** —
not "parsing versus platform logic", which would sweep in `parseLaunchctlPrint`
and `killModeFromUnitText` and commit the next person to a migration nobody
asked for. Those two feed each port's own state machine, never a user, and the
two sides could legitimately diverge on them tomorrow. `survives logout` is the
other kind: both `service status` commands print it, its regex over
`loginctl`'s error wording is brittle by nature, and correcting one copy would
leave the other quietly wrong on exactly the headless machine the fact exists
for. When to ask and what to do with the answer stay here.

`queryService`/`controlService` (ported from `apps/server/api/src/service.ts`,
2026-09-05 — async here, since every seam in this module is) are what
`service status|start|stop|restart` run on. Two platform facts they encode:
the EFFECTIVE systemd `KillMode` comes from `systemctl show` (a unit-file grep
cannot see a drop-in under `subshell.service.d/`), and launchd state comes from
`launchctl print gui/<uid>/<label>` — the legacy `launchctl list` resolves an
IMPLICIT domain and reports a running gui job as absent over SSH, while every
write here targets `gui/<uid>` explicitly. A `print` that answers reports its
state VERBATIM in `detail` (`launchd: spawn scheduled` = the crash-throttle
wait, not a plain stop), and one that fails for anything other than
"Could not find service" (exit 113) is `state: unknown` with the stderr kept —
a manager that would not answer is not the same fact as a daemon that is
stopped. Start is `bootstrap` falling back to
`kickstart -k`; restart is `kickstart -k` (a bare `kickstart` on a running job
changes nothing); stop is `bootout` (KeepAlive undoes a mere kill), and on
Linux `stop`, never `disable --now` — un-enabling is what uninstall is for.

**The pane guard is the reason those live here rather than in the caller.**
This node's subshells run their tmux servers as CHILDREN of the daemon, so a
definition lacking `KillMode=process` / `AbandonProcessGroup=true` SIGKILLs
every live pane on the machine when the daemon is stopped OR restarted. The
current templates carry both, but a host that installed an older agent has a
stale definition on disk — so `restart` REFUSES without `--force`, `stop` warns
and proceeds (refusing would only push the operator to `systemctl`, which warns
about nothing), and both fail CLOSED on an unreadable definition. `service
status` reports it as `teardown keeps panes`.

## Update (`src/update.ts`, `src/commands/update.ts`, spec 2026-09-15 §5)

This agent can replace its own binary — from `subshell update` at the keyboard
or from a signed `update` command the plane sends — and both run one
`applyUpdate`, so the download, the verification and the marker have one
implementation rather than two that drift.

**Every install is a transaction the NEXT PROCESS completes.** The updater
cannot see the future boot; the booting agent can see the past update. So
whoever swaps writes `<dataDir>/update-pending.json` and keeps the old file as
`<binary>.previous`, and the agent that comes up settles it:

- **Accepted** → delete both. The node has no database, so there is nothing
  else to clean up.
- **Refused with 4406** → rename `.previous` back, write `update-failed.json`,
  exit 1. The service manager respawns the version that worked, on a machine
  nobody had to visit. That swap-back IS the node's whole rollback.

Without a marker, 4406 behaves exactly as it always did (log and exit): a plane
refusing an agent nobody just updated is the ordinary "your node is too old"
case, and swapping files there would invent a rollback for an update that never
happened.

**What counts as "accepted", and why the number is what it is.** There is no
accepted frame. Two things count: any frame the plane sends after `ready`, or
the socket staying open past `UPDATE_ACCEPTED_MS`. The spec put that timer at
30 seconds on the reasoning that a refusal is immediate — which was true when a
refused agent was CLOSED and is **not true now**: §5.3 made the plane HOLD a
refused socket, open and silent, until its own ten-minute idle budget expires.
At 30 s the two rules together delete `.previous` on exactly the machine about
to need it. So the timer is **15 minutes**, strictly beyond the plane's hold
budget, and it is a belt: the plane pushes `set_allowed_dirs` on every accepted
`ready`, so an accepted agent settles on a FRAME within milliseconds. The cost
of the timer never firing is a stale ~70 MB `.previous`; the cost of it firing
early is the rollback.

**Refusals are the WIRE CONSTANTS, never sentences.** The plane matches
`NodeRpcError.detail` by equality, so `applyUpdate` throws `UpdateRefused`
carrying a `NODE_RESULT_*` string alongside the human message, and the executor
answers the constant. `execUpdate` applies `service restart`'s two refusals
first — not supervised, and a definition that would take live panes down
without `force`, failing closed on `unknown` AND on no report at all — because
an update is a restart with a file swap in front of it, and a refusal arriving
after 70 MB has crossed the wire is worse for having been late.

**No network path installs anything the publisher did not sign (spec
2026-09-17).** `applyUpdate`'s url source carries `manifest: {bytes, sig} |
null`; `verifySignedManifest` runs before the swap — `null` (a command with no
manifest, or a resolve with nothing to verify) is
`NODE_RESULT_MANIFEST_UNVERIFIED`, and so is a signature that does not verify
against `RELEASE_PUBKEY` (the protocol package's compiled-in publisher key)
with the payload bound to component `node` + the version being installed. The
digest the bytes are compared against comes from the SIGNED `assets` map keyed
by the exact published filename, never from a `.sha256` sidecar or the
command's own `sha256` field alone. `resolveNodeRelease` (the CLI's own
`--check`/`--to`) fetches manifest+sig and verifies BEFORE the 70 MB download,
so an unsigned release costs two small reads; the plane-commanded path cannot
pre-verify (the bytes come from the plane's tokened route) and re-verifies
against the actual digest instead. `--from` and `--rollback` stay
signature-free: a file the operator named IS their decision, already verified
as far as it can be (it must say it is the agent at the expected version).
The CLI refuses, with three differently-worded messages that all end by
naming `--from`: an empty release source, a release with no manifest asset,
and a signature that does not verify.

**The `update` command's wire shape is FROZEN across protocol bumps**
(`node-frames.ts`). It is the one command the plane sends to an agent whose
protocol it does NOT share — §5.3 holds such a socket precisely so this can
reach it — so the parser on this side may be any older build. A test pins the
shape as a literal rather than deriving it from the same source as the code.
Protocol 12 (spec 2026-09-17 §6) grew it by exactly two fields,
`manifest` (base64 of the verified manifest bytes) and `manifestSig`,
OPTIONAL at the frozen parser and enforced in the executor — and,
deliberately, NOT for everyone: a pre-12 agent would parse such a command and
IGNORE both fields, installing on the old trust rule, so a 12 PLANE refuses
to send `update` to a pre-12 agent at all
(`NODE_SIGNED_UPDATES_PROTOCOL_VERSION`; the route's 409 and the Updates
page's row say "agent predates signed updates"). A held old-protocol socket
therefore keeps everything it was held for except this: the machine that most
needs updating is the one told, in a sentence, to update by hand.

The release source is `SUBSHELL_RELEASE_URL` (unset = the project's API, EMPTY
= air-gapped and every network read refuses pointing at `--from`), and the CLI
prints one line it cannot answer itself: **this binary holds no REST
credential**, so it cannot ask its own plane which version that plane can talk
to. `Settings → Updates` knows; `--to` is how a person acts on having read it.

`status --json` gains `paths.binary` (null under an interpreter, where there is
no single file to name) and `update: { pending, lastFailure }`.

`test:cli`'s `node-update.sh` is what proves the swap with two REAL binaries:
it installs this build, compiles a `99.0.0` one from the same source with a
patched `package.json` (restored from a trap), and drives `--check`, the
`--from` swap, the "already at" refusal, `--rollback`, a rollback with nothing
to roll back to, and a file that cannot say what it is. It boots no server and
dials no plane — an agent has no database and no boot-time transaction, so the
only state `update` reads is `config.json`'s `dataDir`, which the script
writes by hand. The **4406 revert** is deliberately not compiled there: it
needs a control plane built on a different protocol constant, a second ~110 MB
build to exercise a close handler `daemon.test.ts` already drives directly.

## Maintenance (`src/maintenance.ts`, spec 2026-09-14)

One flag, `<dataDir>/maintenance.json` = `{ on, changedAt }`, meaning "this
machine stays enrolled and answers everything, but takes no new subshells". It
is settable from either end — the plane's `set_maintenance` command and this
machine's own `subshell maintenance` verb — and the two copies are reconciled
on reconnect by the NEWER `changedAt`, which is why every writer here stores
the stamp it was GIVEN and never re-stamps a value it is merely relaying.

**Its own file, not a field in `config.json`.** `config.json` is snapshotted at
daemon boot, so a value there would not reach a running daemon until it
restarted — and the point of the CLI verb is that the person at the keyboard
flips it under a live agent. It is also the node key's only home, and a value
flipped several times a day does not belong in the file whose every rewrite
risks the machine's credential.

**The read is fail-CLOSED, deliberately unlike `allowed-dirs.json` beside it.**
An unreadable allowlist widens the node to unrestricted, because that list is a
restriction an owner opts into and a disk hiccup must not brick every launch.
Here it inverts: a refusal that fails open is not a refusal, so an unreadable
file refuses every launch and `maintenance status` says exactly that instead of
reporting a tidy "off". An ABSENT file is the third answer and is not
fail-closed — a node that was never told anything behaves as it always did.
Absence also travels differently from `{ on: false }`: `ready` omits the field
entirely, so the plane's own row wins outright rather than tying with a stamp
nobody wrote.

**The reporting ORDER is load-bearing.** `maybeReportMaintenance` runs inside
`reportDeath` BEFORE the `exit` frame, not only on the heartbeat. The plane
serialises frames per socket, so the flag landing ahead of the first death is
the difference between "the operator took this machine down" and N crashes the
plane pushes as failures and tries to auto-restart onto a node that refuses
launches. The heartbeat call is the belt for the other case — a flip with no
panes running, where nothing dies to carry it. Anything that reorders
`report.ts` has to re-check this.

The refusal a launch answers with is the BARE `NODE_RESULT_MAINTENANCE`
constant: the plane compares `detail` by equality, so a suffix — however
helpful — reads there as an ordinary launch failure. The event that rides with
it is what lets the plane converge from a refusal it did not expect.

**An unreadable file is REPORTED too, as the `on` it actually produces**, under
the FILE'S OWN mtime. Reporting nothing there was a permanent disagreement in
the common case of a node the plane never flagged: with no row of its own the
plane has nothing to reconcile, so it keeps the node launchable while every
create 409s, and neither side ever rewrites the file. Reported, the plane
adopts it and the operator's "off" in the browser pushes a clean
`set_maintenance` — which is the thing that actually repairs this machine. The
mtime rather than `now` because it is the one timestamp nobody invented, and
because it is STABLE: a fresh stamp per read would defeat the report memo and
put one frame on the wire per heartbeat forever. Only a file this process could
not even stat refuses silently — there is then nothing truthful to send.

**A mirror DELETED under a live connection is rewritten from the memo.** The
plane holds what this socket last told it and the machine now reads "absent ⇒
off", and nothing reports the gap because absence has no stamp to send; the
memo is by definition that agreed value, so writing it back restores what the
plane's own reconnect push would have. Only for absence — an unreadable file is
reportable on its own terms, and overwriting it would destroy evidence.
Hand-deleting the file is not an interface; `subshell maintenance off` is.

A restore that FAILS (a read-only disk, a path nothing can create) is retried
every tick and logged ONCE per connection. The retry is cheap and succeeds the
instant the disk returns; the line is capped because the heartbeat is 15 s, so
an ungated failure writes four lines a minute into one 200 KB file that is
REPLACED when full — about six truncations a day, discarding exactly the log
an operator is going to read about this machine. `seedMaintenanceMemo` seeds
that flag together with the memo, so a reconnect says it once more.

`maintenance status` reports the mtime for an unreadable file too, with
`file: "unreadable"` as the discriminator saying where the stamp came from: a
`null` there beside a node page showing the mtime is two answers for one file,
read by whoever is mid-incident comparing the two.

The CLI's `on` never forgets a meta record for a pane it kills. With no daemon
running those records are the only thing the reconnect census can report;
dropping one would leave the plane holding a `running` row with nothing on this
machine able to contradict it. It also RE-PROBES after each kill rather than
assuming it worked: `killSubshell` is synchronous and swallows its own errors,
so `stopped` counts only what the socket confirmed gone and anything still
alive is named on stderr. The exit stays 0 — the flag is written and the
machine launches nothing either way.

## What `ready` reports about this process (`src/runtime.ts`)

`ready.runtime` (spec 2026-09-12 §6.1) answers "how is this agent running" —
supervised or not, the manager's view of the unit, the config and log paths,
tmux, and the binary this process re-enters. `collectRuntime` builds it ONCE,
before the connect loop, from one `service status` spawn.

**Once, and then frozen: the same object is resent on every reconnect.** That
is what lets the control plane compare `startedAt` for EQUALITY rather than
against a tolerance, and the SPA's restart waiter has no other signal — a node
that goes offline and comes back is only distinguishable from a flapping socket
by that field changing. Re-deriving the report per connection would make a
reconnect look like a restart, and the wait would end early with nothing
naming the cause. Collecting per process is also honest on its own terms:
nothing in the report can change while the pid does not.

A failed read degrades to no `runtime` at all rather than a null-filled one —
the field is optional on the wire, and the plane shows no card. `parseNodeEvent`
drops a malformed one and keeps the `ready`, so a wrong report costs the card
and never the connection.

## `service` (`src/commands/service.ts`)

The plane-sent `{ type: "service", verb }` drives this machine's service
manager — `start`, `stop`, `restart`, `install`, `uninstall`. Through protocol
4 `restart` was its own command; folding it in removed a second refusal path
and a second chance to disagree about pane safety.

**`restart` is not `systemctl restart`.** It exits 0 and lets the manager
respawn the agent — asking systemd to restart the unit from inside that unit
kills the process mid-command, so the result frame never goes out and the plane
sees a dropped socket instead of an answer. Every other verb is a real call to
the manager, through the same `controlService`/`installService` the CLI uses.

**Two of the five are one-way from the plane, and nothing here can soften
that.** A command arrives over the agent's OWN socket, so `stop` and
`uninstall` end the connection that would have carried the verb undoing them —
the plane can never start an agent that is not running. The PLANE gates those
two on ownership and says so in its confirmation; this side simply performs
them.

Three things about `restart` are load-bearing:

- **The `result` frame goes out FIRST, and the exit is 250 ms later.** The
  daemon is the only sender of `result`, so an executor that exited itself
  would reach the plane as a TIMEOUT rather than a success — the restart would
  have worked and the UI would say it failed. The executor therefore returns
  `{ ok: true }` and asks the daemon to exit (`CommandContext.requestRestart`).
- **It refuses when `runtime.supervised` is false**, which means the manager did
  not start this pid: exiting would be a stop, not a restart. A foreground
  `subshell run` is the common case.
- **`paneSafety: "unknown"` refuses with `"kills"`, not with `"keeps"`.** Same
  fail-closed rule the CLI's own destructive verbs use — an unreadable
  definition is not evidence of safety — and `force: true` is the only way past
  either. That refusal is not restart's alone: `stop` and `uninstall` end the
  same panes, so all three destructive verbs carry it and `start`/`install`
  never can.

The exit takes the SIGINT/SIGTERM path verbatim (set `shuttingDown`, close the
socket 1000, let the loop's `stop(0)` run), so `daemon.lock` is cleared by the
one exit path that has ever cleared it.

## Exit watch

The shared 2 s tick (`src/commands/report.ts`) probes each tmux socket once
via `listSubshellsChecked`: an authoritative `ok:true` answer lacking the pane
reports the death IMMEDIATELY with the pane's real exit code when one is
readable (tests pin 6), while the escalated path —
`NODE_EXIT_UNREACHABLE_TICKS` (2 — ≈4 s) CONSECUTIVE
`ok:false` probes on one registration — reads `null` because the socket is not
answering, so it is THAT report that carries `exit{code:null}`; a transient
tmux blip never kills a live pane, and a fresh registration carries a fresh
counter budget (a relaunch resets it) — hardening design 2026-09-02 §1.

## On disk

- **Config home** — `~/.config/subshell`, override `SUBSHELL_CONFIG_HOME` (tests
  use it): `config.json` (0600 — the nodeKey's ONLY home, never echoed by
  `status`, not even `--json`) and `daemon.lock` (local-liveness for `status`,
  refreshed on every 15 s heartbeat tick; observability only, never authority).
- **Data dir** (`--data-dir` at enroll; default under the home): `identity.json`
  (node keypair — fail-closed: a present-but-corrupt file is quarantined, never
  silently rotated), `allowed-dirs.json` (the pushed
  directory allowlist, 0600 — fail-OPEN on a corrupt read, deliberately unlike
  `identity.json`'s fail-closed quarantine: the list is a restriction an owner
  opts into, not an authentication decision), `maintenance.json`
  (`{ on, changedAt }`, 0600, atomic temp+rename, read fail-CLOSED — see below),
  `update-pending.json` / `update-failed.json` (0600, the update transaction's
  markers — see "Update" above; `failed` survives until the next update, so the
  reason is still on screen an hour later),
  `subshells/<id>.meta.json` + `<id>.log` per supervised
  subshell (each meta's cwd is a `write_file` path-policy root alongside the data
  dir itself), `mcp/<id>.json`
  per-subshell MCP configs, and the MCP children's `identities/sess-<id>.json` +
  `peers.json` (they run with `SUBSHELL_DATA_DIR` = the agent's data dir).
- **Enroll preflights `tmux`** on PATH (macOS hint: `brew install tmux`);
  `SUBSHELL_CLIENT_SKIP_TMUX_CHECK=1` is the test escape hatch.

## Testing

`bunfig.toml` preloads `src/test-preload.ts`: `SUBSHELL_CONFIG_HOME` points at a
throwaway temp dir (suites NEVER touch `~/.config/subshell`),
`SUBSHELL_TEST_MODE=1`, and the tmux preflight is skipped (the tmux-absent refusal
is covered explicitly by clearing the var). `src/scripts/release.ts` guards its
CLI main behind `import.meta.main` so tests import the pure publish/build logic
without building or spawning; `src/service.ts` needs no such guard — it is
side-effect-free by DI design (everything arrives through `ServiceDeps`; the CLI
entry lives in `cli.ts`).
