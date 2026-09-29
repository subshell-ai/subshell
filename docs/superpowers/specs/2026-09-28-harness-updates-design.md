# Harness updates as a first-class feature (issue #250)

**Status:** approved (operator, 2026-09-28), phased, one spec. Phase 1 is committed
by this document; Phase 2 is reserved (its seams are named) and not built here.
**Context:** [subshell-ai/subshell#250](https://github.com/subshell-ai/subshell/issues/250)
asks for three things: an update action in each node's Harnesses section, the
server tracking which harness version each subshell launched on, and auto-restart
of panes onto the new version at turn end.

Current truth, measured in code:

- The Harnesses card (`node-harness-card.tsx`) already renders, per node, one row
  per instance plugin: icon, name, a verdict badge, the detected version string,
  and an action cell. Install exists but only on `local` (spec 2026-09-15 §5.3);
  its command runs on the control-plane host, and installing on an enrolled node
  was ruled out of scope (spec 2026-09-11 §11).
- Node inventory already carries per-harness versions: `detect` answers raw
  version text, the plugin's `parseVersion` runs plane-side, rows persist in
  `nodes.inventory_json` with a 10-minute TTL.
- The manifest contract (`packages/plugin-api/src/manifest.ts`) declares
  `install: { command, docsUrl }` and nothing about updates. The version probe is
  host-fixed (`<binary> --version`, 4 s bound, `pane-runtime/version-probe.ts`).
- No harness version is recorded per pane anywhere: `subshells` has `harnessId`
  and `harnessSessionId`, no version column, and neither the launch frame, the
  node's `.meta.json`, nor any view carries one.
- The plane cannot make an enrolled node run anything outside its fixed command
  dispatch table; a new command means a `NODE_PROTOCOL_VERSION` bump plus the
  `MIN_NODE_VERSION` and agent `package.json` floor moves in the same commit
  (server and node ship together, no compatibility window).
- Idle is already a server fact: `subshells.waitingSince`, stamped by the
  attention hook route on hook-capable harnesses and by the quiet-output watcher
  on hook-less LOCAL panes only. `restartSubshell` resumes the conversation when
  the plugin implements `resumePath`.

The issue therefore decomposes into four pieces of very different cost: the
local Update button (rides the install rails), the enrolled-node Update (a new
signed command, protocol bump, progress mechanism, dashboard parity), version
stamping (a column plus launch-path writes), and turn-end auto-restart (an
engine over `waitingSince` with a coverage hole on remote hook-less panes). The
operator ruling 2026-09-28: one spec, phased; Phase 1 ships the button locally,
stamps versions, surfaces staleness, and leaves restarting to the human.

## Phase 1

### 1. Manifest: an optional update hint

`SubshellManifest` gains `update?: { command: string }`. No `docsUrl`: install's
is the docs link for the same program. The parser applies the identical
`needsPrivileges` refusal (a `sudo`/`doas`/`pkexec` word at any shell boundary
refuses the plugin at load), because this is the second manifest field a host
will RUN.

The pane-runtime adapter carries it as `updateHint` beside `installHint`, and
`GET /api/setup/harnesses` gains an optional `update?: string` on `HarnessInfo`,
absent (not null, not empty) when the plugin declares none, so a card can say
what it will run before it is pressed, and print the same text as a copy line
where it cannot run it.

Built-in plugins: `claude-code` declares `claude update`. `codex`, `opencode`,
`hermes`, and `pi` declare nothing, and their Update action re-runs their install
one-liner (vendor installers install the latest, so the fallback is an update).
`terminal` has no install and no update and keeps no button. The rule for what
runs is unchanged: it is fixed by this repo (and by installed plugin manifests),
never by anything a request sends; the request carries the plugin id and nothing
else.

### 2. Running the update: `local` only

A sibling route `POST /api/setup/agents/:pluginId/update` beside the install
route, sharing its shape: admin cookie session only (bearer refused), built-in
id allowlist, every 4xx decided before the NDJSON body opens, `{ type: "line" }`
streaming of installer output (each line ANSI-stripped at the source; blank
lines ride the wire and are dropped by the surfaces when rendering), one terminal
`{ type: "done", ok, exitCode, output, durationMs, harness }` with the harness
re-probed after the run. Single-flight is SHARED per plugin id across install and
update (one per-id registry naming the running kind): one person re-running an installer while an update
streams is the same race wearing different clothes.

`services/agent-install.service.ts` grows a `kind: "install" | "update"` axis.
The command chosen is `manifest.update?.command ?? manifest.install?.command`;
empty after the fallback refuses. Execution is unchanged: `sh -c`, `runBounded`,
env allowlist, 64 KiB per stream, 10-minute deadline, `ok = code === 0`. Audit:
`agent.update`, metadata identical in shape to `agent.install`.

No pane-safety refusal. Updating replaces bytes on disk; processes already
running keep their version until restarted. That is the premise of the feature,
not a hazard. The gate is `canManage` (`local` resolves it to admin), mirroring
Install's client mirror: a row offers Update when it is `installed`, is an
`agent-harness`, and has a non-empty chosen command.

Card behavior: on `local`, a ready row's action cell gets an Update button with
the sentence beneath it naming the exact command ("Runs `claude update` on this
machine, as the user the server runs as."). On an enrolled node the row gets the
copy line instead: "Run `claude update` on this machine. The server can't do it
on a node yet." Phase 2 turns that sentence into a button.

### 3. Version stamping

Migration: `subshells.harness_version` TEXT, nullable, registered in
`migrate.ts`. Meaning: the harness version the pane's current process started
on; null means unknown. Old rows stay null until their next restart; there is no
backfill.

Write sites, after a SUCCESSFUL launch only (a failed launch leaves null):

- `local` (create, restart, backoff revive): `probeVersion()` on the resolved
  path the launch used, run through the plugin's `parseVersion` exactly as a
  detect answer is, so a stamp and an inventory row are always the same kind of
  string. Exact.
- enrolled node: the version from the `nodes.inventory_json` entry used for the
  launch. That entry can be up to TTL old, so a pane launched right after a
  manual update on the node can be born with a stale-looking stamp. The fix is
  scoped: a successful remote launch kicks an unawaited detect pass (a new call
  site; today `resolveBinary` kicks one only when the snapshot was already
  stale), and when that answer lands the ONE pane that kicked it is re-stamped
  with the fresh version (guarded: same row, still `running`, same
  `startedAt`, so the kick cannot launder a genuinely old pane and cannot
  overwrite a restart's newer stamp).

The stamp follows the process: `restartSubshell` (manual or backoff) overwrites
it with the version the new process started on, which is what makes Restart the
remedy for staleness without any new restart machinery.

### 4. Staleness is server-derived

One derived fact where the subshell view is built:
`harnessStale = row.harnessVersion != null && currentVersion != null &&
row.harnessVersion != currentVersion`, where `currentVersion` is the node's
inventory entry for the pane's harness, compared as display strings (both sides
are the same `parseVersion` output, so equality is the whole rule; a version
nobody can compare is a version nobody can call stale). To make `local` readable
the same way, the periodic inventory-refresh pass also MAINTAINS a local
snapshot in `inventory_json` once per cycle. The node page keeps its live probe
and remains truth for that page; the snapshot only feeds the pane-side
comparison, and it lags by at most the cycle.

`SubshellView` gains `harnessVersion: string | null`,
`harnessCurrentVersion: string | null` and `harnessStale: boolean`; they ride
list, detail, and the MCP views. Additive fields on existing schemas only; no
new route module.

UI (web SPA in Phase 1): a stale running pane's card shows one `detail` line,
`Harness 2.1.283 · node now on 2.1.284`. No new control. The existing Restart,
which resumes, is the remedy, and a pane whose node has no version answer shows
nothing (two nulls are an absence, not a disagreement). Mobile and desktop pick
the fields up later; the data already rides.

### 5. Tests

- Manifest parser: `update` accepted, privileged spellings refused at load, wrong
  types refused; built-in manifests (claude declares, others don't, parse
  anyway).
- `agent-install.service` kind axis: update uses `update.command`, falls back to
  `install.command`, refuses when both are empty or the plugin is unknown or not
  built-in; single-flight shared across kinds.
- Update route: gate (cookie admin only, bearer 403), pre-stream refusals,
  NDJSON terminal shape, audit `agent.update`.
- Stamping: local exact stamp on create/restart; remote stamp from inventory;
  re-stamp lands only on the pane that kicked and only while its identity holds;
  failed launch leaves null; restart overwrites.
- Stale derivation: equal, differing, null stamp, null current, node gone.
- Local inventory snapshot maintained by the refresh pass.
- Web: `HarnessInfo.update` reaches the card; Update button on a local ready row,
  copy line on an enrolled node's ready row, neither on terminal, missing-binary
  rows still show Install; the stale `detail` line renders from the view field.

Focused files while building; `verify-types`, `lint:check`, `lint:prose`,
`test` at the boundary; `turbo build` for the `packages/` touch.

## Phase 2 (reserved, not built)

Named so Phase 1's seams do not have to be redesigned later:

- **Signed `harness_update` command**: protocol bump with the floor and agent
  version moves in one commit, an agent executor spawning through an
  allowlisted bounded child (the plane's `runBounded` discipline; the agent's
  own spawn conventions), progress via a tracker in the node-update mold
  (command results are single frames, not streams), loopback dashboard parity,
  and the enrolled-node copy line replaced by the button.
- **Exact at-spawn version**: the launch result (or a small event) carries the
  version the node probed at substitution time, retiring the inventory-derived
  stamp and its re-stamp dance on enrolled nodes.
- **Turn-end auto-restart**: an opt-in engine selecting `harnessStale` running
  rows whose `waitingSince` is set, restarting them through the existing
  service. Coverage note to solve there: hook-less harnesses on remote nodes
  have no turn-end signal today (the quiet watcher reads local logs only).

## Non-goals

- No "update available" detection: nothing asks vendors what the newest version
  is; staleness is relative to this node's own inventory, not the internet.
- No auto-update on a schedule; every update remains a human act in Phase 1.
- No plugin (Subshell-side package) updating here; that is Settings → Plugins
  already. This is the vendor CLI the plugin drives.
