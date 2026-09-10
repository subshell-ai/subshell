# Phase 2b: `local` Is a Node Like Any Other

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The control-plane host gets its own plugins directory and is installed to and uninstalled from through the same path as every agent, so the `enabled` concept can be deleted outright.

**Architecture:** `effectiveHarnessStates` is currently two functions sharing a name: for an agent it derives every row from the node's declared set and hardcodes `enabled: true`, and for `local` it reads the `harness_plugins` table crossed with each plugin's `enabledByDefault`. This collapses both to one path over (declared set × binary probe), differing only in where each half comes from. `local`'s declared set becomes `<SUBSHELL_SERVER_DATA_DIR>/plugins/`, read by the same code the agent uses, which moves into `@internal/pane-runtime`.

**Tech Stack:** Bun, TypeScript, ElysiaJS + TypeBox, Kysely/SQLite, React 19 + TanStack.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-architecture-design.md` (§11 "the control-plane host is a node like any other", §12 deletions, §15 phase 2b, §16 phase 2 testing).

## Why this is phase 2 finished, not a new phase

The spec always said this. §11: the control-plane host "is a node like any other and loads plugins through the same `@internal/pane-runtime`". §12 lists `harness_plugins` and `PATCH /api/setup/harnesses/:id` among the deletions. §16's phase 2 test list asks that "`local` and agent paths produce the same report shape".

Phase 2 as merged refuses `local` with a 400 (`assertAgent` in `services/nodes/plugin-sync.ts`) and leaves the enable table standing. That test therefore does not pass and could not have been written. The deferral was recorded in a docstring as though it were a phase boundary; it was not one.

It runs BEFORE phase 3 because phase 3 writes the npm install path. Against today's split that path gets written for agents and then extended to `local`; against a model where every host has a plugins directory it is written once.

## Global Constraints

- **Empty means "offers nothing"**, and seeding keys on the plugins directory NOT EXISTING, never on it being empty. Keying on empty would undo an uninstall on every restart. This applies to the server's directory exactly as it does to an agent's.
- **No migration reads the retired tables.** Nothing is deployed (confirmed 2026-09-09), so `harness_plugins` is dropped without being read. The spec's original one-way seeding step is deleted rather than implemented.
- **The licence boundary is `apps/server/**` = AGPL, everything else Apache-2.0.** Moving `plugins-dir.ts` and friends from `apps/node/agent/src/` to `packages/pane-runtime/src/` is Apache to Apache, so it is licence-neutral. Do not move anything from `apps/server/` into a package as part of this.
- **`local` is an id, never a label.** Nothing rendered may derive from it; the UI reads `node.name`.
- **No em dashes in product copy.**
- Pinned dependency versions, no `^`/`~`.

## File Structure

**Moved (Apache to Apache, no behaviour change):**

| from | to |
|---|---|
| `apps/node/agent/src/plugins-dir.ts` | `packages/pane-runtime/src/plugins-dir.ts` |
| `apps/node/agent/src/plugin-report.ts` | `packages/pane-runtime/src/plugin-report.ts` |
| `apps/node/agent/src/plugins-seed.ts` | `packages/pane-runtime/src/plugins-seed.ts` |
| `apps/node/agent/src/fs-mode.ts` | `packages/pane-runtime/src/fs-mode.ts` |
| their `__tests__/` | alongside |

The agent's LogLayer `logger` does not move with them. `packages/pane-runtime/src/registry.ts` already reports a broken built-in with `console.warn`, and that is the package's convention; follow it rather than adding a DI seam with one real consumer. The agent loses its `[subshell <ISO>]` prefix on those few lines, which is the cost and is worth naming in the commit.

**Modified:**

- `apps/server/api/src/services/nodes/plugin-sync.ts` — branch on kind instead of refusing `local`
- `apps/server/api/src/services/nodes/inventory.ts` — one path, `enabled` gone
- `apps/server/api/src/api/harness-utils.ts` — the launch gate reads the declared set
- `apps/server/api/src/services/default-profiles.ts` — same
- `apps/server/api/src/api/setup.route.ts` — the toggle becomes install/uninstall
- `apps/server/api/src/api/nodes/node-view.ts` — drop `enabled`
- `apps/server/web/src/{types/node.ts,types/harness.ts,hooks/use-harnesses.ts,components/nodes/node-row.tsx}`
- `docs/architecture.md`, `docs/node-protocol.md`

**Deleted:**

- `apps/server/api/src/db/repositories/harness-plugins.repository.ts`
- the `harnessPlugins` entry in `db/types/index.ts`
- `toggleLocalHarness` in `harness-utils.ts`
- `useSetHarnessEnabled` and `harnessToggleErrorMessage` in `use-harnesses.ts`
- `enabledByDefault` from `packages/pane-runtime/src/types.ts` and `plugin-adapter.ts`

**Created:**

- `apps/server/api/src/services/nodes/local-plugins.ts` — the server's own plugins directory: seed, recover, report, install, uninstall
- `apps/server/api/src/db/migrations/0025-drop-harness-plugins.ts`

---

### Task 1: Move the plugin-directory modules into `pane-runtime`

Pure move. No behaviour change, so the existing tests must pass unmodified apart from import paths.

**Files:**
- Move: the four modules and their tests per the table above
- Modify: `packages/pane-runtime/src/index.ts` (export them), `apps/node/agent/src/{daemon,inventory,commands/basics}.ts` (import from `@internal/pane-runtime`)

**Interfaces produced:** `pluginsDir`, `listInstalled`, `installEmbedded`, `uninstallPlugin`, `refreshStaleBuiltIns`, `recoverInterruptedInstalls`, `seedBuiltIns`, `buildPluginReports`, `InstalledPlugin`, `RecoveredInstalls` — all from `@internal/pane-runtime`, all with today's signatures.

- [ ] **Step 1: Move the files with `git mv`** so history follows them.

```bash
cd /home/theo/projects/subshell
for f in plugins-dir plugin-report plugins-seed fs-mode; do
  git mv apps/node/agent/src/$f.ts packages/pane-runtime/src/$f.ts
done
git mv apps/node/agent/src/__tests__/plugins-dir.test.ts packages/pane-runtime/src/__tests__/plugins-dir.test.ts
git mv apps/node/agent/src/__tests__/plugins-seed.test.ts packages/pane-runtime/src/__tests__/plugins-seed.test.ts
```

`plugin-commands.test.ts` stays with the agent: it tests `execPluginInstall`, which is a command handler, not a directory operation.

- [ ] **Step 2: Replace the agent logger with the package convention.**

In `plugins-dir.ts` and `plugins-seed.ts`, drop `import { logger } from "./log.js"` and replace each call:

```typescript
// was: logger.withError(err).warn(`could not refresh built-in plugin '${id}'; keeping the installed copy`);
console.warn(`subshell: could not refresh built-in plugin "${id}", keeping the installed copy: ${describe(err)}`);
```

Match `registry.ts`'s existing wording shape (`subshell: ` prefix, the reason last). Add a local `describe(err)` helper, or import the one already in `plugin-runtime.ts` if it is exported.

- [ ] **Step 3: Export from the package index and repoint the agent.**

- [ ] **Step 4: Verify the move changed nothing.**

Run: `cd packages/pane-runtime && bun test && cd ../../apps/node/agent && bun test`
Expected: every test that passed before passes now. If a test needed editing beyond its import path, the move was not pure. Stop and find out why.

- [ ] **Step 5: `bunx turbo run verify-types --force` and commit.**

---

### Task 2: Give the server its own plugins directory

**Files:**
- Create: `apps/server/api/src/services/nodes/local-plugins.ts`, `apps/server/api/src/services/nodes/__tests__/local-plugins.test.ts`
- Modify: `apps/server/api/src/index.ts` (boot)

**Interfaces consumed:** everything Task 1 exported.
**Interfaces produced:**

```typescript
/** Absolute path of the control-plane host's own plugins directory. */
export function localPluginsDir(): string;

/** Boot: recover interrupted installs, seed on first run, refresh stale built-ins. */
export async function prepareLocalPlugins(): Promise<void>;

/** This host's plugin reports, the same shape an agent sends. */
export async function localPluginReports(): Promise<PluginReportWire[]>;
```

`localPluginsDir()` is `join(SUBSHELL_SERVER_DATA_DIR, "plugins")`, which under `IS_TEST` already hangs off the per-process temp data dir, so suites get their own.

- [ ] **Step 1: Write the failing test.**

```typescript
it("seeds the built-ins on first run and reports them in an agent's shape", async () => {
  await prepareLocalPlugins();
  const reports = await localPluginReports();
  expect(reports.map((r) => r.id).sort()).toEqual(["claude-code", "codex", "hermes", "opencode", "pi"]);
  // The same shape an agent sends, because the same function built it.
  expect(reports[0]).toHaveProperty("capabilities");
  expect(reports[0]).toHaveProperty("type", "agent-harness");
});

it("does not re-seed a directory a user emptied", async () => {
  await prepareLocalPlugins();
  for (const p of await listInstalled(dataDir())) await uninstallPlugin(dataDir(), p.id);
  await prepareLocalPlugins();
  expect(await localPluginReports()).toEqual([]);
});
```

The second is the load-bearing one: "offers nothing" has to be reachable on this host too.

- [ ] **Step 2: Run it and watch it fail** with "cannot find module".
- [ ] **Step 3: Implement**, delegating to the moved functions in the boot order the agent uses: `recoverInterruptedInstalls`, then `seedBuiltIns`, then `refreshStaleBuiltIns`.
- [ ] **Step 4: Call `prepareLocalPlugins()` at boot**, after migrations and before the listener, best-effort with a logged failure. A host that cannot seed still serves.
- [ ] **Step 5: Run the tests, then commit.**

---

### Task 3: Mirror `local`'s report into its node row

The server already stores an agent's report in `nodes.plugins_json`. `local` uses the same column, written at boot and after any change, so one reader serves both.

**Files:**
- Modify: `apps/server/api/src/services/nodes/local-plugins.ts`, `services/nodes/seed-local.ts`
- Test: `services/nodes/__tests__/local-plugins.test.ts`

- [ ] **Step 1: Write the failing test** asserting that after `prepareLocalPlugins()`, `NodesRepository.findById(LOCAL_NODE_ID)` has a `pluginsJson` naming the five built-ins.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement** — `prepareLocalPlugins` ends with `recordPluginReport(LOCAL_NODE_ID, await localPluginReports())`, after `ensureLocalNode(db)` so the row exists.
- [ ] **Step 4: Run and commit.**

---

### Task 4: Install and uninstall on `local` through the same route

**Files:**
- Modify: `apps/server/api/src/services/nodes/plugin-sync.ts`
- Test: `apps/server/api/src/api/nodes/__tests__/node-harnesses-route.test.ts`

Delete `assertAgent`. Both exported functions branch:

```typescript
export async function installNodePlugin(node: NodeTable, pluginId: string): Promise<void> {
  // `local` runs in THIS process, so there is no socket and no signature: the
  // command would be this server asking itself. The offline refusal below is
  // meaningless for it, which is the whole reason it is a separate branch and
  // not a degenerate case of the same one.
  if (node.kind === "local") {
    await installEmbedded(localPluginsDir(), pluginId);
    await recordLocalReport();
    return;
  }
  await mirror(node.id, await send(node, { type: "plugin_install", id: pluginId }));
}
```

- [ ] **Step 1: Write the failing tests.**

```typescript
it("installs on the control-plane host through the same route as any node", async () => {
  const res = await req("DELETE", "/api/nodes/local/plugins/codex", { cookie: adminCookie });
  expect(res.status).toBe(200);
  expect(((await res.json()) as NodeDetail).harnesses.map((h) => h.harnessId)).not.toContain("codex");
});

it("still refuses a non-admin on the control-plane host", () => { /* 403, unchanged */ });
```

Note the gate does NOT change: `local`'s `canManage` already resolves to admin.

- [ ] **Step 2: Run, watch the first fail with 400.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both, then commit.**

---

### Task 5: Collapse `effectiveHarnessStates` to one path

**Files:**
- Modify: `apps/server/api/src/services/nodes/inventory.ts:163`
- Test: `services/nodes/__tests__/inventory.test.ts`

Both kinds become (declared set × probe). The differences that remain are real and stay: `local`'s probe is live and `stale` is always false; an agent's is the cached inventory with a TTL.

- [ ] **Step 1: Write the failing test** — the §16 requirement, finally expressible:

```typescript
it("local and agent rows have the same shape, because one function builds both", async () => {
  const localRows = (await effectiveHarnessStates(localNode)).harnesses;
  const agentRows = (await effectiveHarnessStates(agentNode)).harnesses;
  expect(Object.keys(localRows[0]).sort()).toEqual(Object.keys(agentRows[0]).sort());
});

it("a plugin uninstalled from the control-plane host stops being offered there", async () => {
  await uninstallPlugin(localPluginsDir(), "codex");
  await recordLocalReport();
  const rows = (await effectiveHarnessStates(localNode)).harnesses;
  expect(rows.map((h) => h.harnessId)).not.toContain("codex");
});
```

- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement** the single path, reading `readNodePlugins(node)` for both and choosing the probe by kind.
- [ ] **Step 4: Run and commit.**

---

### Task 6: Delete the `enabled` concept

Only now, when nothing reads it for a real answer.

**Files:**
- Delete: `db/repositories/harness-plugins.repository.ts` and its `db/types/index.ts` entry
- Modify: `services/nodes/inventory.ts` (`EffectiveHarnessState.enabled`), `api/nodes/node-view.ts` (wire field), `api/harness-utils.ts` (`harnessUsable`, `usableHarnessIds`, delete `toggleLocalHarness`), `services/default-profiles.ts`, `packages/pane-runtime/src/{types.ts,plugin-adapter.ts}` (`enabledByDefault`), `apps/server/web/src/{types/node.ts,components/nodes/node-row.tsx,hooks/use-harnesses.ts}`

- [ ] **Step 1: Write the failing test** pinning that the launch gate now answers from the declared set:

```typescript
it("refuses a launch for a plugin the host does not have installed", async () => {
  await uninstallPlugin(localPluginsDir(), "codex");
  await recordLocalReport();
  expect(await harnessUsable("codex")).toBe(false);
});

it("permits one that is installed with its binary present", async () => {
  expect(await harnessUsable("pi")).toBe(true);
});
```

- [ ] **Step 2: Run, watch the first fail** (today it answers from `harness_plugins`, which still says enabled).
- [ ] **Step 3: Delete `enabledByDefault` and every `states.get(id) ?? …` site**, replacing each with a declared-set read. `node-row.tsx`'s `.filter((h) => h.installed && h.enabled)` becomes `.filter((h) => h.installed)`.
- [ ] **Step 4: `bunx turbo run verify-types --force`** — this is the step that finds the sites a grep missed.
- [ ] **Step 5: Run the full suite, then commit.**

---

### Task 7: Translate the setup toggle into install/uninstall, at the same gate

Phase 4 owns the real setup UX. This task does the minimum that keeps first-run
setup working once the toggle is gone, and no more.

**The pre-auth window is real, and it decides this task's shape.**
`requireHarnessAccess` (`setup.route.ts:93`) returns early while the instance
has no users, so `GET /harnesses` and `PATCH /harnesses/:id` are PUBLIC during
first-run and gated afterwards (security audit 2026-08, F3). The node plugin
routes require an admin cookie. So step 2 cannot simply be repointed at them:
that would either break the wizard or force a node route open to anonymous
callers, which is the tightening F3 already did once.

The translation instead keeps the gate and changes the verb — a setup-scoped
write with `requireHarnessAccess(request, true)`, exactly as wide as the toggle
it replaces:

- `POST /api/setup/plugins` `{ pluginId }`
- `DELETE /api/setup/plugins/:pluginId`

Both act on `local` through `installNodePlugin`/`uninstallNodePlugin` from
Task 4, so there is still one implementation.

**A constraint this creates for phase 3, to be carried into its plan.** In 2b
an install writes bytes this build already carries, so an anonymous first-run
install reaches no network and no registry. Phase 3 adds npm behind the same
command. If it does so without thinking about this route, the pre-auth window
becomes "an unauthenticated caller on a fresh instance makes this host fetch
and execute a package of their choosing", which is a remote code execution
path, not a widening of a config write. Phase 3 must therefore either keep
this route embedded-only or require auth for setup writes by then. Record it
in the spec's §13 as well as here.

**Files:**
- Modify: `apps/server/api/src/api/setup.route.ts` (delete the PATCH handler, add the two plugin handlers), the SPA's setup step 2
- Delete: `useSetHarnessEnabled`, `harnessToggleErrorMessage`
- Test: `api/__tests__/setup-route.test.ts`

- [ ] **Step 1: Write the failing tests.**

```typescript
it("PATCH /api/setup/harnesses/:id is gone", async () => {
  expect((await patch("/api/setup/harnesses/pi", { enabled: false })).status).toBe(404);
});

it("installs on local during first-run, before any user exists", async () => {
  await deleteAllUsers();
  expect((await post("/api/setup/plugins", { pluginId: "codex" })).status).toBe(200);
});

it("requires a cookie session once a user exists", async () => {
  await createUser();
  expect((await post("/api/setup/plugins", { pluginId: "codex" })).status).toBe(403);
  expect((await post("/api/setup/plugins", { pluginId: "codex" }, bearerKey)).status).toBe(403);
});

it("installs only what this build carries, never an arbitrary name", async () => {
  // The pre-auth guard against what phase 3 would otherwise open up.
  await deleteAllUsers();
  const res = await post("/api/setup/plugins", { pluginId: "some-package-from-npm" });
  expect(res.status).toBe(400);
});
```

The last one is the load-bearing test of this task: it fails closed on anything
not embedded, so phase 3 has to make a deliberate change to open it.

- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement**, rejecting any id not in `builtInIds()` with a 400 naming it.
- [ ] **Step 4: Repoint the SPA's step 2** at the two new endpoints, reusing `NodeHarnessCard`.
- [ ] **Step 5: Run and commit.**

---

### Task 8: Drop the table

**Files:**
- Create: `apps/server/api/src/db/migrations/0025-drop-harness-plugins.ts`
- Modify: `apps/server/api/src/db/migrate.ts` (the static provider map, file name = key)
- Test: `db/migrations/__tests__/0025-drop-harness-plugins.test.ts`

- [ ] **Step 1: Write the failing test** — after `up`, `harness_plugins` is absent; `down` recreates it with its original columns.
- [ ] **Step 2: Run, watch it fail.**
- [ ] **Step 3: Write the migration and register it.** The table is dropped WITHOUT being read: see Global Constraints.
- [ ] **Step 4: `bun run db:migrate:latest` against a scratch DB, then the tests. Commit.**

---

### Task 9: Correct the impossible compatibility comments

Six places document a fleet of older agents that gate 2 makes impossible and that does not exist. `packages/subshell-protocol/src/node-frames.ts:20` already states the truth; the rest contradict it.

**Files:** `apps/server/web/src/types/{harness.ts,node.ts}`, `apps/server/web/src/lib/__tests__/checked-at.test.ts`, `apps/server/api/src/services/nodes/inventory.ts:38,40`, `packages/pane-runtime/src/inventory.ts:20`

- [ ] **Step 1:** Replace each "absent from older agents" with what is actually true: the field is optional because a PROBE may not have produced it (a plugin that declares no binary reports no version), not because a peer might be old. `checked-at.test.ts`'s comment becomes "a probe that never ran reports nothing here; that is unknown, not never".
- [ ] **Step 2:** `bun run lint:check` and commit.

---

### Task 10: End to end, and the docs

- [ ] **Step 1:** Extend `e2e/` nodes spec: install and uninstall a plugin on the control-plane host through the UI, and assert the launch picker gains and loses it.
- [ ] **Step 2:** Update `docs/architecture.md` (the Registry paragraph still describes per-node harness enablement) and `apps/server/api/AGENTS.md` (the `harness_plugins` references).
- [ ] **Step 3:** `bunx turbo run verify-types --force`, `bun run lint:check`, `bun run test`, `bun run test:e2e`.
- [ ] **Step 4:** Code review, then commit.

## Self-Review

**Spec coverage.** §11 (control-plane host loads plugins the same way): Tasks 1 to 3. §12 deletions (`harness_plugins`, the setup PATCH, the toggle hooks, `enabledByDefault`): Tasks 6 to 8. §12's no-migration decision: Task 8. §16 phase 2 ("`local` and agent paths produce the same report shape"): Task 5, Step 1.

**Ordering.** The delete tasks (6 to 8) come after the replace tasks (2 to 5) so nothing is removed before its answer exists. Task 1 is a pure move so that the diff of every later task is behaviour rather than paths.

**The known risk was Task 7's pre-auth setup window, and it is now resolved
rather than flagged.** `requireHarnessAccess` is public while no user exists,
so the toggle is translated into a setup-scoped install at the same gate, held
to embedded ids by a test that fails closed. The reason that test matters is
phase 3: the same route with npm behind it, still anonymous on a fresh
instance, is a remote code execution path. That constraint belongs in phase
3's plan and in §13 of the spec, not only here.
