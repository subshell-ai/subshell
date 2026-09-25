# Pane-log retention: the full account

Moved verbatim from `apps/node/agent/AGENTS.md`, which keeps the operational
summary and routes here. Only cross-references into sections that moved were
repointed.

## Pane-log retention (`src/pane-log-retention.ts`, 2026-09-23)

Pane logs (`<dataDir>/subshells/<id>.log`, the verbatim typed transcript)
now age out **on this machine**. Before this the only node-side deletion was
the plane commanding `remove_paths` at delete time, so a node OFFLINE for a
delete kept transcripts indefinitely and a terminated-but-kept pane kept
them for the life of the box. The daemon runs one pass at boot and an
hourly pass after it (`runDaemon`, beside the uploads sweep, LOCAL work
that does not wait for the plane and keeps running while it is unreachable),
deleting files older than `days*24h + hours` whose pane the tmux census does
not find live. The boot pass is STARTED before the first dial but never
AWAITED by it (round-3 review, finding 2): the sweep is fire-and-forget with
the same swallow-and-log posture as the hourly beat, and what a slow boot
could not finish the next tick retries with fresh state: wedged tmux may
cost transcripts an hour, and must not cost the node its connection. Three
rules:

- **The window is the node's own configuration**, resolved per field:
  `SUBSHELL_LOG_RETENTION_DAYS` / `SUBSHELL_LOG_RETENTION_HOURS`
  (env wins, the ladder everywhere), else `config.json`'s
  `logRetentionDays` / `logRetentionHours`, else **1 day / 0 hours**.
  `0 + 0` together is keep-forever and skips even the boot pass; an unusable
  env spelling is one warn line and the next layer, never a failed start
  (`loadConfig` junk-drops the stored field to the same safe default). The
  BOOT resolution decides the schedule; the default pass re-reads
  `config.json` every run (`createRetentionPass`), which is what lets a
  dashboard write land without a restart; see the setter below.
- **A running pane's log is never swept**, and the census is
  `meta.list() × hasSubshell`, the maintenance census, not the exit
  watcher's in-process registrations, because panes survive an agent
  restart. A `hasSubshell` that THROWS (tmux timeout) counts the pane
  running: the sweep deletes, so unknown is not dead. Orphans (a log with no
  meta, the transcript a missed delete leaves) ARE eligible. The probes run
  CONCURRENTLY, capped at `CENSUS_CONCURRENCY` (8): production mints one
  tmux socket per subshell, so the exit watcher's per-socket
  `listSubshellsChecked` batch would still be one spawn per record here;
  what a wedged host cost was the SERIALITY (N × the 15 s timeout, finding
  2), and concurrency fixes exactly that. The batch shape was also refused
  on semantics: its `ok:false` collapses "the server is gone" (which
  `hasSubshell` answers `false`, and which is what ages a kept pane's log
  out after its server dies) with "the server did not answer", and this
  module's whole safety rule lives on that distinction.
- **Only pane-log name shapes are touched**: `<valid-subshell-id>.log`
  inside the dir, `pathAllowed`-accepted against the data dir, the
  `remove_paths` rule, which is what refuses a symlink leaf.

**The setter surface is node-local** (R3, 2026-09-23): `src/retention-settings.ts`
behind the dashboard's `GET`/`PUT /api/self/log-retention`. It lives under
`/api/self/` rather than the mirrored `/api/nodes/:id/*` contract precisely
BECAUSE the plane has no counterpart route: a shared card would render an
editor the plane cannot answer; `@internal/node-web`'s Settings page hosts the
block (`log-retention-card.tsx`), next to the Updates card's local endpoints.
The rules are `debug-logging.ts`'s, PER FIELD: the write validates by
`retentionField`'s rule raised from a junk-drop to a refusal (a junk value in a
write is an explicit request, not a field to drop to the default), and a field
the ENVIRONMENT answers refuses 409 naming its variable, because a write the
next read masks is a success report for a change that never happens. A blank
or junky env value answers nothing (resolution warns and falls through), so it
forces nothing and the stored write is allowed, the `SUBSHELL_DEBUG_LOGGING=0`
rule. A combined write naming one forced field stores NOTHING (one status
cannot report two outcomes; the operator retries the writable half and gets a
clean yes). A successful write lands in `config.json` through `updateConfig`
(`config.ts`), the merge every LIVE writer shares (round-3 review, finding 3,
the node's twin of the fixed C7): it re-reads the file AT SAVE TIME and applies
only the keys the write names, so a retention save can never revert a
debug-logging flip made under it, nor either revert `configure`'s address edit:
this file is the node key's only home, and last-writer-wins is bounded to the
ONE key two writers overlap on, never to fields either one ignored.
(`loadConfig` models every field worth keeping; `debugLogging` joins for
exactly this reason: a dropped field is silently cleared by the next unrelated
write, and `loadAndApplyDebugLogging` can only restore what the loader
returns.) And `WHEN` the write lands is a BOOT fact, not a file fact
(round-3 review, finding 5): the endpoints report `scheduled` (whether THIS
daemon armed the hourly timer at boot, stated once by `runDaemon` through
`noteSweepScheduled` because no disk read can answer it), and the card derives
both sentences from it: with a pass scheduled every change applies at the next
sweep WITHOUT a restart, including a move away from forever (only a running
pass can notice that); an unscheduled boot (the forever shape, or a standalone
dashboard with no daemon at all) waits for the restart that arms one. `PUT`/409
each get one agent-log line (there is no audit row on this surface; the log is
the machine's record). No CLI verb:
no `subshell config` command exists to extend and `configure` is deliberately
the two plane-address edits and nothing else. The daemon tests drive the sweep
through the `retentionPass`/`retentionMs` seams; the default pass's re-resolve
is pinned through the real one.
