# Preset enable/disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an enabled/disabled toggle to both agent and SSH presets, so a preset can be hidden from every launch surface (pickers, MCP, mobile chips) and refused at launch, while staying listed in the `/presets` table to be re-enabled.

**Architecture:** A stored `enabled` integer column (default 1) on `presets` and `ssh_presets`. The list endpoint keeps returning all rows with the flag; the picker surfaces filter it out. A dedicated `PATCH /api/presets/:id { enabled }` flips the flag for both kinds (mirrors the plugin grid's `PATCH /api/plugins/:id`). The agent launch gate and MCP `create_subshell` refuse a disabled preset by id.

**Tech Stack:** Bun + Elysia + Kysely + SQLite (server); TanStack Query + React + Base UI `Switch` (web); MCP core tools; React Native (mobile). Tests via `bun:test` and Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-24-preset-enable-disable-design.md`

## Global Constraints

- The `enabled` value is an integer 0/1 on the wire and in the web/mobile types, matching the existing preset flag convention (`restartOnExit`, `configIsolation`, `crossCommEnabled`).
- Both preset kinds (`presets` and `ssh_presets`) get the column, the toggle, and the refusal. Nothing may be added to one kind only.
- The `/api/presets` list keeps returning disabled rows (with `enabled`); only picker surfaces filter. Bearer `envJson` redaction is unchanged.
- The toggle is cookie-only and requires owner or edit access; a view-shared preset gets no toggle and returns 403 on the PATCH.
- A disabled preset is never deleted; it is only hidden from pickers and refused at launch.
- Launch refusal is a 409 with the wire code `preset_disabled` (the agent create path and the restart/swap path).
- The import/export preset file format (version 1) is unchanged; an imported preset always starts enabled.
- Migration is self-contained and guarded on column/table existence (re-runs cleanly), and must be registered in the static map in `apps/server/api/src/db/migrate.ts`.
- Tests that build a `PresetRow`/`SshPreset`/`PresetView` fixture must add `enabled` to the fixture or they fail to type-check.

## Review Focus

- **A disabled preset must not auto-apply from a recent launch's default.** The launch form's auto-default reads a recent subshell's `presetId`; if that preset is now disabled, the form must degrade to no preset rather than carry a disabled one.
- **A preset disabled then re-enabled must reappear in pickers without a reload.** The toggle invalidates the preset caches so the next read is fresh.
- **A disabled preset's detail/edit page and launch-command preview still work.** Disabling is not deleting; the row's own page remains readable and its command still renders.
- **A bearer/machine `list_presets` never offers a disabled preset, and a direct `POST /api/subshells` with a disabled id is refused even though the picker hid it.**
- **View-shared presets show no toggle** and a viewer cannot flip one via the API.

---

### Task 1: Add the `enabled` column via migration

**Files:**
- Create: `apps/server/api/src/db/migrations/0062-preset-enabled.ts`
- Create: `apps/server/api/src/db/migrations/__tests__/0062-preset-enabled.test.ts`
- Modify: `apps/server/api/src/db/migrate.ts` (import + register `"0062-preset-enabled"`)

**Interfaces:**
- Consumes: the existing migration helpers pattern (`hasTable`/`hasColumn`/`sql` pragma queries) as used by `0027-presets.ts`.
- Produces: the `presets.enabled` and `ssh_presets.enabled` integer columns, NOT NULL DEFAULT 1.

- [ ] **Step 1: Write the migration**

Create `0062-preset-enabled.ts` with `up`/`down`. `up` adds `enabled` integer NOT NULL DEFAULT 1 to `presets` and `ssh_presets`, each guarded on the column being absent (`hasColumn`), so a re-run is a no-op. `down` drops the column from both, each guarded on the column being present.

```ts
import { type Kysely, sql } from "kysely";
async function hasColumn(db: Kysely<any>, table: string, column: string): Promise<boolean> {
  const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table}) WHERE name = ${column}`.execute(db);
  return r.rows.length > 0;
}
export async function up(db: Kysely<any>): Promise<void> {
  for (const table of ["presets", "ssh_presets"]) {
    if (!(await hasColumn(db, table, "enabled"))) {
      await db.schema.alterTable(table).addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1)).execute();
    }
  }
}
export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ["presets", "ssh_presets"]) {
    if (await hasColumn(db, table, "enabled")) {
      await db.schema.alterTable(table).dropColumn("enabled").execute();
    }
  }
}
```

- [ ] **Step 2: Write the migration test**

Create `__tests__/0062-preset-enabled.test.ts` following the `0027-presets.test.ts` pattern: build a fresh SQLite DB, run `initMigration.up`, `sshPresetsMigration.up` (0054) to create both tables, then run `0062`'s `up` and assert each table's `pragma_table_info` contains `enabled`, and that an inserted row defaults to 1. Then run `down` and assert the column is gone.

Run: `bun test apps/server/api/src/db/migrations/__tests__/0062-preset-enabled.test.ts`
Expected: PASS.

- [ ] **Step 3: Register the migration**

In `apps/server/api/src/db/migrate.ts`, add `import * as presetEnabledMigration from "@/db/migrations/0062-preset-enabled.js";` and add `"0062-preset-enabled": presetEnabledMigration,` to the provider map.

- [ ] **Step 4: Run the migration suite**

Run: `bun test apps/server/api/src/db/migrations/__tests__`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/db/migrations/0062-preset-enabled.ts apps/server/api/src/db/migrations/__tests__/0062-preset-enabled.test.ts apps/server/api/src/db/migrate.ts
git commit -m "feat(db): add enabled column to presets and ssh_presets"
```

---

### Task 2: Thread `enabled` through DB types and repository/service defaults

**Files:**
- Modify: `apps/server/api/src/db/types/presets.db-types.ts`
- Modify: `apps/server/api/src/db/types/ssh-presets.db-types.ts`
- Modify: `apps/server/api/src/db/repositories/presets.repository.ts`
- Modify: `apps/server/api/src/services/ssh-presets.service.ts`
- Test: `apps/server/api/src/db/repositories/__tests__/presets-by-harness.test.ts`

**Interfaces:**
- Consumes: the migration from Task 1 (columns exist).
- Produces: `PresetTable.enabled: number`, `NewPreset.enabled?: number`, `PresetUpdate` includes `enabled`; `SshPresetTable.enabled: number`; `PresetsRepository.create` defaults `enabled` to 1.

- [ ] **Step 1: Add `enabled` to the table types**

In `presets.db-types.ts`, add `/** 1 = the preset is offered; 0 = hidden from pickers and refused at launch */ enabled: number;` to `PresetTable`, and add `enabled?: number;` to `NewPreset`. `PresetUpdate` derives from `NewPreset`, so no separate line.

In `ssh-presets.db-types.ts`, add the same `enabled: number` to `SshPresetTable`.

- [ ] **Step 2: Default `enabled` in the agent repository create**

In `presets.repository.ts` `create`, mirror the DB default so the returned row is complete:

```ts
restartOnExit: preset.restartOnExit ?? 0,
crossCommEnabled: preset.crossCommEnabled ?? 0,
enabled: preset.enabled ?? 1,
```

- [ ] **Step 3: Default `enabled` in the SSH row composition**

In `ssh-presets.service.ts` `saveSshPreset`, add `enabled: existing?.enabled ?? 1,` to the `row` object.

- [ ] **Step 4: Write the repository/service test**

In `presets-by-harness.test.ts` (or a new `presets.repository.test.ts`), add a test: `create` with no `enabled` returns a row with `enabled === 1`; `update` with `{ enabled: 0 }` persists it. For SSH, add a test through `saveSshPreset` that a created SSH preset has `enabled === 1` and that an update setting `enabled` (via the new row path) persists it.

Run: `bun test apps/server/api/src/db/repositories/__tests__/presets-by-harness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/db/types/presets.db-types.ts apps/server/api/src/db/types/ssh-presets.db-types.ts apps/server/api/src/db/repositories/presets.repository.ts apps/server/api/src/services/ssh-presets.service.ts apps/server/api/src/db/repositories/__tests__/presets-by-harness.test.ts
git commit -m "feat(db): thread enabled through preset types and repository defaults"
```

---

### Task 3: API response schema + the `PATCH /api/presets/:id` toggle endpoint

**Files:**
- Modify: `apps/server/api/src/api/models.ts` (`PresetSchema`)
- Modify: `apps/server/api/src/api/ssh-presets.ts` (`SshPresetSchema`)
- Modify: `apps/server/api/src/api/presets.route.ts` (add `.patch("/:id", ...)` route)
- Test: `apps/server/api/src/api/__tests__/presets-route.test.ts`

**Interfaces:**
- Consumes: `PresetsRepository.update`, `SshPresetsRepository.update`, `presetAccess`, `presetOwnerName`, `sshPresetView`.
- Produces: `enabled: number` on both response schemas; `PATCH /api/presets/:id` accepting `{ enabled: boolean }` and returning the updated row (agent or ssh view) with `kind`, `access`, `ownerName`.

- [ ] **Step 1: Add `enabled` to the response schemas**

In `models.ts` `PresetSchema`, add `enabled: t.Number({ description: "1 = offered; 0 = hidden from pickers and refused at launch" }),`.

In `ssh-presets.ts` `SshPresetSchema`, add the same `enabled: t.Number(...)`. It is built from `SshPresetFields` plus explicit fields, so add `enabled` as an explicit field (not into `SshPresetFields`, which create/update bodies spread).

- [ ] **Step 2: Add the PATCH route**

In `presets.route.ts`, add a `.patch("/:id", ...)` handler after the existing `put`. Logic:

```
if (actor !== "cookie") throw PresetError("forbidden", "Sign in through the dashboard to manage presets", 403);
const sshRepo = new SshPresetsRepository(db);
const sshExisting = await sshRepo.findById(params.id);
if (sshExisting) {
  const access = await presetAccess(db, "ssh", sshExisting, user.id);
  if (access === "none") throw new PresetError("not_found", "Preset not found");
  if (access === "view") throw new PresetError("forbidden", "You need edit access to change this preset.", 403);
  const updated = await sshRepo.update(params.id, { enabled: body.enabled ? 1 : 0 });
  return { ...sshPresetView(updated), access, ownerName: await presetOwnerName(db, sshExisting.userId) };
}
const repo = new PresetsRepository(db);
const existing = await repo.findById(params.id);
if (!existing) throw new PresetError("not_found", "Preset not found");
const access = await presetAccess(db, "agent", existing, user.id);
if (access === "none") throw new PresetError("not_found", "Preset not found");
if (access === "view") throw new PresetError("forbidden", "You need edit access to change this preset.", 403);
const updated = await repo.update(params.id, { enabled: body.enabled ? 1 : 0 });
if (!updated) throw new PresetError("not_found", "Preset not found");
return { ...updated, kind: "agent" as const, access, ownerName: await presetOwnerName(db, existing.userId) };
```

Schema: `body: t.Object({ enabled: t.Boolean() })`, `response: { 200: t.Union([PresetSchema, SshPresetSchema]), 400: "ApiErrorResponse", 401: "ApiErrorResponse", 403: "ApiErrorResponse", 404: "ApiErrorResponse" }`, `detail.operationId: "setPresetEnabled"`, tags `["presets"]`.

Note: `SshPresetSchema`/`PresetSchema` already declare `ownerName`/`access` optional; the `sshPresetView` returns `enabled` because it spreads the row.

- [ ] **Step 3: Write the route test**

In `presets-route.test.ts`, add tests:
1. Cookie user PATCHes their own agent preset `{ enabled: false }` → 200 with `enabled: 0`; a subsequent `GET /api/presets` still lists the row (with `enabled: 0`).
2. Cookie user PATCHes a view-shared preset → 403.
3. Bearer actor PATCHes → 403.
4. PATCHing an SSH preset `{ enabled: false }` → 200 with `enabled: 0`.
5. PATCH with a non-boolean `enabled` → 400 (schema validation).

Run: `bun test apps/server/api/src/api/__tests__/presets-route.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/api/src/api/models.ts apps/server/api/src/api/ssh-presets.ts apps/server/api/src/api/presets.route.ts apps/server/api/src/api/__tests__/presets-route.test.ts
git commit -m "feat(api): add enabled to preset schemas and a PATCH toggle endpoint"
```

---

### Task 4: Refuse a disabled preset at the agent launch gate

**Files:**
- Modify: `apps/server/api/src/services/subshells.service.ts` (create gate)
- Modify: `apps/server/api/src/services/subshell-manager.service.ts` (restart/swap gate)
- Test: `apps/server/api/src/api/__tests__/presets-route.test.ts` or a subshells create test

**Interfaces:**
- Consumes: `presetRow.enabled` from Task 2.
- Produces: a 409 `preset_disabled` refusal in both the create path and the restart/swap path.

- [ ] **Step 1: Add the create-path refusal**

In `subshells.service.ts` `createSubshell`, after the `presetAccess === "none"` check (where `presetRow` is confirmed present and accessible), add:

```ts
if (presetRow.enabled === 0) {
  throw new SubshellCreateError("preset_disabled", `Preset "${presetRow.name}" is disabled`, 409);
}
```

- [ ] **Step 2: Add the restart/swap refusal**

In `subshell-manager.service.ts`, in both the swap path (around the `nextPresetId` resolution) and the relaunch path (around the `presetRow` resolution), after the access check add the same `enabled === 0` → throw `new Error("Preset is disabled. Re-enable it in the dashboard before restarting this subshell.")` (or a coded variant consistent with the file's existing `Error` throws).

- [ ] **Step 3: Write the test**

Add a test that seeds a preset with `enabled: 0`, then `POST /api/subshells` with that `presetId` → 409 with code `preset_disabled`. Re-enable via PATCH and assert the same create now succeeds.

Run: `bun test apps/server/api/src/api/__tests__/presets-route.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/api/src/services/subshells.service.ts apps/server/api/src/services/subshell-manager.service.ts apps/server/api/src/api/__tests__/presets-route.test.ts
git commit -m "feat(api): refuse launching a disabled preset"
```

---

### Task 5: MCP — filter `list_presets` and refuse `create_subshell`

**Files:**
- Modify: `packages/mcp-core/src/subshell-tools.ts`
- Test: `packages/mcp-core/src/__tests__/tools.test.ts` (or the relevant MCP test)

**Interfaces:**
- Consumes: `PresetsWireRow.enabled: number` from the `/api/presets` wire.
- Produces: `listPresets` excludes `enabled === 0` rows; `createSubshell` throws when the resolved preset is disabled.

- [ ] **Step 1: Add `enabled` to `PresetsWireRow`**

In `subshell-tools.ts`, add `enabled: number;` to `PresetsWireRow`.

- [ ] **Step 2: Filter in `listPresets`**

In `listPresets`, after `rows`, filter out disabled presets before mapping: `.filter((row) => row.enabled !== 0)`. Keep the catalog rows as-is (they are harnesses, not presets).

- [ ] **Step 3: Refuse in `createSubshell`**

In `createSubshell`, after `presetRow` is resolved, add:

```ts
if (presetRow.enabled === 0) {
  throw new Error(
    `subshell: preset '${args.preset}' is disabled; re-enable it in the dashboard, or pass a different preset`,
  );
}
```

- [ ] **Step 4: Write the test**

Add a test that a `listPresets` response containing a disabled preset does not include it, and that `createSubshell` with a disabled preset id throws the disabled message.

Run: `bun test packages/mcp-core/src/__tests__/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-core/src/subshell-tools.ts packages/mcp-core/src/__tests__/tools.test.ts
git commit -m "feat(mcp): hide disabled presets and refuse creating from one"
```

---

### Task 6: Web — types, toggle hook, and the agent table toggle

**Files:**
- Modify: `apps/server/web/src/types/preset.ts` (`AgentPreset`)
- Modify: `apps/server/web/src/hooks/use-presets.ts` (add `useTogglePresetEnabled`)
- Modify: `apps/server/web/src/components/presets/preset-table-row.tsx`
- Modify: `apps/server/web/src/components/presets/agent-preset-library.tsx`
- Test: `apps/server/web/src/components/presets/__tests__/preset-table-row.test.tsx` (create if absent) and update existing fixtures in `__tests__/*`

**Interfaces:**
- Consumes: the `PATCH /api/presets/:id` endpoint (Task 3).
- Produces: `AgentPreset.enabled: number`; `useTogglePresetEnabled()` returning a mutation; `PresetTableRow` renders a `Switch` in a new "Enabled" cell.

- [ ] **Step 1: Add `enabled` to `AgentPreset`**

In `types/preset.ts`, add `/** 1 = offered; 0 = hidden from pickers and refused at launch */ enabled: number;` to `AgentPreset` (and to `SshPreset` in the same file).

- [ ] **Step 2: Add the toggle hook**

In `use-presets.ts`, add:

```ts
export function useTogglePresetEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/api/presets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      // `["presets"]` is a PREFIX match, so this invalidates both the agent
      // list and the `["presets", "ssh"]` list in one call.
      void queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
    },
  });
}
```

No import of `SSH_PRESETS_QUERY_KEY` is needed (that would create a cycle with `use-ssh-presets.ts`); the prefix match covers it.

- [ ] **Step 3: Render the toggle in `PresetTableRow`**

Add a new column `Enabled` in the agent table. In `preset-table-row.tsx`, before the Owner cell, render a cell:

```tsx
<td className="@lg:table-cell hidden h-8 whitespace-nowrap py-0 pr-4">
  {canEditPreset(preset) ? (
    <Switch checked={preset.enabled === 1} aria-label={`${preset.name} enabled`} onCheckedChange={(checked) => toggle.mutate({ id: preset.id, enabled: checked })} />
  ) : (
    <span className="text-muted-foreground">{preset.enabled === 1 ? "Yes" : "No"}</span>
  )}
</td>
```

In `PresetTableRow`, call `const toggle = useTogglePresetEnabled();` and import `Switch` from `@internal/node-admin`. The row's command-detail `tr` uses `colSpan={5}` today; with the new column it becomes `colSpan={6}`. Dim the row when disabled by adding an `opacity`/text class on the row's cells or a wrapper class when `preset.enabled === 0`.

- [ ] **Step 4: Add the column header**

In `agent-preset-library.tsx`, add a `<th>` "Enabled" with the same responsive visibility classes as the Auto-restart column (`@sm:table-cell hidden` or `@lg:table-cell hidden`).

- [ ] **Step 5: Update fixtures and write the component test**

Update every `PresetRow` fixture in `apps/server/web/src/components/**/__tests__/*.tsx` and `apps/server/web/src/lib/__tests__/*.ts` to include `enabled: 1` (type-check will surface them). Add a test that a row with `enabled: 0` renders the switch unchecked and a `Switch` click calls the toggle mutation (mock `useTogglePresetEnabled`).

Also assert the disabled row is still actionable in its own surfaces: the launch-command preview still renders (not gated by `enabled`), and the detail page / edit dialog still open for a disabled preset (the pickers filter; the detail does not).

Run: `bun test apps/server/web/src/components/presets/__tests__/preset-table-row.test.tsx` (and the package type-check `bun run verify-types --filter=@internal/server-web`)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/web/src/types/preset.ts apps/server/web/src/hooks/use-presets.ts apps/server/web/src/components/presets/preset-table-row.tsx apps/server/web/src/components/presets/agent-preset-library.tsx
git commit -m "feat(web): add enabled toggle to agent preset rows"
```

---

### Task 7: Web — SSH table toggle

**Files:**
- Modify: `apps/server/web/src/components/presets/ssh-preset-library.tsx`
- Modify: `apps/server/web/src/types/preset.ts` (`SshPreset`)
- Test: `apps/server/web/src/components/presets/__tests__/ssh-preset-editor.test.tsx` (or add a library test)

**Interfaces:**
- Consumes: `useTogglePresetEnabled` (Task 6), `canEditPreset`, `SshPreset.enabled`.
- Produces: an `Enabled` column with a `Switch` in the SSH table.

- [ ] **Step 1: Add `enabled` to `SshPreset`**

(Already added in Task 6 Step 1; confirm it is present.)

- [ ] **Step 2: Add the Enabled column and toggle**

In `ssh-preset-library.tsx`, add an `Enabled` `<th>` and, in each row before Owner, a cell with a `Switch` (toggle only when `canEditPreset(preset)`), wired to `useTogglePresetEnabled`. Dim the row when disabled.

- [ ] **Step 3: Write/update the component test**

Add a test that an SSH preset row with `enabled: 0` renders the switch off, and flipping it calls the toggle mutation.

Run: `bun test apps/server/web/src/components/presets/__tests__`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/web/src/components/presets/ssh-preset-library.tsx
git commit -m "feat(web): add enabled toggle to SSH preset rows"
```

---

### Task 8: Web — filter disabled presets from every picker

**Files:**
- Modify: `apps/server/web/src/components/subshell-picker/new-subshell-form.tsx`
- Modify: `apps/server/web/src/components/switch-preset-dialog.tsx`
- Modify: `apps/server/web/src/components/connect/ssh-preset-controls.tsx`
- Test: `apps/server/web/src/lib/__tests__/launch-defaults.test.ts` and `apps/server/web/src/components/connect/__tests__/*` (if present)

**Interfaces:**
- Consumes: `enabled` on the preset row.
- Produces: all three picker surfaces only offer `enabled === 1` presets; the launch form's recent-launch auto-default degrades to no preset when the recent preset is disabled.

- [ ] **Step 1: Filter the agent launch picker**

In `new-subshell-form.tsx`, change the picker's preset list source to filter out disabled presets for the **user-facing options** while still passing the full `presetRows` to `useLaunchFormDefaults` (so the default logic can detect and drop a disabled recent preset). Filter at the `presetList` construction: `presets.filter((p) => p.enabled === 1)`.

- [ ] **Step 2: Degrade the recent-launch default**

In `lib/launch-defaults.ts` (or `use-launch-form-defaults.ts`), when selecting the recent subshell's preset, skip it if `preset.enabled === 0` and fall back to no preset.

- [ ] **Step 3: Filter the switch-preset dialog**

In `switch-preset-dialog.tsx`, change `const options = (presets ?? []).filter((p) => p.harnessId === subshell.harnessId);` to also `.filter((p) => p.enabled === 1)`.

- [ ] **Step 4: Filter the SSH preset picker**

In `ssh-preset-controls.tsx`, filter `query.data` to `enabled === 1` for the picker options.

- [ ] **Step 5: Write the tests**

Add/adjust tests asserting: a disabled preset is absent from the launch form's options; the switch-preset dialog omits disabled presets; the SSH picker omits disabled presets; and a recent subshell whose preset is disabled does not pre-fill that preset.

Run: `bun test apps/server/web/src/lib/__tests__/launch-defaults.test.ts` and any new component tests
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/web/src/components/subshell-picker/new-subshell-form.tsx apps/server/web/src/components/switch-preset-dialog.tsx apps/server/web/src/components/connect/ssh-preset-controls.tsx apps/server/web/src/lib/launch-defaults.ts
git commit -m "feat(web): hide disabled presets from launch pickers"
```

---

### Task 9: Mobile — filter disabled presets from the New screen chips

**Files:**
- Modify: `apps/client/mobile/src/types/preset.ts` (`PresetView`)
- Modify: `apps/client/mobile/app/(tabs)/new.tsx`
- Test: `apps/client/mobile/src/lib/__tests__/api.test.ts` (or the new-screen test)

**Interfaces:**
- Consumes: `PresetView.enabled`.
- Produces: the New screen's agent preset chips only include `enabled === 1` presets.

- [ ] **Step 1: Add `enabled` to `PresetView`**

Add `/** 1 = offered; 0 = hidden from pickers */ enabled: number;` to `PresetView`.

- [ ] **Step 2: Filter the chips**

In `new.tsx`, change the `agentPresets` memo to `.filter((p) => p.harnessId === harnessId && p.enabled === 1)`.

- [ ] **Step 3: Write the test**

Add a test that a preset with `enabled: 0` is excluded from the chips list.

Run: `bun test apps/client/mobile/src/lib/__tests__/api.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/client/mobile/src/types/preset.ts "apps/client/mobile/app/(tabs)/new.tsx"
git commit -m "feat(mobile): hide disabled presets from the New screen"
```

---

## Execution Handoff

After implementing, run the full affected suites:

```bash
bun run test --filter=@internal/server
bun run test --filter=@internal/server-web
bun run test --filter=@internal/mcp-core
bun run test --filter=@internal/mobile
bun run verify-types
```

(Always prefix script-invoked runs with `env -u SHELLOPTS -u BASHOPTS`, per AGENTS.md, and capture output to a file rather than piping to tail.)
