# Node maintenance — design (2026-09-14)

> Amends spec 2026-08-31 (*Nodes*) §2 and §9: the control-plane host's launch
> switch is no longer "the presence of its Everyone/`edit` share row". Shares
> answer WHO may launch; this spec adds the flag that answers WHETHER anyone
> may, on every node rather than on one. The implementation order is §12.

## Context

A node owner today has no way to say "this machine stays enrolled, but runs no
subshells for a while." The only launch switch in the product is on the
control-plane host, and it is not a switch at all: it is the *removal of the
seeded Everyone/`edit` share row* on the `local` node, done by
`LocalLaunchCard` on that node's page. That mechanism cannot generalise —
an agent node's owner *is* the owner, and you cannot unshare someone from
their own machine — and it lives where nobody looked for it (the owner spent a
session hunting for it under Server Settings).

The use case that prompted this is **maintenance**: a machine that should keep
answering the plane (service control, logs, detection, restart, config) but
must not take new work, and whose current work should be stopped so the
operator can act. The person at the keyboard needs to be able to declare it
from the machine itself, and the owner needs to be able to declare it from a
browser, and both must mean the same thing.

Outcome: one word, **maintenance**, on every surface; one flag, settable from
either end and reconciled when they disagree; a node in maintenance is
visible everywhere, greyed in the picker with the reason, refuses launches on
both the plane and the machine, and entering it stops every running subshell
on that node after the person is told how many.

## 0. Decisions (fixed by the owner; not re-opened by implementation)

| # | Decision |
|---|---|
| 1 | In maintenance **nobody** launches on the node — owner, admins, grantees. `local` has the identical meaning. |
| 2 | Entering maintenance **terminates every running subshell on the node, all owners'**, after a confirmation that names only the **total count**. Rows stay `terminated` (restartable once maintenance ends). Opted-in auto-restart rows do **not** revive by themselves afterwards. |
| 3 | Plane-side permission: **owner only; admin for `local`** — `nodeCanManageFor`, the delete/shares gate. Admins cannot flip a node they do not own. |
| 4 | A node in maintenance **still answers every other command**: service, logs, re-check/detect, restart, config. Only `launch` is refused. |
| 5 | **One state, settable from either end.** The plane is the record; the node keeps a mirror. On disagreement the **newer `changedAt` wins** and the loser is updated. Clock skew is accepted and stated. |
| 6 | Node CLI: **`subshell maintenance on\|off\|status`**. `on` lists what it would stop and **refuses with exit 1 unless `--yes`** (this CLI has no interactive prompts; `run()` is pure — this is `service restart --force`'s shape). |
| 7 | The word is **`maintenance` everywhere**: badge, menu, card, CLI, audit action, column, docs. Never "disabled" (reads as unenrolled/off) and never a second spelling. |
| 8 | The launch picker **shows a node in maintenance greyed, labelled `(maintenance)`** — like `(offline)` — rather than hiding it. |
| 9 | Owners of terminated subshells **get a push**: new `NotifyKind` `"maintenance"`, body "Stopped for node maintenance". |

## 1. What exists today (measured)

**The gate.** `nodeCanLaunchOn(kind, access, granted)` — `apps/server/api/src/lib/node-access.ts:72`. Three production callers: `api/nodes/node-view.ts:282` (`canLaunch`), `services/subshells.service.ts:143` and `:165` (`resolveLaunchNode` explicit node and implicit `local`). **Two launch paths bypass it**: step-3 single-online-agent auto-pick (`subshells.service.ts:167–168`, filters only `kind === "agent" && getLive`) and manual `restartSubshell` (`:575–587`, re-checks nothing about the node). The auto-restart sweep (`subshell-manager.service.ts:806–855`) defers on `isNodeOffline` and `harnessUsable` only.

**`local`'s switch is share surgery.** `LocalLaunchCard` (`apps/server/web/src/components/nodes/local-launch-card.tsx`) PUTs the whole share set; `seed-local.ts:51–79` seeds Everyone/`edit` only when creating the row. The share row is also `local`'s **visibility** filter (`findAccessible`). `docs/security.md:594–617` and `.claude/rules/security-context.md:403–415` describe this and promise "no separate flag".

**Termination exists and is complete.** `SubshellManagerService.terminateSubshell(userId, id)` (`subshell-manager.service.ts:693–721`): kills via the row's launcher (`RemoteLauncher.killSubshell` → `kill` command, swallows already-gone), tolerates an offline node (`killUnverified`, row retired anyway), `markTerminated`, revokes the subshell token, audits. **Deliberately silent** — `#notifyDeath` fires only from `#applyDeath` (`:977–979`). The ownership guard `row.userId !== userId → return` means a node-wide stop must pass each row's **own** `userId`. There is no `listRunningForNode`; `NodesRepository.countRunningSubshells(nodeId)` (`nodes.repository.ts:197`) exists and counts parked `running/alive:0` rows too.

**Push + reconcile template.** `pushAllowedDirsBestEffort` + `services/nodes/allowed-dirs-sync.ts`, re-run from the `ready` handler (`node-ws-handler.ts:328`). Plane-wins, one-way.

**Agent facts.** No IPC to the running daemon; `config.json` is snapshotted at boot; the one machine-local setting the daemon honours live is `allowed-dirs.json`, read on every `launch` (fail-open, atomic temp+rename 0600 — `allowed-dirs.ts:73–86`). Exit watcher: one 2 s tick (`commands/report.ts:128–187`), `reportDeath` (`:199–215`) sends `exit` then forgets the meta. Heartbeat 15 s (`daemon.ts:645`). `ready` is built by `readyEvent` (`daemon.ts:242–281`). `SubshellMetaStore.list()` (`subshell-meta.ts:206`) + `tmux.hasSubshell` is the daemon-free "what is alive here" join (`buildSubshellsReport`, `report.ts:251`). Refusals are `{ ok:false, error }`; the plane compares `NodeRpcError.detail` **by equality** to constants in `node-frames.ts`. `NODE_PROTOCOL_VERSION = 7`, matched exactly both ways.

**A node refusal on launch is a 500 today.** `RemoteLauncher.launch` rethrows `NodeRpcError("failed")` (`remote-launcher.ts:302–309`); `SubshellsService` maps only offline (`rethrowUnlessNodeOffline`, `subshells.service.ts:65–74`); the global handler 500s anything without `.status`.

**SPA.** Picker filters `canLaunch === false` (`new-subshell-form.tsx:70–72`, a stated decision); `(offline)` grey comes from `lib/node-label.ts nodeOptionLabel`; `NoLaunchTargets` is `local`-shaped (`no-launch-targets.tsx`). `ActionsMenu` items: `{label, icon, onSelect, destructive, disabled}`. `confirmAction({title, description, confirmLabel, danger})` in `lib/confirm.ts`. `NotifyKind` is exhaustive (`notify.service.ts:31`); no toast machinery exists. `useNode` polls at 5 s.

## 2. The model: one word, one flag, two axes

**Maintenance is a property of the node, not of its shares.** Shares keep answering *who* may launch (any share grants launch; on `local` the Everyone row also governs visibility, and an admin may still narrow it to named people). Maintenance answers *whether anyone* may launch. The two compose by AND. This is the one judgment call not put to the owner: the alternative — make the Everyone/`edit` row on `local` invariant and retire the `node_launch_disabled` 403 — removes a real capability (a host shared with named people only) to remove a code path, and the "one word names one thing" rule is satisfied already: `maintenance` is the only thing called maintenance, and shares are never called a switch again.

Consequences:
- `LocalLaunchCard` is **deleted**. Its replacement, `NodeMaintenanceCard`, writes the flag and never touches shares.
- The existing `local` granted-access rule in `nodeCanLaunchOn` **stays** (it is what makes a narrowed host apply to admins). Its 403 message is reworded to say what is now true: "No one is granted launch access on {name}. Share it with Everyone or with specific people to allow launching."
- The migration **adds columns only**; it does not reinterpret a removed Everyone row.

**Columns** (`nodes`): `maintenance INTEGER NOT NULL DEFAULT 0`, `maintenance_at TEXT NULL`, `maintenance_source TEXT NULL` (`'plane' | 'node'`; `MaintenanceSource` union + `MAINTENANCE_SOURCES` runtime array per code-style). Default 0 so every node keeps launching on upgrade.

**Mirror** (`<dataDir>/maintenance.json` on the node): `{ "on": boolean, "changedAt": ISO }`. Absent ⇒ off. Written atomically, 0600, like `allowed-dirs.json`. **Read fail-CLOSED for the launch gate**: an unreadable or corrupt file means "in maintenance" — the opposite of allowed-dirs' fail-open, because a refusal that fails open is not a refusal; `status` says so when it happens.

## 3. What travels: protocol 8

`NODE_PROTOCOL_VERSION` 7 → **8**, `MIN_AGENT_VERSION` → `0.6.0`, `apps/node/agent/package.json` hand-raised to `0.6.0` (the rule in `versions.ts:43–53`). No users ⇒ no compatibility shim; a protocol-7 agent is closed with `NODE_CLOSE_UPDATE_REQUIRED` as today.

| frame | direction | shape | notes |
|---|---|---|---|
| `ready.maintenance?` | node → plane | `{ on, changedAt }` | **lenient** parse like `runtime`: malformed ⇒ field dropped, `ready` kept. Absent ⇒ node has no file. |
| `maintenance` event | node → plane | `{ on, changedAt }` | strict. Sent when the file changed since last report (see §4.3) and on a launch refusal. |
| `set_maintenance` command | plane → node | `{ on, changedAt }` | node writes the file with **these exact bytes** (so both sides hold identical stamps). Does not kill panes. |
| `NODE_RESULT_MAINTENANCE` | constant | `"in maintenance"` | the bare `error` string on a refused `launch`; compared by equality. |

`packages/backend-errors`: `NODE_IN_MAINTENANCE`, 409, "Node is in maintenance".

## 4. The agent

### 4.1 `src/maintenance.ts`
`readMaintenance(dataDir): { on, changedAt } | undefined` (undefined = no file; corrupt/unreadable ⇒ `{ on: true, changedAt: undefined, unreadable: true }` for the gate and a warn line), `writeMaintenance(dataDir, state)` (temp+rename, 0600, 0700 parent). Header comment states the fail-closed choice and why it differs from `allowed-dirs.ts`.

### 4.2 The gate in `execLaunch`
Before the allowlist check (`commands/launch.ts:55`): if `readMaintenance(ctx.config.dataDir)?.on` → `ctx.ws.send({ type: "maintenance", on: true, changedAt })` **then** `return { ok: false, error: NODE_RESULT_MAINTENANCE }`. Bare constant, no suffix. The event makes the plane converge from a refusal without the plane ever writing a stamp it did not receive.

### 4.3 Reporting order — the deterministic fix
`maybeReportMaintenance(ctx)`: re-read the file; if it differs from `ctx.lastReportedMaintenance` (new field on `CommandContext`), send the `maintenance` event and update the memo. Called from **three** places: (a) inside `reportDeath` **before** `ctx.ws.send({ type: "exit" … })`; (b) every heartbeat tick (the belt for a flip with no running panes); (c) `readyEvent` includes the file state directly. Because the plane serialises frames per socket (`handleNodeMessageQueued`), (a) guarantees the plane has written the flag before it processes the first death — so no `crashed` push, no respawn attempt, no token churn.

### 4.4 `set_maintenance` handler
`commands/set-maintenance.ts`: `writeMaintenance(dataDir, { on, changedAt })`, set the memo to the written value (so the next tick does not echo it back), `{ ok: true }`. Never kills — the plane already terminated.

### 4.5 CLI — `subshell maintenance on|off|status`
Parser tables in `cli.ts`: `COMMANDS += maintenance`; `SUBCOMMANDS.maintenance = ["on","off","status"]`; `SUBCOMMAND_FLAGS.maintenance = { on: ["--yes","--json"], off: ["--json"], status: ["--json"] }`; `FLAGS["--yes"] = false`; `COMMAND_FLAGS.maintenance = subcommandFlagUnion("maintenance")`; USAGE lines. `RunDeps` gains `tmux`/`meta` seams (like `service`) so `cli.test.ts` stubs them.

- `on`: `loadConfig()` (dataDir); `meta.list()` × `tmux.hasSubshell` → the alive set. Without `--yes` and alive.length > 0: print each `name · id · cwd` and `refusing: N running subshells on this node would be stopped; pass --yes`, exit 1, **write nothing**. With `--yes` (or nothing alive): `writeMaintenance({ on: true, changedAt: now })` **first**, then `tmux.killSubshell(m.socket, m.subshellId)` per alive row. **Never forget meta records** — with no daemon running they are the only thing the reconnect census can report. Output: `maintenance on — stopped N subshells`; `--json`: `{ on, changedAt, stopped: [ids] }`.
- `off`: write `{ on: false, changedAt: now }`. If the daemon is running it reports within one heartbeat; the human line says so: "the control plane learns of this within about 15 seconds while the agent runs, or when it next connects".
- `status`: the file's state (`on/off`, `since`, or `no maintenance file — off`; `unreadable — treated as on`); `--json`.

## 5. The plane

### 5.1 The gate
`nodeCanLaunchOn(kind, access, granted, maintenance: boolean)` — a fourth argument ANDed in, so every caller fails to compile until it passes the row's flag. Add the check explicitly to the two bypass paths: step-3 auto-pick filters `!n.maintenance`; `SubshellsService.restartSubshell` loads the row's node and refuses 409 before calling the manager (on `local` this is the **only** gate — there is no node-side one). Belt in `maybeAutoRestart` beside `harnessUsable`: defer while the node is in maintenance.

Refusal order in `resolveLaunchNode.gate`: 404 invisible → **409 `NODE_IN_MAINTENANCE`** → 403 `node_launch_disabled` (`local` narrowed by shares) → 409 offline. Maintenance before offline so an offline node in maintenance says the actionable thing.

**Refusal mapping.** Extend `rethrowUnlessNodeOffline` into `rethrowLaunchRefusal`: `NodeRpcError && code === "failed" && detail === NODE_RESULT_MAINTENANCE` → `throwApiError({ code: NODE_IN_MAINTENANCE, doNotLog: true })`. Applied on create and restart.

**Create race on `local`.** `manager.createSubshell` creates the row `running` then spawns with no post-spawn check (unlike `#reviveRow`'s `updateIfRunning`). Add: after spawn, re-read; if `status !== "running"` kill the pane and throw. Otherwise a PUT landing between row-create and spawn leaves a live pane under a `terminated` row nothing sweeps.

### 5.2 `services/nodes/maintenance.ts` — the one module that does the act
- `decideMaintenance(row, reported)` — **pure**: `"adopt-node" | "push-plane" | "noop"`. Table: node absent + row NULL → noop; node absent + row set → push; node present + row NULL → adopt; both present: node newer → adopt, plane newer → push, **equal → noop** (tie goes to the record of truth; a differing `on` on equal stamps is pathological and the push after reconcile realigns it). When adopting, store `min(nodeStamp, now)` — a future-dated node clock cannot outrank later plane flips forever, because the file is then rewritten with the clamped stamp.
- `setNodeMaintenance({ nodeId, on, changedAt, source, actorUserId }): Promise<{ stopped: string[] }>` — writes the row **first** (a concurrent PUT then finds nothing to stop), then if `on`: `listRunningForNode(nodeId)` (new, `status = 'running'`, full rows) → for each row the `terminateSubshell` steps with the row's own `userId` **plus** `#notify(row.id, "maintenance")` — implemented as a manager method `terminateForMaintenance(row)` beside `terminateSubshell` (which stays silent for the operator-clicked case). Then `pushSetMaintenanceBestEffort(nodeId)` (skip `local`; template `allowed-dirs-sync.ts`) with the row's stored stamp so both files match byte-for-byte. Then audit `node.maintenance.update` `{ on, source, stopped: [ids], changedAt }` (actor null when `source === 'node'`). Uses a `SubshellManagerService` built from `getRequestlessContext().repos` — the `restartInFlight` lease is module-global, so any instance is safe. Static imports only; import the manager directly, not via `SubshellsService` (known cycle).
- After every reconcile that adopts or pushes, the push runs — the two files end identical.

### 5.3 Hooks, not repo picks
Add `onMaintenance(nodeId, reported: {on, changedAt} | undefined)` to `NodeLifecycleHooks` (`node-events.ts:77–85`), installed in `index.ts` beside the others. `ready` calls it with `event.maintenance` (it must **write the row before returning**; the terminate loop is `void`ed so N × 10 s `kill` round-trips do not stall the socket's frame queue — loop and census are idempotent on the same rows). The `maintenance` event calls the same hook. `NodeWsNodesRepo`'s `Pick` is untouched, so the ws-handler test fakes survive.

### 5.4 Route
`PUT /api/nodes/:id/maintenance { on: boolean }` — `set-node-maintenance.route.ts`, template `set-node-allowed-dirs.route.ts`. `requireCookieActor`; `loadNodeGate` → 404; `gate.canManage` → 403; call `setNodeMaintenance({ …, source: 'plane', changedAt: now, actorUserId })`; return `toNodeView`. Works on an offline node (flag set, rows retired `killUnverified`, reconnect census kills survivors, `ready` reconcile pushes the file). Every `t.*` property carries a `description`.

### 5.5 Views
`NodeViewSchema` (list + detail) gains `maintenance: boolean`, `maintenanceAt: string|null`, `maintenanceSource: 'plane'|'node'|null` — the list needs the boolean because `canLaunch: false` alone cannot tell maintenance from a share-narrowed host. `GetNodeResponseSchema` gains `runningSubshells?: number`, populated when **`gate.canManage`** (not `nodeCanConfigure`, which gates `shares` — only a manager can flip, so only a manager learns the count).

### 5.6 Notifications
`NotifyKind += "maintenance"`, `BODY.maintenance = "Stopped for node maintenance"`. Excluded from the `/attention` route's body union like `crashed_final`. Owner-targeted like every push, honouring the master switch and the per-subshell bell. Because §4.3 puts the flag ahead of the deaths, a CLI-origin stop also reaches owners as `maintenance`, not `exited`/`crashed`; the residual case (a death report that outruns the file write inside one 2 s tick) is stated in the security doc as bounded.

## 6. The SPA

- **`types/node.ts`**: `maintenance`, `maintenanceAt`, `maintenanceSource` on `Node`; `runningSubshells?` on `NodeDetail`.
- **`hooks/use-nodes.ts`**: `useSetNodeMaintenance(id)` — PUT, invalidates `NODES_QUERY_KEY`, `[...NODE_QUERY_KEY, id]` **and `SUBSHELLS_QUERY_KEY`** (as `useRotateNodeKey` does — this mutation changes subshell rows).
- **Node row** (`node-row.tsx`): badge `maintenance` (`variant="warning"`) in the chip column after status — a warning never hides behind "+N more". Menu item after Share: `{ label: on ? "End maintenance" : "Start maintenance…", icon: Wrench, onSelect, disabled: !node.canManage, destructive: !on }`.
- **Confirm** (`lib/subshell-confirmations.ts` house style — title is the question with the name, description the one-sentence consequence): title `Start maintenance on "{name}"?`; description `{N} subshell(s) running here will be stopped and their owners notified. Nobody can launch here until maintenance ends. Everything else about the node keeps working.` (N from `runningSubshells`; when 0: `Nothing is running here. Nobody can launch here until maintenance ends.`). `confirmLabel: "Start maintenance"`, `danger: true`. Word it "N subshells", not "N running" — parked rows count. `local` adds one clause: `This applies to admins too.`
- **`NodeMaintenanceCard`** (`components/nodes/node-maintenance-card.tsx`, replaces `local-launch-card.tsx` and its test) on the Overview for **every** kind (`local` has only an Overview). Title "Maintenance"; a Switch (aria-label `Maintenance on {name}`); label `In maintenance since {relative} · set {from this page | at the node}` / `Accepting subshells`; the same confirm on turning on; description says what maintenance means, that stopped subshells stay in the list and can be restarted after, that opted-in auto-restart does **not** bring them back by itself, and that `subshell maintenance on|off` at the node does the same thing. Hidden for non-managers (`canManage`), like today.
- **Picker**: `nodeOptionLabel` appends ` (maintenance)` when `node.maintenance` (last segment, like `(offline)`); `isSelectable` false for maintenance; `launchableNodes` keeps a maintenance node **visible** (filter becomes `canLaunch !== false || maintenance`) so the share-narrowed host still vanishes as designed; `hideMachineField` counts selectable nodes only, so a host in maintenance as the sole node shows the disabled field rather than hiding it under a failing form. Dead-end hint when nothing is selectable: `{name} is in maintenance.` / `Every node is in maintenance or offline.`
- **`NoLaunchTargets`** takes the node list (not `local` alone). Per unlaunchable node a sentence and, for a manager, a button `End maintenance on {name}` (through `leaveFor`, closing the dialog — the earlier fix). Non-manager: `{name} is in maintenance; its owner can end it` (admin for the host). The share-narrowed host keeps its existing sentence, reworded per §2.
- **`lib/create-subshell-error.ts`**: branch `NODE_IN_MAINTENANCE` → `That node is in maintenance. Pick another node, or end maintenance from its node page.` Amend the docblock's "never promise a 403" note (this is a 409, and the 403 remains unpromised).
- Mobile `node-pick.ts` drops `canLaunch === false` rows and gets no reason text — noted, not changed.

## 7. Refusals and errors — one table

| where | condition | answer |
|---|---|---|
| `POST /api/subshells`, `POST …/restart` | node row `maintenance = 1` | 409 `NODE_IN_MAINTENANCE` |
| same | node refused `launch` with `"in maintenance"` (window before the plane learned) | mapped to 409 `NODE_IN_MAINTENANCE`; node's event converges the row |
| same | `local` with no launch grant for this viewer | 403 `node_launch_disabled` (reworded, §2) |
| `PUT /api/nodes/:id/maintenance` | not cookie | 403 |
| same | not `canManage` | 403 (admin on a foreign agent node included) |
| same | unknown/invisible node | 404 |
| same | node offline | **200** — flag set, rows retired `killUnverified`, push deferred to `ready` |
| CLI `maintenance on` | alive panes and no `--yes` | exit 1, list printed, nothing written |
| CLI any | no config | existing "Enroll this node first" |
| agent `launch` | file says on / unreadable | `{ ok:false, error: "in maintenance" }` + `maintenance` event |

## 8. Migration `0031-node-maintenance`
Adds the three columns (`maintenance` default 0). `down` drops them. Registered in `migrate.ts`'s static map. Boot order `runMigrations()` → `ensureLocalNode()` is unaffected; `NodesRepository.create()` mirrors the new defaults.

## 9. Security accounting (what the docs must say)
- Maintenance is a **new owner-only act with a blast radius beyond the owner**: it terminates subshells the node owner cannot see (any node share lets a grantee launch there; those subshells are private to them). The owner learns only a count; the grantee learns by push. This is sound on the trusted-network posture because whoever owns the node's OS user already owns every pane on it — and it is a real change from today, where nothing an owner did stopped a grantee's work. Contrast with `allow_node_enrollment`, which bounds only the future: maintenance is deliberately retroactive.
- **The plane can end a maintenance window the operator started at the machine** (decision 5: one state, either end). State it plainly; the alternative (machine wins) was offered and declined.
- **The node enforces independently** (fail-closed file read per launch), so a plane that believes maintenance is off still cannot launch there; convergence comes from the node's own event. This is defence in depth, not a second switch.
- **Symmetrically, a node can end a window the PLANE declared**, and that half
  is the one worth stating: a machine chooses its own `changedAt`, so a
  compromised one can always present a winning stamp and clear the flag at
  will. This costs nothing, and the reason it costs nothing is the boundary to
  keep in view — an attacker who can send that frame holds the node key, which
  means they are the local OS user on that machine and already own every pane
  the plane launches there, its files, and the bearer token in each pane's
  argv. **Maintenance is a routing preference, not a quarantine**: decision 4
  keeps every other command answering, so it was never a containment control
  and must not be described as one. The levers that actually contain a suspect
  machine — deleting the node, rotating or disabling its key, clearing its
  shares — are cookie-gated and a node key reaches none of them.
- Clock skew: newer-stamp reconciliation with plane-wins ties and clamped
  future stamps. A skewed but honest machine can flip the plane once per
  reconnect and never permanently; a machine that lies about its clock
  deliberately is the case above, and is bounded by what a node key already
  holds rather than by the stamp rule.
- `ready` discloses one more fact (`maintenance`) to the plane; add it to the `ready` disclosure list in `docs/security.md` §"(protocol 8)".
- The "no separate flag exists" sentences (`docs/security.md:598`, `security-context.md:408`, spec 2026-08-31 L31/L676) become false and are rewritten: shares = who, maintenance = whether.
- Audit: `node.maintenance.update` from both origins (actor null for `node`), `stopped` ids in metadata; each stopped subshell also carries its own `subshell.terminate` row.

## 10. Tests (write first, per step)
- **Protocol**: version pin → 8; `set_maintenance` parse ok/reject; `maintenance` event parse; `ready` with malformed `maintenance` keeps the ready, drops the field. `version-floor.test.ts` green at 0.6.0.
- **Agent**: `maintenance.test.ts` (round-trip, 0600, atomic, unreadable ⇒ on); `commands-maintenance.test.ts` (`set_maintenance` persists and sets the memo; `launch` refused with the bare constant before tmux is touched and emits exactly one `maintenance` event); `report` test: file flip → `maintenance` event precedes `exit` in the same tick; `daemon.test.ts`: `ready` carries the file state, heartbeat tick reports a flip; `cli.test.ts`: `on` lists and exits 1 without `--yes`, with `--yes` writes then kills each alive pane and leaves meta files, `off`, `status --json`, usage errors for bad subcommands/flags.
- **Plane**: migration test (columns, defaults; `create()` mirrors); `node-access.test.ts` (4th arg ANDs on both kinds); `decideMaintenance` table incl. equality/absence/clamping; `setNodeMaintenance` (terminates rows of two owners with their own ids, notifies `maintenance` per row, `killUnverified` offline, idempotent second run, audit shape, push skipped for `local`); `resolve-launch-node` (explicit maintenance node → 409 for owner **and** admin; `local` in maintenance skips step 2; step 3 excludes maintenance rows; refusal order); manager: fake launcher throwing `NodeRpcError("failed", …, "in maintenance")` → create/restart answer 409 not 500; auto-restart deferred; `restartSubshell` on `local` in maintenance → 409; create-race post-spawn check; ws-handler: `ready` with/without `maintenance` calls the hook, `maintenance` event calls the hook; route: owner 200 + rows terminated across owners + audit, `edit` 403, admin-on-local 200, admin-on-foreign-agent 403, bearer 403, unknown 404, offline 200, `on` twice idempotent, view carries the flag, `runningSubshells` for manager only; `subshells-local-launch-off.test.ts` re-based on the reworded 403.
- **SPA**: `node-row.test.tsx` (badge; menu item disabled for non-manager; label flips); `node-maintenance-card.test.tsx` (confirm names the count; PUT body; hidden for non-manager; source/since line); `create-subshell-error.test.ts`; `nodeOptionLabel` suffix; `launchableNodes`/`hideMachineField`/`isSelectable` with a maintenance node; `no-launch-targets.test.tsx` and `new-subshell-form.test.tsx:787–806` rewritten for the new copy (both buttons close first).
- **e2e**: extend `12-nodes` (already a 300 s real-agent flow): `PUT …/maintenance {on:true}` while a subshell runs → row `terminated`, agent's `maintenance.json` on, `POST /api/subshells` → 409; `{on:false}` → launch succeeds; then the reverse via `stub/client.ts` running `maintenance on --yes` → plane row flips within a heartbeat. `16-server-service.spec.ts:231` asserts `/nodes/local` has no text exactly `"Runtime"` — the card must not use that word standalone. No existing spec pins "Launch on the server" / "No machine can run a subshell" / "Enable on Server".

## 11. Docs and changesets
`docs/security.md` (§ launch-target rewrite at L594–617; protocol heading + `ready` list at L434; §9 accounting), `.claude/rules/security-context.md` L403–415 (same content, summary form), `docs/node-protocol.md` (§3 "currently 8", §5/§6 new frames, §11 history 7→8), `docs/superpowers/specs/2026-08-31-nodes-design.md` L31 and L676 "amended by 2026-09-14", `apps/server/api/AGENTS.md` (node surface table + refusal→code list), `apps/node/agent/AGENTS.md` (CLI verb, `maintenance.json`, fail-closed, reporting order), `apps/server/web/AGENTS.md` (launch-form paragraph: greyed-with-reason for maintenance, hidden for the share-narrowed host). Changesets: `@internal/server` **minor** (routes + SPA + notification), `@internal/node` **patch** (the hand-raise to 0.6.0 carries the CLI verb; write the changeset as user-facing prose, old behaviour first).

## 12. Implementation order (TDD; Opus subagents in one worktree, ≤3 concurrent)
1. **Protocol + shared constants** — `node-frames.ts` (version 8, constant, three frames, lenient `ready` field), `versions.ts` floor, agent `package.json` 0.6.0, `backend-errors` code. Green: root `bun run verify-types`.
2. **Agent** (parallel with 3) — `src/maintenance.ts`, `commands/launch.ts` gate, `commands/set-maintenance.ts` + dispatcher case, `commands/report.ts` (`maybeReportMaintenance` before `exit`), `daemon.ts` (ready + heartbeat), `commands/context.ts` memo, `cli.ts` tables + verb + `RunDeps` seams, `apps/node/agent/AGENTS.md`. Green: `cd apps/node/agent && bun test && bun run verify-types`.
3. **Plane core** (parallel with 2) — migration + `migrate.ts` + `nodes.db-types.ts` + repo (`setMaintenance`, `listRunningForNode`, `create()` defaults), `node-access.ts`, `subshells.service.ts` (call sites, step 3, restart check, refusal mapper, order), `subshell-manager.service.ts` (`terminateForMaintenance`, sweep guard, create post-spawn check — one guard line each, the file is 1596 lines), `notify.service.ts` kind, `services/nodes/maintenance.ts`, `node-events.ts` hook, `node-ws-handler.ts` two hook calls, `index.ts` install. Green: `cd apps/server/api && bun run test && bun run verify-types`.
4. **Plane routes + views** (after 3) — `set-node-maintenance.route.ts`, `api/nodes/index.ts`, `node-view.ts`, `get-node.route.ts` count. Green: as 3.
5. **SPA** (parallel with 4 once 3 fixes the view shape as a type) — §6 files; delete `local-launch-card.tsx` + test. Green: `cd apps/server/web && bun test && bun run verify-types`, root `bun run lint:design`.
6. **Docs + changesets + e2e** (parallel with 5) — §10 e2e, §11 docs.

## 13. Verification
Root: `bun run verify-types && bun run lint:check && bun run test && bun run lint:design` (no Rust touched; `lint:licenses` unaffected — the agent imports no server code). Then `bun run test:e2e` for `12-nodes` and `16-server-service`. Manual on `e2e/stack.ts` (never `:3080`): kill the daemon, `subshell maintenance on --yes`, restart it → rows retire on census with `maintenance` pushes; flip the plane on while the node is offline, CLI off, reconnect → plane reads off, rows `terminated`, exactly one `node.maintenance.update` per flip; picker shows the node greyed `(maintenance)`; `12-nodes`'s row locator still finds `online` beside the new badge.

## 14. Execution notes

- **Branch first.** The working tree is on `main`; implementation starts with
  `feat/node-maintenance`. Commits are per step of §12 (six or seven), each one
  green on that step's own package commands before the next begins. Nothing is
  pushed unless asked.
- **This document lands before any code**, so the "amended by" pointers §11
  adds to the 2026-08-31 spec have a target to point at.
- **Who runs what.** Steps 2, 3 and the 5/6 pair are delegated to Opus
  subagents (≤3 concurrent, the standing rule); step 1 and step 4 are small and
  sequential and run here. Each subagent gets this spec's relevant section plus
  its test list, and must land its own tests first.
- **Two things every step must re-check rather than assume**: that the frame
  ordering in §4.3 still holds after any change to `report.ts`, and that no new
  Apache→AGPL value import appeared (`bun run lint:licenses`).

## 15. Out of scope (named so nobody infers them)
- `subshell-server maintenance …` — `local` is flipped from the UI only.
- A "drain" mode (block new, keep running) — decision 2 chose the cut.
- Making the Everyone row on `local` invariant / retiring the 403 path — §2.
- A machine-wins rule or env override (`SUBSHELL_MAINTENANCE=1`) — decision 5 chose one state; an env override would make the plane's write refuse, which is the declined alternative.
- Reason text on the mobile picker.
- Cleaning dead meta files the CLI leaves for the census — existing behaviour after any agent restart.
