# The server manages itself on an admin's request: the deep sections. Moved verbatim from `apps/server/api/AGENTS.md` (a compact table and the headline rules stay there); AGENTS.md routes here.

## The routes, the no-route rule, and the no-secret rule (AGENTS.md keeps a compact table)

## The server manages itself on an admin's request

Spec 2026-09-12 moved every server-UP management surface out of the Subshell
Server desktop console and into the SPA, so a browser on the LAN and a headless
install get it too. That meant it had to become HTTP. Five routes in
`api/admin-server/`, composed into the `adminRoutes` group and every one of
them behind `requireAdmin` (cookie session, admin role, bearer keys refused)
exactly like `GET /api/admin/status`:

| route | |
| --- | --- |
| `GET /api/admin/server` | how this server is DEPLOYED, as against `admin/status`, which is what is HAPPENING on it: config.env saved-versus-running, the service manager's answer, the data locations, whether a self-restart is possible; `TRUSTED_ORIGINS` is the exception: it is read live, so `saved === running` for it always |
| `PATCH /api/admin/server/config` | rewrite config.env through the CLI's own writer (below). `DATABASE_PATH` is deliberately absent; moving the database from a web page is a footgun with no undo |
| `POST /api/admin/server/restart` | exit for the service manager to respawn |
| `POST /api/admin/server/autostart` | arm or disarm start-at-login for the installed service. Inside the no-route rule rather than an exception to it: it touches nothing about the running process |
| `GET /api/admin/server/logs` | the tail of the server's own log file |
| `PUT /api/admin/server/logging` | the debug switch, applied live |

What did NOT become a route is the corollary of the same rule: stop, start,
install, uninstall and reset each leave the server unreachable, so a page
cannot be the thing that performs them. They stay with `subshell-server
service <verb>` for the headless operator and the desktop assistant for the
other one.

`GET /api/admin/server` carries no secret in any form, and its test asserts the
response's ENTIRE key set, the same rule `GET /api/settings/instance` carries,
so a field added later is a decision rather than an accumulation.

### Source attribution, and the systemd trap

`settingSource` (`services/server-deployment.ts`) answers which layer a
setting's saved value came from, and the PATCH route turns `process env` into a
**409 refusal**: a file write the next boot would mask is a success report for
a change that never happens.

That makes the rule load-bearing, and the obvious version of it is wrong.
"Is the key in `process.env`?" refuses every field of every PATCH on the
primary Linux deployment, because `service install` writes
`EnvironmentFile=<configDir>/config.env` into the unit, so systemd exports all
five keys before the process starts, `loadConfigEnv` finds them present and
applies none of them, and the whole file reads as environment-owned. It would
have looked like a correct safety refusal while making the Addresses card
read-only on every systemd host.

So the question is not "is it in the environment" but "would writing the file
take effect", and three rules answer it: a key `configEnvAppliedKeys()`
records (the loader put it there itself) is the file's; a key the environment
already held whose value the file also names is STILL the file's, because
systemd re-reads that file on the next start; anything else in the environment
genuinely overrides it. `collectStatus` has always attributed it the second
way; this brings the two into agreement rather than inventing a rule.

**Do not simplify this back to a presence check.** The unit is what makes it
wrong, and nothing in the type or the call site says so.

### `TRUSTED_ORIGINS` is live, and env-ownership is decided once

The PATCH route rewrites config.env and the registry then RE-READS the key from
the file (`originRegistry().reloadStored()` in `patch-config.route.ts`): the
stored extras are RELOADED ON WRITE, because the assembled set is what every
request CONSULTS, so a reload at the write is what makes a trusted origin that
changed take effect with no restart. Two seams in
`services/trusted-origins.ts` (`productionDeps`) make that hold on the primary
Linux deployment:

- **`process.env` is mirrored from the file, but only when the loader had
  already put it there.** `collectStatus` reads `process.env` first for `saved`,
  so a live change that left a stale shadow in place would be reported as
  awaiting a restart, the exact lie this registry removes, and the NEXT PATCH
  would 409 as environment-owned. An env-owned key is never written; a key the
  environment never held stays untouched.
- **Env-ownership is decided ONCE, at construction** (boot, before the
  listener, where `settingSource` sees env equal to file and the answer is the
  file's). It cannot be re-asked after a write: on every `EnvironmentFile=` host
  the file has then changed under an environment that has not, and that
  comparison reads as "the environment overrides it", the systemd trap above
  arriving from the other side.

### `isSupervised` is the manager's pid, never a marker

`POST /api/admin/server/restart` restarts by EXITING, which is only a restart
where something respawns the process: `Restart=always`/`RestartSec=5` on
systemd, `KeepAlive=true` under launchd. The server cannot see its own manager
from its environment (the unit and plist templates set only `PATH`,
inventoried 2026-09-12), so the honest question is asked of the manager
instead:

```
supervised = service.state === "running" && service.pid === process.pid
```

An environment marker was the alternative and it is worse in both directions:
it would be true for anyone who exported it and ran the binary by hand (exiting
into nothing), and false on every host whose definition was written before the
marker existed, until `service install` rewrote it. `MainPID` and `launchctl
print`'s `pid` name the process the manager actually started, so the comparison
is true exactly when exiting is a restart.

Pane safety follows the CLI: a definition without `KillMode=process` /
`AbandonProcessGroup` takes every live tmux pane down with the process, so the
route refuses it without `force`, the same bar `service restart --force` sets.

`performRestart` (`services/server-restart.ts`) closes every browser terminal
socket and every node socket with **1012 Service Restart**, then exits 0 after
a delay that lets the route's own 202 flush. 1012 is chosen for being BELOW
4000: the SPA's socket treats the 4xxx range as a refusal to report and
anything under it as a connection to retry, so the browser reconnects itself
rather than showing a rejection. The 202 carries `resumeAt`, the saved
`APP_BASE_URL`, because the restart may be the very change that moves the
address; a caller needs to know where the server comes back before its
connection goes. SQLite needs no close: bun:sqlite releases on exit and the WAL
is durable.

### The server's own log file

`<SUBSHELL_SERVER_DATA_DIR>/logs/server.log` (`status --json` reports it as
`paths.serverLog`): JSON lines, 0600 in a 0700 directory, capped at 200 KB and
**replaced when full**. One file, the same way on every platform, and nothing
in memory, including the HTTP request lines (operator direction 2026-09-12).
The console used to tail launchd's file on macOS and `journalctl` on Linux;
neither exists in a container, and a headless install may run under anything.
The manager's own log is still named in the deployment view
(`service.logPath` / `service.logHint`) for anything older than this file
holds.

**The writer is ours, and that was measured rather than preferred.**
`@loglayer/transport-log-file-rotation@3.3.0` with `size: "200k", maxLogs: 1`
was the intended one; the spike (2026-09-12, under plain `bun` and again
compiled) left FIVE files behind, each one over the 204 800 cap rather than
under it, deleted none of them, and wrote `<filename>.<n>` rather than the
filename it was given. `CappedFileTransport` (`utils/log-file.ts`) is the
replacement: a `BlankTransport` (loglayer's own `LoggerlessTransport` with a
supplied `shipToLogger`, so the level gate stays the library's and this needs
no dependency) appending a JSON line and truncating when the next one would
overflow. Truncating rather than dropping the oldest lines is what "replaced
when full" means, and it is why a partial line can only ever be the last one.

It creates its log directory on FIRST WRITE, not at module import. This module
is reachable from the CLI entry graph, which this package pins IO-free at
import (the import-purity invariant under "Standalone binary & CLI" in
`apps/server/api/AGENTS.md`); a `mkdirSync`
at import would be exactly the side effect those tests exist to forbid.

**The level policy is a split, not a level.** The pretty stdout transport is
pinned at `info` and left there, because that is what the service manager
collects and a debug session must not fill a journal. The FILE transport
carries the effective level, and `PUT /api/admin/server/logging` flips that one
field, live, no restart. HTTP request/response lines are emitted at `debug`
(`autoLogging.logLevel` in `plugins/context.plugin.ts`), so they reach the file
only in debug mode and the manager's log never; the polled routes
(`admin/status`, `admin/server`, its `logs`, `setup/status`,
`settings/public`, `/ws*`) are in that plugin's `ignore` list, or a debug
session would spend the 200 KB cap on the Service page asking how the Service
page is doing.

Debug logging is an instance setting (`settings` row `debug_logging`, absent =
off), read once at boot after migrations. `SUBSHELL_DEBUG_LOGGING=1` forces it
for a headless box or for the lines written before the database opens, and
while it is set the route answers **409** rather than writing a row the next
boot would override. The CLI's `--verbose` (2026-09-26) engages none of this:
it raises the CONSOLE transport of the hand-invoked run carrying it, flips no
setting, and forces no read-only rule; this paragraph stays the whole story
of the FILE switch.

### The node Service surface

`/api/nodes/:id/service`, `/logs` and `/config` give an enrolled node the
management surface the plane already has for itself (spec 2026-09-12, node
half). Most nodes are HEADLESS (the node is installed there, the GUI never is),
so a browser is the only place these questions can be asked at all.

| route | |
| --- | --- |
| `POST /api/nodes/:id/service` | start / stop / restart / install / uninstall, as one signed `service` command |
| `GET /api/nodes/:id/logs` | a byte range of the node's OWN log file |
| `PATCH /api/nodes/:id/config` | repoint the node at another control plane |
| `PUT /api/nodes/:id/maintenance` | take the machine out of service, or put it back |

**Maintenance is owner-only for a THIRD reason**, neither of the two below
(spec 2026-09-14). It leaves the node perfectly reachable, so the structural
argument does not apply, and it is trivially reversible, so the repointing one
does not either. What decides it is blast radius: turning it on TERMINATES
every subshell running on that machine, and any node share lets a grantee
launch there, so those subshells belong to people the node's owner cannot
enumerate and who did not act. That is the delete/re-share gate's business
(`gate.canManage`, admins on `local`), not an `edit` grantee's. The count it
would stop rides `GET /api/nodes/:id` as `runningSubshells` on that same
narrower gate; whoever can pay the price is who gets told it. `local` is NOT
refused here, unlike the three routes below: the control-plane host is a launch
target like any other, and taking it out of service is the one management act
that means the same thing on every kind of node.

**`stop` and `uninstall` are owner-only, and the reason is structural rather
than a permission subtlety.** Every command reaches a node over the AGENT'S OWN
socket, so the plane can never start a node that is not running: those two
end the connection that would have carried the verb undoing them. They are
one-way from a browser, reversible only by someone with a shell on that
machine. `restart`, `start` and `install` keep the `nodeCanConfigure` gate; they
leave the node reachable. **Repointing is owner-only too**, for a different
reason: the node then dials whatever host was typed carrying a credential
valid on THIS plane, and the machine leaves this instance.

`local` is refused by all three, BEFORE the permission check; it is a
statement about the route rather than about the caller, and a 403 would send
someone looking for an owner to ask.

`POST /api/nodes/:id/service` is the same act one hop away: a signed command,
and the AGENT decides. Gate is cookie-only and `nodeCanConfigure`
(owner or `edit`, NOT `canManage`); a `view` grantee may launch subshells on a
node, but driving its daemon interrupts everyone else's panes there. `local` →
400: the control-plane host manages itself through `/api/admin/server/*`,
which is a different act with a different gate, and routing it here would hand
a node's `edit` grantee a way to bounce, or stop, the control plane. No new
trust either way; the plane already runs arbitrary launches on an enrolled
node.

The node's refusals map to 409 `NODE_NOT_SUPERVISED`,
`NODE_RESTART_KILLS_PANES`, `NODE_NO_SERVICE`, `NODE_AGENT_TOO_OLD` (its
`unsupported` answer) and `NODE_OFFLINE`, with anything unrecognized falling
through to `NODE_UNREACHABLE` rather than being guessed at. `force` is REFUSED
(400) on `start` and `install`: it means "act even though live panes will die",
so a flag silently accepted where it does nothing is how a caller learns it is
noise, and then passes it where it is not.

**That mapping compares `NodeRpcError.detail` by EQUALITY**, against the
protocol's own `NODE_RESULT_*` constants. `detail` is the node's
`result.error` verbatim and exists for this: `message` wraps it in a sentence
(`node "x" reported: …`) that is right for a log line and wrong for a decision.
Matching a substring of it would have re-read `"not supervised enough,
honestly"` as the exact refusal, and would have changed meaning silently the
day someone reworded that sentence in `node-rpc.ts`.

The node answers `NODE_RESULT_KILLS_PANES` for `paneSafety: "unknown"` as
well as `"kills"` (its destructive verbs fail closed on a definition they
could not read), so only the plane can tell the two apart, and it does so in
the WORDING and never the code. Telling someone their panes will die when the
truth is that nobody could read the definition is the kind of certainty that
teaches people to ignore warnings. **Only an answered `"kills"` earns the
certain sentence**: `undefined` (no frozen runtime report at all, the
documented degraded shape) is a third absence of an answer and belongs on
the hedge side (the branch must read `=== "kills"`, never `=== "unknown"`,
which silently asserted over the no-report case), and the server's OWN
`restart`/`update` refusals follow the same rule on their own
`paneSafety` field.

`runtime` (the node's report of how its own process runs) lives on the LIVE
CONNECTION, never in the `nodes` table, and `GET /api/nodes/:id` exposes it
only when the node is online, the viewer can configure it, and the row is an
node. These are facts about a running process: offline, they are stale by
definition, and their absence is the honest answer.

### Node harness inventories refresh themselves

A node's harness inventory, which agent CLIs are actually present on that
machine, is the plane's cached answer to a `detect` command
(`services/nodes/inventory.ts`). Spec 2026-09-10 §4 made that a REQUEST: the
plane ships the lookup rules, the node probes and answers, and no node ever
scans on its own initiative. **That half is absolute and unchanged.** What
grew is the set of occasions that count as asking, because the original list
was people-only (page load, Re-check, a launch), which left a machine that
had just enrolled, and a machine somebody installed a CLI on an hour ago, both
reading wrong until their owner happened to open a page.

Two triggers were added, and they answer different questions:

- **A node coming online** (`node-ws-handler`'s `ready` case, after both
  refusal gates, beside the allowed-dirs push). This covers enrolment with no
  special case (a freshly installed node connects immediately), plus every
  reconnect and node restart. Fire-and-forget: the answer arrives as a later
  `result` frame behind this one in the socket's own serialized queue, so
  awaiting it would deadlock, and a failed probe must never fail a handshake.
  A HELD node is never kicked; it returns at the gate.
- **A periodic pass over the online nodes**
  (`services/nodes/inventory-refresh.ts`, armed by `index.ts` beside the other
  timers). The online set comes from the REGISTRY, like the offline sweep's,
  never a DB scan; `local` is skipped by name (its view probes live on every
  read).

**`NODE_INVENTORY_REFRESH_MS` is DERIVED as `INVENTORY_TTL_MS / 2`, not chosen
beside it.** The launch gate counts a node's cached answer only while it is
fresh (10 min), so a period longer than the TTL would leave an online, healthy
node reading as unusable for the remainder of every cycle; the refresh would
fail at the thing that matters most about it. Half the window means one
skipped or failed pass still leaves the cache fresh, and moving the TTL moves
the cadence with it. There is deliberately **no stagger**: a pass is one small
frame per online node, and the PATH walks it triggers run on those machines
concurrently, so the plane pays for frames, not probes.

Both triggers call the one `detectOnNodeBestEffort`, so there is a single
request path and a single merge rather than a second mechanism. Re-check is
the only caller that awaits `detectOnNode` and reports; a person is pressing
a button and waiting.
