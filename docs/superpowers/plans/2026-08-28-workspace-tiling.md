# Workspace Tiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-form workspace canvas with tmux-style tiling built on `dockview-react`, plus a tabs presentation below 1024px so the feature works on a tablet or phone.

**Architecture:** dockview owns the split tree, dividers, tabs and drag; we own the pane *content* and persist dockview's serialized layout as one `layout_json` column. Below 1024px dockview is not mounted at all — a tab strip renders one session at a time and never writes the layout, so a phone visit cannot flatten a desktop arrangement. `<SessionTerminal>` is shared by both presentations unchanged.

**Tech Stack:** Bun, Elysia, Kysely + `bun:sqlite`, React 19, TanStack Router/Query, xterm 6, `dockview-react` 8.2.0, Tailwind + shadcn/ui, biome, turbo.

**Spec:** `docs/superpowers/specs/2026-08-28-workspace-tiling-design.md`

## Global Constraints

- **Package manager is Bun only.** `bun install`, `bun run <script>`, `bunx`. Never npm/pnpm/yarn/npx.
- **No dynamic imports.** `await import(...)` breaks `bun build --compile`. Static top-level `import` only.
- **Pinned dependency versions** — no `^` or `~`. This plan adds exactly one dependency: `dockview-react` at `8.2.0`.
- **No backwards compatibility.** Migration `0006` is rewritten in place, not superseded. Existing databases are recreated (`rm -f data/mote.db*`).
- **File size:** split beyond ~300-400 lines. Route components beyond ~200 lines move logic into `src/hooks/`, `src/components/`, `src/lib/`.
- **Every Elysia `t` schema property needs a `description`** — including nested ones. It generates the OpenAPI docs and the Eden client types.
- **JSDoc on every exported class, function, and interface property.**
- **Union types, not bare strings**, for fixed sets of values.
- **Migration file name and the `migrate.ts` provider-map key must match exactly** (`0006-workspaces`).
- **Ownership rule is untouchable:** every workspace handler resolves via `findByIdForUser(id, user.id)` and answers **404, never 403**.
- **`renderer: 'always'` on every dockview panel.** It is what keeps the DOM alive and the terminal undisposed. Not optional.
- **The narrow presentation must never write `layout_json`.**
- **Breakpoint is one shared constant** (`WORKSPACE_TILING_MIN_WIDTH = 1024`), imported by both presentations.
- **Verification after every task:** `bun run verify-types`, `bun run lint:check`, `bun run test`. Run `turbo build` after backend route/schema changes — `@internal/backend-client` infers its types from the backend's `App` type.
- **`bun run lint` (write mode) can rewrite React hook dependency arrays.** Check your diff after running it. `bun run lint:check` is read-only and safe.
- **Commit style:** conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Enforced by commitlint.

---

## File Structure

**Backend**
- Modify: `apps/backend/src/db/migrations/0006-workspaces.ts` — drop canvas/geometry columns, add `layout_json`
- Modify: `apps/backend/src/db/migrations/__tests__/0006-workspaces.test.ts`
- Modify: `apps/backend/src/db/types/workspaces.db-types.ts`, `workspace-panes.db-types.ts`
- Modify: `apps/backend/src/db/repositories/workspace-panes.repository.ts` — delete `replaceGeometry`/`PaneGeometry`
- Create: `apps/backend/src/api/workspace-layout.ts` — pure layout pruning (+ `__tests__/workspace-layout.test.ts`)
- Modify: `apps/backend/src/api/workspaces.route.ts`, `models.ts`

**Frontend — new**
- `apps/frontend/src/lib/workspace-layout.ts` (+ test) — panel ids, panes missing from layout
- `apps/frontend/src/lib/breakpoints.ts` — the shared constant
- `apps/frontend/src/hooks/use-is-wide.ts` — matchMedia hook
- `apps/frontend/src/components/session-pane.tsx` — a dockview panel's *content*
- `apps/frontend/src/components/workspace-dock.tsx` — wide presentation
- `apps/frontend/src/components/workspace-tabs.tsx` — narrow presentation
- `apps/frontend/src/components/session-picker.tsx` — split menu + draggable session list

**Frontend — deleted at cutover (Task 9)**
- `components/workspace-canvas.tsx` (393), `components/workspace-pane.tsx` (439), `components/add-pane-menu.tsx` (264)
- `hooks/use-pane-layout.ts` (163), `hooks/use-pane-visibility.ts` (129)
- `lib/canvas-geometry.ts` (98) + `lib/__tests__/canvas-geometry.test.ts` (80)

**Frontend — kept**
- `hooks/use-debounced-save.ts` (now carries the layout), `lib/session-confirmations.ts`, `components/session-terminal.tsx`, `types/workspace.ts` (edited)

---

### Task 1: Schema, DB types, repository

**Files:**
- Modify: `apps/backend/src/db/migrations/0006-workspaces.ts`
- Modify: `apps/backend/src/db/migrations/__tests__/0006-workspaces.test.ts`
- Modify: `apps/backend/src/db/types/workspaces.db-types.ts`, `apps/backend/src/db/types/workspace-panes.db-types.ts`
- Modify: `apps/backend/src/db/repositories/workspace-panes.repository.ts`
- Modify: `apps/backend/src/db/repositories/__tests__/workspaces-repository.test.ts`

**Interfaces:**
- Produces: `WorkspaceTable` with `layoutJson: string | null` and **no** `canvasX`/`canvasY`; `WorkspacePaneTable` with **no** geometry; `WorkspacePanesRepository` without `replaceGeometry`.

- [ ] **Step 1: Update the migration test first**

In `0006-workspaces.test.ts`, change the `MigrationDatabase` interface: `workspaces` loses `canvasX`/`canvasY` and gains `layoutJson: string | null`; `workspacePanes` loses `x`, `y`, `width`, `height`, `zIndex`, `collapsed`.

Replace the canvas-defaults test with:

```ts
it("creates a workspace with a null layout by default", async () => {
  await db
    .$extendTables<MigrationDatabase>()
    .insertInto("workspaces")
    .values({ id: "w1", userId: "u1", name: "refactor", description: null })
    .execute();
  const row = await db
    .$extendTables<MigrationDatabase>()
    .selectFrom("workspaces")
    .select(["id", "name", "layoutJson"])
    .where("id", "=", "w1")
    .executeTakeFirstOrThrow();
  expect(row).toEqual({ id: "w1", name: "refactor", layoutJson: null });
});
```

In both cascade tests, the pane insert loses its geometry — it becomes:

```ts
.values({ id: "pane1", workspaceId: "w5", sessionId: "s1" })
```

**Leave both cascade tests otherwise exactly as they are.** They are the load-bearing tests for the whole dangling-pane strategy and must keep asserting `toHaveLength(0)` after the parent delete.

- [ ] **Step 2: Run the migration tests and watch them fail**

```bash
cd apps/backend && bun test src/db/migrations/__tests__/0006-workspaces.test.ts
```
Expected: FAIL — `layoutJson` does not exist, and the pane inserts fail because `x`/`y`/`width`/`height` are `NOT NULL` with no default.

- [ ] **Step 3: Rewrite the migration**

In `apps/backend/src/db/migrations/0006-workspaces.ts`, in the `workspaces` table replace the two canvas columns with one layout column, and delete the six geometry columns from `workspace_panes`:

```ts
    .addColumn("layout_json", "text")
```

Update the file's doc comment — it currently says "a per-user canvas of windows":

```ts
/**
 * Workspaces: a per-user tiling layout of sessions.
 *
 * `layout_json` holds the serialized dockview split tree; the panes table holds
 * only identity. These are the schema's first foreign keys, and
 * `PRAGMA foreign_keys = ON` is set in the sqlite dialect, so both cascades are
 * enforced: dropping a workspace drops its panes, and deleting a session drops
 * any pane pointing at it — which is why no application code sweeps dangling
 * panes.
 */
```

- [ ] **Step 4: Run the migration tests again**

```bash
cd apps/backend && bun test src/db/migrations/__tests__/0006-workspaces.test.ts
```
Expected: PASS, 4 tests, both cascades included.

- [ ] **Step 5: Update the DB types**

`workspaces.db-types.ts`: replace the two canvas properties with

```ts
  /** Serialized dockview layout tree, or null when none has been saved yet */
  layoutJson: string | null;
```

and simplify the insert shape (nothing is DB-defaulted any more except timestamps):

```ts
/** Insert shape: DB defaults fill the timestamps. */
export type NewWorkspace = Omit<WorkspaceTable, "createdAt" | "updatedAt" | "layoutJson"> & {
  layoutJson?: string | null;
};
```

`workspace-panes.db-types.ts`: delete `x`, `y`, `width`, `height`, `zIndex`, `collapsed` from `WorkspacePaneTable`, and simplify:

```ts
/** Insert shape: DB defaults fill the timestamps. */
export type NewWorkspacePane = Omit<WorkspacePaneTable, "createdAt" | "updatedAt">;
```

Update the interface doc comment: "One window on a workspace canvas" becomes "One pane in a workspace's tiling layout".

- [ ] **Step 6: Strip the repository**

In `workspace-panes.repository.ts` delete the exported `PaneGeometry` interface and the whole `replaceGeometry` method. `listByWorkspace` loses its `.orderBy("zIndex", "asc")` — order by `createdAt` instead, so the fallback tab order is stable and meaningful:

```ts
      .orderBy("createdAt", "asc")
```

`create` no longer defaults `zIndex`/`collapsed`; it just spreads the pane with the timestamps.

In `workspaces-repository.test.ts`, delete the two `replaceGeometry` tests entirely, drop geometry from the remaining pane inserts, and change the workspace update test from canvas offsets to the layout:

```ts
  it("updates the layout and deletes", async () => {
    const created = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W", description: null });
    const updated = await workspaces.update(created.id, { layoutJson: '{"grid":{}}' });
    expect(updated?.layoutJson).toBe('{"grid":{}}');

    await workspaces.delete(created.id);
    expect(await workspaces.findByIdForUser(created.id, "u1")).toBeUndefined();
  });
```

- [ ] **Step 7: Verify and commit**

```bash
cd apps/backend && bun test src/db
cd /Users/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/db
git commit -m "refactor(workspaces)!: store a layout tree instead of pane geometry

dockview owns the split tree, so workspace_panes keeps only identity and
the workspace gains one layout_json column. Migration 0006 is rewritten in
place — no released consumers, so an existing DB is recreated. Both FK
cascades and their tests are unchanged; they remain the whole
dangling-pane strategy."
```

---

### Task 2: Layout pruning (pure, backend)

The server is the arbiter when `layout_json` and the pane rows disagree — a session delete cascades a pane away without touching the layout. This task builds that logic as a pure function, tested, before any route uses it.

**Files:**
- Create: `apps/backend/src/api/workspace-layout.ts`
- Create: `apps/backend/src/api/__tests__/workspace-layout.test.ts`

**Interfaces:**
- Produces:
```ts
export interface SerializedLayout { [key: string]: unknown }
export function panelIdsInLayout(layout: unknown): string[];
export function pruneLayout(layout: unknown, livePaneIds: ReadonlySet<string>): SerializedLayout | null;
```

- [ ] **Step 1: Confirm dockview's serialized shape before writing code against it**

The pruning logic depends on the exact shape of `api.toJSON()`. **Do not assume it — print one.** Add a scratch file outside the repo, run it with the app's own dockview version, and read the output:

```bash
cd apps/frontend && bunx tsx --version 2>/dev/null; \
node -e "console.log(Object.keys(require('dockview-core/package.json').exports ?? {}))" 2>/dev/null || true
```

Then confirm against dockview's docs at https://dockview.dev/docs/core/layout/ — the serialized object is expected to be:

```jsonc
{
  "grid": {
    "root": { "type": "branch", "data": [ { "type": "leaf", "data": { "views": ["panel-1"], "activeView": "panel-1" }, "size": 500 } ] },
    "width": 1000, "height": 800, "orientation": "HORIZONTAL"
  },
  "panels": { "panel-1": { "id": "panel-1", "contentComponent": "session", "params": {} } },
  "activeGroup": "1"
}
```

**If the real shape differs from this, update the tests and implementation in this task to match what you observed, and say so in your report.** Everything downstream depends on getting this right, and a wrong guess here is silent.

- [ ] **Step 2: Write the failing tests**

Create `apps/backend/src/api/__tests__/workspace-layout.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { panelIdsInLayout, pruneLayout } from "@/api/workspace-layout.js";

/** A two-pane layout: one leaf with both panels side by side. */
function twoPaneLayout() {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          { type: "leaf", data: { views: ["a"], activeView: "a" }, size: 500 },
          { type: "leaf", data: { views: ["b"], activeView: "b" }, size: 500 },
        ],
      },
      width: 1000,
      height: 800,
      orientation: "HORIZONTAL",
    },
    panels: { a: { id: "a" }, b: { id: "b" } },
    activeGroup: "1",
  };
}

describe("panelIdsInLayout", () => {
  it("lists every panel id", () => {
    expect(panelIdsInLayout(twoPaneLayout()).sort()).toEqual(["a", "b"]);
  });

  it("returns nothing for a null or malformed layout", () => {
    expect(panelIdsInLayout(null)).toEqual([]);
    expect(panelIdsInLayout({ nonsense: true })).toEqual([]);
    expect(panelIdsInLayout("not an object")).toEqual([]);
  });
});

describe("pruneLayout", () => {
  it("leaves a layout alone when every panel still has a pane", () => {
    const layout = twoPaneLayout();
    expect(pruneLayout(layout, new Set(["a", "b"]))).toEqual(layout);
  });

  it("drops a panel whose pane row is gone, and its now-empty leaf", () => {
    const pruned = pruneLayout(twoPaneLayout(), new Set(["a"]));
    expect(panelIdsInLayout(pruned)).toEqual(["a"]);
    expect(pruned?.panels).toEqual({ a: { id: "a" } });
    // The leaf holding "b" is removed rather than left empty.
    const root = (pruned as any).grid.root;
    expect(root.data).toHaveLength(1);
  });

  it("returns null when every panel is gone", () => {
    expect(pruneLayout(twoPaneLayout(), new Set())).toBeNull();
  });

  it("keeps a multi-view leaf and only removes the dead view", () => {
    const layout = {
      grid: {
        root: { type: "branch", data: [{ type: "leaf", data: { views: ["a", "b"], activeView: "b" }, size: 1000 }] },
        width: 1000,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: { a: { id: "a" }, b: { id: "b" } },
    };
    const pruned = pruneLayout(layout, new Set(["a"])) as any;
    expect(pruned.grid.root.data[0].data.views).toEqual(["a"]);
    // activeView pointed at the removed panel and must be repaired.
    expect(pruned.grid.root.data[0].data.activeView).toBe("a");
  });

  it("returns null for a malformed layout rather than throwing", () => {
    expect(pruneLayout("garbage", new Set(["a"]))).toBeNull();
    expect(pruneLayout(null, new Set(["a"]))).toBeNull();
  });
});
```

- [ ] **Step 3: Run and watch it fail**

```bash
cd apps/backend && bun test src/api/__tests__/workspace-layout.test.ts
```
Expected: FAIL — `Cannot find module '@/api/workspace-layout.js'`.

- [ ] **Step 4: Implement**

Create `apps/backend/src/api/workspace-layout.ts`:

```ts
/** dockview's serialized layout. Treated as opaque apart from the two fields we prune. */
export interface SerializedLayout {
  [key: string]: unknown;
}

/** A grid node: either a branch of more nodes, or a leaf holding panel ids. */
interface GridNode {
  type?: string;
  data?: GridNode[] | { views?: string[]; activeView?: string };
  size?: number;
}

/** True when the value is a non-null object (and not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every panel id referenced by a serialized layout.
 *
 * Reads the `panels` map rather than walking the grid: dockview keys that map
 * by panel id, so it is the authoritative list and cannot disagree with itself.
 *
 * @param layout - A serialized dockview layout, or anything at all
 * @returns The panel ids, or an empty array if the input is not a layout
 */
export function panelIdsInLayout(layout: unknown): string[] {
  if (!isRecord(layout) || !isRecord(layout.panels)) return [];
  return Object.keys(layout.panels);
}

/**
 * Removes panels whose pane row no longer exists, and any leaf or branch left
 * empty by their removal.
 *
 * This is the server's half of keeping `layout_json` honest against
 * `workspace_panes`: a session delete cascades a pane away without touching the
 * stored layout, so the layout is filtered on read rather than swept in the
 * background.
 *
 * @param layout - The stored layout
 * @param livePaneIds - Ids of the panes that still exist
 * @returns The pruned layout, or null if it is malformed or nothing survives
 */
export function pruneLayout(layout: unknown, livePaneIds: ReadonlySet<string>): SerializedLayout | null {
  if (!isRecord(layout) || !isRecord(layout.panels) || !isRecord(layout.grid)) return null;

  const survivors = Object.keys(layout.panels).filter((id) => livePaneIds.has(id));
  if (survivors.length === 0) return null;

  const panels: Record<string, unknown> = {};
  for (const id of survivors) panels[id] = (layout.panels as Record<string, unknown>)[id];

  const root = pruneNode((layout.grid as Record<string, unknown>).root, livePaneIds);
  if (!root) return null;

  return { ...layout, grid: { ...(layout.grid as Record<string, unknown>), root }, panels };
}

/** Prunes one grid node, returning null when nothing in it survives. */
function pruneNode(node: unknown, live: ReadonlySet<string>): GridNode | null {
  if (!isRecord(node)) return null;
  const typed = node as GridNode;

  if (Array.isArray(typed.data)) {
    const children = typed.data.map((child) => pruneNode(child, live)).filter((c): c is GridNode => c !== null);
    if (children.length === 0) return null;
    return { ...typed, data: children };
  }

  if (isRecord(typed.data)) {
    const views = Array.isArray(typed.data.views) ? typed.data.views.filter((v) => live.has(v)) : [];
    if (views.length === 0) return null;
    // activeView may name a removed panel; fall back to the first survivor.
    const activeView = typeof typed.data.activeView === "string" && views.includes(typed.data.activeView)
      ? typed.data.activeView
      : views[0];
    return { ...typed, data: { ...typed.data, views, activeView } };
  }

  return null;
}
```

- [ ] **Step 5: Run the tests**

```bash
cd apps/backend && bun test src/api/__tests__/workspace-layout.test.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 6: Verify and commit**

```bash
cd /Users/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/api/workspace-layout.ts apps/backend/src/api/__tests__/workspace-layout.test.ts
git commit -m "feat(workspaces): prune dangling panels from a stored layout

A session delete cascades its pane away without touching layout_json, so
the layout is filtered against surviving panes on read. Pure and tested
before any route depends on it, including the malformed-input paths."
```

---

### Task 3: Backend route — the layout endpoint and reconciliation

**Files:**
- Modify: `apps/backend/src/api/workspaces.route.ts`
- Modify: `apps/backend/src/api/models.ts`
- Modify: `apps/backend/src/api/__tests__/workspaces-route.test.ts`

**Interfaces:**
- Consumes: `pruneLayout`, `panelIdsInLayout` (Task 2); `WorkspaceTable.layoutJson` (Task 1).
- Produces: `PUT /api/workspaces/:id/layout` (operationId `saveWorkspaceLayout`); `GET /:id` returning `{ workspace: { …, layout }, panes }` with geometry gone.

- [ ] **Step 1: Update the route tests first**

In `workspaces-route.test.ts`:

Delete the geometry assertions from the existing bulk-save test and replace that test with two:

```ts
  it("saves and returns a layout, pruning panels whose pane is gone", async () => {
    const token = await signIn(ownerEmail, password);
    const id = await createWorkspace(token, `layout-${crypto.randomUUID().slice(0, 8)}`);
    const sessionId = await makeSession(ownerId);
    const paneRes = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes`, token, {
        method: "POST",
        body: JSON.stringify({ sessionId }),
      }),
    );
    const paneId = ((await paneRes.json()) as { id: string }).id;

    // A layout naming the real pane plus one that no longer exists.
    const layout = {
      grid: {
        root: {
          type: "branch",
          data: [
            { type: "leaf", data: { views: [paneId], activeView: paneId }, size: 500 },
            { type: "leaf", data: { views: ["ghost"], activeView: "ghost" }, size: 500 },
          ],
        },
        width: 1000,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: { [paneId]: { id: paneId }, ghost: { id: "ghost" } },
    };
    const put = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/layout`, token, { method: "PUT", body: JSON.stringify({ layout }) }),
    );
    expect(put.status).toBe(200);

    const read = await workspaceRoutes.fetch(authedRequest(`/api/workspaces/${id}`, token));
    const body = (await read.json()) as { workspace: { layout: { panels: Record<string, unknown> } | null } };
    // "ghost" had no pane row and must not come back.
    expect(Object.keys(body.workspace.layout?.panels ?? {})).toEqual([paneId]);
  });

  it("another user's layout save -> 404 (not 403)", async () => {
    const ownerToken = await signIn(ownerEmail, password);
    const otherToken = await signIn(otherEmail, password);
    const id = await createWorkspace(ownerToken, `lay404-${crypto.randomUUID().slice(0, 8)}`);
    const res = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/layout`, otherToken, {
        method: "PUT",
        body: JSON.stringify({ layout: { grid: {}, panels: {} } }),
      }),
    );
    expect(res.status).toBe(404);
  });
```

The `addWorkspacePane` calls throughout the file lose their geometry — the body is now just `{ sessionId }`.

**Leave the ownership tests exactly as they are.** They are the security property this route exists to protect.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/backend && bun test src/api/__tests__/workspaces-route.test.ts
```
Expected: FAIL — `PUT /:id/layout` 404s (no such route) and the pane POST rejects the body shape.

- [ ] **Step 3: Update the schemas in `models.ts`**

`WorkspaceSchema`: replace `canvasX`/`canvasY` with

```ts
  layout: t.Union([t.Any({ description: "Serialized dockview layout tree" }), t.Null()], {
    description: "Saved tiling layout, or null when none has been saved yet",
  }),
```

`WorkspacePaneSchema`: delete `x`, `y`, `width`, `height`, `zIndex`, `collapsed`. Everything else — `id`, `sessionId`, `sessionName`, `sessionStatus`, `sessionAlive`, `workingDir` — stays, each keeping its `description`.

- [ ] **Step 4: Rewrite the route's three affected handlers**

In `workspaces.route.ts`:

Replace `AddPaneBodySchema` with:

```ts
const AddPaneBodySchema = t.Object({
  sessionId: t.String({ minLength: 1, description: "Session to render in the new pane" }),
});
```

Replace `SaveLayoutBodySchema` with:

```ts
const SaveLayoutBodySchema = t.Object({
  layout: t.Any({ description: "Serialized dockview layout tree, as produced by its toJSON()" }),
});
```

`GET /:id` — build the pane views without geometry, then prune the layout against the surviving pane ids:

```ts
      const paneRows = await new WorkspacePanesRepository(db).listByWorkspace(workspace.id);
      const sessionsRepo = new SessionsRepository(db);
      const panes: WorkspacePaneView[] = [];
      for (const pane of paneRows) {
        const session = await sessionsRepo.findById(pane.sessionId);
        // The FK cascade means the session always exists; the guard keeps the
        // types honest rather than covering a real case.
        if (!session) continue;
        panes.push({
          id: pane.id,
          sessionId: pane.sessionId,
          sessionName: session.name,
          sessionStatus: session.status,
          sessionAlive: session.alive === 1,
          workingDir: session.workingDir,
        });
      }

      // layout_json is not touched when a session delete cascades a pane away,
      // so it is filtered against the surviving panes here rather than swept.
      const stored = workspace.layoutJson ? safeParse(workspace.layoutJson) : null;
      const layout = pruneLayout(stored, new Set(panes.map((p) => p.id)));

      return { workspace: { ...workspace, layout }, panes };
```

Add the parse helper near `isUniqueViolation`:

```ts
/** Parses stored layout JSON, treating anything unparseable as "no layout". */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
```

Replace the `PUT /:id/panes` handler with `PUT /:id/layout`, keeping the same ownership resolution:

```ts
  .put(
    "/:id/layout",
    async ({ params, body, user }) => {
      const repo = new WorkspacesRepository(db);
      const workspace = await repo.findByIdForUser(params.id, user.id);
      if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);
      await repo.update(params.id, { layoutJson: JSON.stringify(body.layout) });
      return { ok: true };
    },
    {
      body: SaveLayoutBodySchema,
      response: t.Object({ ok: t.Boolean({ description: "Always true" }) }),
      detail: {
        operationId: "saveWorkspaceLayout",
        tags: ["workspaces"],
        description: "Saves the workspace's tiling layout",
      },
    },
  )
```

`POST /:id/panes` drops the geometry from its `create` call and its z-index computation entirely — it becomes `{ id: crypto.randomUUID(), workspaceId: workspace.id, sessionId: body.sessionId }`.

Update `WorkspacePaneView` to drop the geometry fields, and import `pruneLayout` from `@/api/workspace-layout.js`.

- [ ] **Step 5: Run the tests**

```bash
cd apps/backend && bun test src/api/__tests__/workspaces-route.test.ts
```
Expected: PASS. The ownership tests, the cross-user pane test and the pane-delete test all still pass unchanged.

- [ ] **Step 6: Rebuild the client types and verify**

```bash
cd /Users/theo/projects/mote && turbo build
bun run verify-types && bun run lint:check && bun run test
```
`turbo build` is required — the Eden client infers from the backend's `App` type, so the frontend cannot see `PUT /:id/layout` until the backend rebuilds. Expect frontend type errors at this point from the canvas code still reading `pane.x` — that is expected and Task 8 removes it. **If `verify-types` fails only inside the files Task 8 deletes, that is acceptable here; note it in your report and continue.**

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/api
git commit -m "feat(workspaces): replace the geometry save with a layout endpoint

PUT /:id/layout stores dockview's serialized tree; GET /:id prunes it
against the surviving pane rows so a cascaded delete cannot leave a
dangling panel reference. Ownership still resolves through
findByIdForUser and answers 404, never 403."
```

---

### Task 4: Client types, layout helpers, breakpoint

**Files:**
- Modify: `apps/frontend/src/types/workspace.ts`
- Create: `apps/frontend/src/lib/workspace-layout.ts`, `apps/frontend/src/lib/__tests__/workspace-layout.test.ts`
- Create: `apps/frontend/src/lib/breakpoints.ts`
- Create: `apps/frontend/src/hooks/use-is-wide.ts`

**Interfaces:**
- Produces:
```ts
// types/workspace.ts
export interface WorkspaceRow { id; name; description; layout: unknown | null; createdAt; updatedAt }
export interface WorkspacePaneRow { id; sessionId; sessionName; sessionStatus: SessionStatus; sessionAlive; workingDir }
export interface WorkspaceDetail { workspace: WorkspaceRow; panes: WorkspacePaneRow[] }
// lib/workspace-layout.ts
export function panelIdsInLayout(layout: unknown): string[];
export function panesMissingFromLayout(layout: unknown, panes: WorkspacePaneRow[]): WorkspacePaneRow[];
// lib/breakpoints.ts
export const WORKSPACE_TILING_MIN_WIDTH = 1024;
// hooks/use-is-wide.ts
export function useIsWide(): boolean;
```

- [ ] **Step 1: Write the failing helper tests**

Create `apps/frontend/src/lib/__tests__/workspace-layout.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { panelIdsInLayout, panesMissingFromLayout } from "../workspace-layout";
import type { WorkspacePaneRow } from "@/types/workspace";

function pane(id: string): WorkspacePaneRow {
  return {
    id,
    sessionId: `s-${id}`,
    sessionName: id,
    sessionStatus: "running",
    sessionAlive: true,
    workingDir: "/tmp",
  };
}

const layout = { grid: {}, panels: { a: { id: "a" } } };

describe("panelIdsInLayout", () => {
  it("lists panel ids", () => {
    expect(panelIdsInLayout(layout)).toEqual(["a"]);
  });

  it("treats a null or malformed layout as empty", () => {
    expect(panelIdsInLayout(null)).toEqual([]);
    expect(panelIdsInLayout({})).toEqual([]);
  });
});

describe("panesMissingFromLayout", () => {
  it("returns panes the layout does not mention", () => {
    expect(panesMissingFromLayout(layout, [pane("a"), pane("b")]).map((p) => p.id)).toEqual(["b"]);
  });

  it("returns every pane when there is no layout at all", () => {
    expect(panesMissingFromLayout(null, [pane("a"), pane("b")]).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("returns nothing when the layout covers every pane", () => {
    expect(panesMissingFromLayout(layout, [pane("a")])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/frontend && bun test src/lib/__tests__/workspace-layout.test.ts
```
Expected: FAIL — cannot resolve `../workspace-layout`.

- [ ] **Step 3: Write the client types**

In `types/workspace.ts`, `WorkspaceRow` drops `canvasX`/`canvasY` and gains:

```ts
  /** Saved dockview layout tree, or null when none has been saved yet */
  layout: unknown | null;
```

`WorkspacePaneRow` drops `x`, `y`, `width`, `height`, `zIndex`, `collapsed`, keeping identity plus the joined session summary. Update its doc comment from "One window on a workspace canvas" to "One pane in a workspace's tiling layout".

- [ ] **Step 4: Write the helpers**

Create `apps/frontend/src/lib/workspace-layout.ts`:

```ts
import type { WorkspacePaneRow } from "@/types/workspace";

/** True when the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every panel id referenced by a serialized dockview layout.
 *
 * @param layout - A serialized layout, or anything at all
 * @returns The panel ids, empty if the input is not a layout
 */
export function panelIdsInLayout(layout: unknown): string[] {
  if (!isRecord(layout) || !isRecord(layout.panels)) return [];
  return Object.keys(layout.panels);
}

/**
 * Panes that exist server-side but have no panel in the stored layout — added
 * from another device, or from the narrow presentation which never writes the
 * layout. The caller appends them as tabs in the active group.
 *
 * The mirror of the server's pruning: the server drops panels with no pane,
 * this finds panes with no panel.
 *
 * @param layout - The stored layout, possibly null
 * @param panes - The panes the server returned
 * @returns The panes to append, in server order
 */
export function panesMissingFromLayout(layout: unknown, panes: WorkspacePaneRow[]): WorkspacePaneRow[] {
  const known = new Set(panelIdsInLayout(layout));
  return panes.filter((p) => !known.has(p.id));
}
```

Create `apps/frontend/src/lib/breakpoints.ts`:

```ts
/**
 * Minimum viewport width, in pixels, at which a workspace tiles.
 *
 * Below this the workspace renders as tabs instead: 80 columns at the app's
 * 13px terminal font is roughly 640px, so a phone cannot usefully tile
 * terminals and a portrait tablet gives neither pane enough room to read.
 *
 * Both presentations import this constant so they cannot disagree about which
 * one is active.
 */
export const WORKSPACE_TILING_MIN_WIDTH = 1024;
```

Create `apps/frontend/src/hooks/use-is-wide.ts`:

```ts
import { useEffect, useState } from "react";
import { WORKSPACE_TILING_MIN_WIDTH } from "@/lib/breakpoints";

/**
 * True when the viewport is wide enough to tile (see
 * {@link WORKSPACE_TILING_MIN_WIDTH}). Updates on resize and orientation
 * change, so rotating a tablet switches presentation.
 */
export function useIsWide(): boolean {
  const query = `(min-width: ${WORKSPACE_TILING_MIN_WIDTH}px)`;
  const [wide, setWide] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mql.addEventListener("change", onChange);
    setWide(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return wide;
}
```

- [ ] **Step 5: Run the tests, verify, commit**

```bash
cd apps/frontend && bun test src/lib/__tests__/workspace-layout.test.ts
cd /Users/theo/projects/mote && bun run lint:check
git add apps/frontend/src/types/workspace.ts apps/frontend/src/lib/workspace-layout.ts apps/frontend/src/lib/__tests__/workspace-layout.test.ts apps/frontend/src/lib/breakpoints.ts apps/frontend/src/hooks/use-is-wide.ts
git commit -m "feat(workspaces): client layout helpers and the tiling breakpoint

panesMissingFromLayout is the mirror of the server's pruning: the server
drops panels with no pane, this finds panes with no panel — which is how a
pane added from a phone reaches the desktop's tree."
```

`verify-types` still fails inside the canvas files this plan deletes in Task 8; that is expected until the cutover.

---

### Task 5: dockview dependency and `<SessionPane>`

**Files:**
- Modify: `apps/frontend/package.json`
- Create: `apps/frontend/src/components/session-pane.tsx`

**Interfaces:**
- Consumes: `SessionTerminal` (`@/components/session-terminal`), `WorkspacePaneRow` (Task 4). It does **not** use `session-confirmations` — Terminate and Delete live on the maximized header in Task 6, not in the pane body.
- Produces:
```ts
export interface SessionPaneProps {
  pane: WorkspacePaneRow;
  active: boolean;
  onRestart: (sessionId: string) => void;
  onRemovePane: (paneId: string) => void;
}
export function SessionPane(props: SessionPaneProps): JSX.Element;
```

- [ ] **Step 1: Install dockview, pinned**

```bash
cd apps/frontend && bun add dockview-react@8.2.0
```

Confirm it landed pinned (no `^`) — the pre-commit hook fails otherwise:

```bash
bun -e 'console.log(require("./package.json").dependencies["dockview-react"])'
```
Expected: `8.2.0`

**Note:** the React bindings live in `dockview-react`, not `dockview`. As of v8 the `dockview` package is a bare re-export of `dockview-core` with no React components in it. Importing from `dockview` will not give you `DockviewReact`.

- [ ] **Step 2: Record the bundle size before**

```bash
cd apps/frontend && bun run build 2>&1 | grep -E "sessions_\._id|index-" | tail -3
```
Write the numbers into your report. The spec asks for a before/after comparison and flags a regression beyond ~150 KB gzipped.

- [ ] **Step 3: Write the pane body**

Create `apps/frontend/src/components/session-pane.tsx`. It is only the *content* of a dockview panel — dockview supplies the frame, tab, title and close control, so there are no drag handlers, no resize handles, no hover transform and no z-index here.

```tsx
import { RotateCcw, Trash2 } from "lucide-react";
import { SessionTerminal } from "@/components/session-terminal";
import { Button } from "@/components/ui/button";
import type { WorkspacePaneRow } from "@/types/workspace";

/** Props for {@link SessionPane}. */
export interface SessionPaneProps {
  /** The pane row, with its session's summary joined in */
  pane: WorkspacePaneRow;
  /** False for a background tab; forwarded to the terminal's `active` */
  active: boolean;
  /** Restarts the pane's session (exited/terminated only) */
  onRestart: (sessionId: string) => void;
  /** Removes the pane from the workspace, leaving the session alone */
  onRemovePane: (paneId: string) => void;
}

/**
 * The content of one dockview panel: a live terminal, or a compact panel when
 * the session is no longer running.
 *
 * `active` comes from dockview's visibility, so a background tab detaches its
 * socket and releases its WebGL context — the same benefit the canvas's
 * viewport virtualization provided, with a far simpler rule.
 */
export function SessionPane({ pane, active, onRestart, onRemovePane }: SessionPaneProps) {
  const exited = pane.sessionStatus === "running" && !pane.sessionAlive;
  const gone = exited || pane.sessionStatus === "terminated";

  if (gone) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-muted-foreground text-sm">
            {exited ? "Session exited" : "Session ended"}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onRestart(pane.sessionId)}>
              <RotateCcw className="mr-1 h-3 w-3" /> Restart
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onRemovePane(pane.id)}>
              <Trash2 className="mr-1 h-3 w-3" /> Remove pane
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-[#0f1216]">
      {/* showStatePanels={false}: this component owns the non-running states
          above, so the terminal must not render a second, larger set. */}
      <SessionTerminal sessionId={pane.sessionId} active={active} showUploads showStatePanels={false} />
    </div>
  );
}
```

- [ ] **Step 4: Verify and commit**

```bash
bun run lint:check
git add apps/frontend/package.json apps/frontend/src/components/session-pane.tsx bun.lock
git commit -m "feat(workspaces): add dockview and the pane body

SessionPane is only a panel's content — dockview owns the frame, so the
drag, resize, hover and z-index logic the canvas pane carried is simply
absent rather than reimplemented."
```

---

### Task 6: `<WorkspaceDock>` — the wide presentation

**Files:**
- Create: `apps/frontend/src/components/workspace-dock.tsx`

**Interfaces:**
- Consumes: `SessionPane` (Task 5), `useDebouncedSave` (`@/hooks/use-debounced-save`), `panesMissingFromLayout` (Task 4), `WorkspaceDetail` (Task 4), `apiFetch`.
- Produces:
```ts
export interface WorkspaceDockProps {
  detail: WorkspaceDetail;
  onRefetch: () => void;
}
export function WorkspaceDock(props: WorkspaceDockProps): JSX.Element;
```

- [ ] **Step 1: Build the dock**

Create `apps/frontend/src/components/workspace-dock.tsx`. The essentials, each of which has a reason:

```tsx
const LAYOUT_SAVE_DEBOUNCE_MS = 800;

const components = {
  session: (props: IDockviewPanelProps<{ paneId: string }>) => <DockedPane {...props} />,
};
```

- **Panels are added with `renderer: "always"`.** This is the setting that keeps the DOM alive and the terminal undisposed when a panel is hidden or moved. Do not omit it and do not switch it to `onlyWhenVisible`.
- **`active` comes from dockview, not from geometry.** Inside the panel component, subscribe to `props.api.onDidVisibilityChange` and seed from `props.api.isVisible`:

```tsx
  const [visible, setVisible] = useState(props.api.isVisible);
  useEffect(() => {
    const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [props.api]);
```

- **Restore the saved layout once, on ready**, then append any pane the layout does not mention:

```tsx
  function onReady(event: DockviewReadyEvent) {
    apiRef.current = event.api;
    if (detail.workspace.layout) {
      try {
        event.api.fromJSON(detail.workspace.layout as Parameters<typeof event.api.fromJSON>[0]);
      } catch {
        // A layout we cannot restore is not worth losing the workspace over —
        // fall through and lay the panes out fresh.
      }
    }
    for (const pane of panesMissingFromLayout(detail.workspace.layout, detail.panes)) {
      addPanel(event.api, pane);
    }
  }
```

- **Save on layout change, debounced:**

```tsx
  const save = useDebouncedSave<unknown>(
    (layout, signal) =>
      apiFetch(`/api/workspaces/${detail.workspace.id}/layout`, {
        method: "PUT",
        body: JSON.stringify({ layout }),
        signal,
      }),
    LAYOUT_SAVE_DEBOUNCE_MS,
  );
```

wired to `api.onDidLayoutChange(() => save.schedule(api.toJSON()))`.

- **`addPanel` is one helper**, used by ready, by the picker (Task 7) and by restart:

```tsx
  /** Adds a panel for a pane, optionally splitting from a reference panel. */
  function addPanel(api: DockviewApi, pane: WorkspacePaneRow, position?: AddPanelPositionOptions) {
    api.addPanel({
      id: pane.id,
      component: "session",
      title: pane.sessionName,
      renderer: "always",
      params: { paneId: pane.id },
      ...(position ? { position } : {}),
    });
  }
```

- **The panel reads its pane from the live `detail`, not from `params`.** Params are captured at add time and would go stale as the 5s poll refreshes session status. Look the pane up by `paneId` on each render and render nothing if it has vanished (the poll saw a cascade).

- **Restart repoints in place**, add-then-remove so a mid-sequence failure leaves the old pane visible rather than the window vanishing:

```tsx
  async function handleRestart(sessionId: string) {
    try {
      const created = await apiFetch<{ id: string }>(`/api/sessions/${sessionId}/restart`, { method: "POST" });
      const pane = await apiFetch<{ id: string }>(`/api/workspaces/${detail.workspace.id}/panes`, {
        method: "POST",
        body: JSON.stringify({ sessionId: created.id }),
      });
      const old = detail.panes.find((p) => p.sessionId === sessionId);
      if (old) {
        apiRef.current?.getPanel(old.id)?.api.close();
        await apiFetch(`/api/workspaces/${detail.workspace.id}/panes/${old.id}`, { method: "DELETE" });
      }
      void pane;
      onRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restart failed");
    }
  }
```

- **Every async handler catches.** `apiFetch` throws on any non-2xx; a button that silently does nothing on failure was a review finding in the canvas work. Surface a message.

- **Maximize replaces expand.** Wire a header action to `api.group.api.maximize()` / `exitMaximized()` — dockview's own zoom, needing no re-parenting.

- [ ] **Step 2: Put the heavy chrome on the maximized header**

Per the spec, the actions that do not fit in a small pane appear once a group is maximized:
**Terminate** (running sessions), **Delete** (exited or terminated), and **`<TranscriptSearch>`**.

Use `rightHeaderActionsComponent` on `<DockviewReact>`, rendering the actions only when
`api.group.api.isMaximized` is true, and reading the group's active panel to know which session
they apply to.

Terminate and Delete **must** go through `@/lib/session-confirmations` — the same prompts
`useSessionActions` uses on `/sessions/:id`. Firing a destructive session action straight from a
click was a review finding in the canvas work; do not reintroduce it. Deleting a session removes
its pane through the FK cascade, so refetch afterwards rather than closing the panel by hand.

`<TranscriptSearch>` needs the terminal's search addon, which `SessionTerminal` publishes through
`onReady` and withdraws through `onDispose`. Hold it in the panel component and pass it up; treat a
null addon as "no finder available" rather than rendering a dead button.

- [ ] **Step 3: Verify and commit**

```bash
cd /Users/theo/projects/mote && bun run lint:check
git add apps/frontend/src/components/workspace-dock.tsx
git commit -m "feat(workspaces): dockview-backed tiling presentation

renderer:'always' and dockview's own visibility events replace the
canvas's viewport virtualization; a background tab frees its socket and
WebGL context, which is the same benefit under a much simpler rule."
```

---

### Task 7: `<SessionPicker>` — split menu, and drag where a pointer exists

**Files:**
- Create: `apps/frontend/src/components/session-picker.tsx`
- Modify: `apps/frontend/src/components/workspace-dock.tsx` (wire the drop handlers)

**Interfaces:**
- Consumes: `useProfiles` (`@/hooks/use-profiles`), `useMounts` (`@/hooks/use-mounts`), `SessionView` (`@/types/session`), `WorkspacePaneRow`.
- Produces:
```ts
/** Where a new pane goes relative to a reference pane. Matches dockview's
 *  `addPanel` direction vocabulary, NOT its drop-event vocabulary — see Step 2. */
export type SplitDirection = "left" | "right" | "above" | "below" | "within";
export interface SessionPickerProps {
  workspaceId: string;
  existing: WorkspacePaneRow[];
  onAdd: (sessionId: string, direction: SplitDirection, referencePaneId?: string) => Promise<void>;
}
export function SessionPicker(props: SessionPickerProps): JSX.Element;
export const WORKSPACE_DRAG_TYPE = "application/x-mote-session";
```

- [ ] **Step 1: Build the picker — the menu first**

The split menu is the **primary** path and must work with a mouse, a finger or a keyboard. It offers **Split right**, **Split down** and **Open as tab**, each opening a list of the caller's sessions not already on this canvas, plus **New session here** (the existing profile + mount dialog).

Every entry calls the same `onAdd(sessionId, direction, referencePaneId)`.

- [ ] **Step 2: Add drag as a pointer-only accelerator**

Session rows become `draggable` **only** when a fine pointer exists, so a touch device is never shown an affordance it cannot use:

```tsx
const canDrag = typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;
// …
<div
  draggable={canDrag}
  onDragStart={(e) => e.dataTransfer.setData(WORKSPACE_DRAG_TYPE, session.id)}
>
```

In `workspace-dock.tsx`, accept the drag so dockview shows its drop overlay, and handle the drop:

```tsx
  onUnhandledDragOverEvent={(event) => {
    if (event.nativeEvent.dataTransfer?.types.includes(WORKSPACE_DRAG_TYPE)) event.accept();
  }}
  onDidDrop={(event) => {
    const sessionId = event.nativeEvent.dataTransfer?.getData(WORKSPACE_DRAG_TYPE);
    if (!sessionId) return;
    void handleAdd(sessionId, directionFromDropPosition(event.position), event.group?.activePanel?.id);
  }}
```

**dockview uses two different vocabularies and they do not match.** The drop event reports
`'left' | 'right' | 'top' | 'bottom' | 'center'`, while `addPanel`'s direction takes
`'left' | 'right' | 'above' | 'below' | 'within'`. Passing one where the other is expected fails
silently — an invalid direction is ignored rather than throwing, which is exactly how a bad
`moveTo` call went unnoticed during the spike. Translate explicitly:

```tsx
/** Maps dockview's drop-event position onto its addPanel direction vocabulary. */
function directionFromDropPosition(position: string): SplitDirection {
  switch (position) {
    case "top": return "above";
    case "bottom": return "below";
    case "center": return "within";
    case "left": return "left";
    default: return "right";
  }
}
```

Both paths then converge on the same `onAdd`.

- [ ] **Step 3: One add path for all three entry points**

`handleAdd` POSTs `/api/workspaces/:id/panes` with `{ sessionId }`, adds the dockview panel at the requested position, saves the layout, and refetches.

**If the pane POST fails after a session was created by "New session here", surface the error and leave the session alone.** Deleting it to "clean up" would destroy a session the user just launched; it is reachable from `/` and attaching it is one more click.

- [ ] **Step 4: Verify and commit**

```bash
cd /Users/theo/projects/mote && bun run lint:check
git add apps/frontend/src/components/session-picker.tsx apps/frontend/src/components/workspace-dock.tsx
git commit -m "feat(workspaces): split menu, with drag as a pointer-only accelerator

The menu is the path everything relies on — it works with a mouse, a
finger or a keyboard. Drag is gated on (pointer: fine) because dockview's
docs note touch and pen drags cannot bridge to external HTML5 drop zones,
so a touch device is never shown a control it cannot use."
```

---

### Task 8: `<WorkspaceTabs>` — the narrow presentation

**Files:**
- Create: `apps/frontend/src/components/workspace-tabs.tsx`

**Interfaces:**
- Consumes: `SessionPane` (Task 5), `WorkspaceDetail`, `SessionPicker` (Task 7).
- Produces:
```ts
export interface WorkspaceTabsProps {
  detail: WorkspaceDetail;
  onRefetch: () => void;
}
export function WorkspaceTabs(props: WorkspaceTabsProps): JSX.Element;
```

- [ ] **Step 1: Build the tab strip**

A horizontally scrollable strip of the workspace's panes plus one `<SessionPane>` filling the rest of the viewport. dockview is **not** imported here at all.

Requirements, each with a reason:

- **`active` is true only for the selected tab.** On a phone that means exactly one socket and one WebGL context — the same rule the dock uses for background tabs.
- **Hit areas at least 44px.** Do not reuse the desktop's dense icon rows.
- **Tap to switch. No swipe gesture** — xterm owns horizontal touch-drag for text selection, and stealing it would break selection inside the terminal.
- **The selected tab is component state**, defaulting to the first pane, and clamped when the poll removes the pane that was selected.

```tsx
const [selectedId, setSelectedId] = useState<string | null>(null);
const selected = detail.panes.find((p) => p.id === selectedId) ?? detail.panes[0];
```

- [ ] **Step 2: Make the read-only-layout rule structural**

This component has **no** save path — it never imports `useDebouncedSave` and never calls `PUT /:id/layout`. Add a comment saying why, because the omission looks like an oversight otherwise:

```tsx
/**
 * The narrow presentation deliberately never writes `layout_json`. If it did,
 * opening a workspace on a phone would flatten a carefully split desktop
 * arrangement into a flat tab list, with no undo. Panes can be added, removed
 * and switched here; the split tree is left exactly as the desktop left it, and
 * a pane added here reaches the desktop through `panesMissingFromLayout`.
 */
```

Adding a pane still works — it POSTs `/panes` and refetches, exactly as the dock does.

- [ ] **Step 3: Verify and commit**

```bash
cd /Users/theo/projects/mote && bun run lint:check
git add apps/frontend/src/components/workspace-tabs.tsx
git commit -m "feat(workspaces): tabs presentation for tablet and phone

One session fills the viewport below the tiling breakpoint; only the
selected tab holds a socket. It never writes the layout, so a phone visit
cannot flatten a desktop arrangement."
```

---

### Task 9: Cutover — switch the route and delete the canvas

This is the task that makes the tree compile again. Nothing before it removed the canvas, so `verify-types` has been failing inside files this task deletes.

**Files:**
- Modify: `apps/frontend/src/routes/workspaces_.$id.tsx`
- Delete: `components/workspace-canvas.tsx`, `components/workspace-pane.tsx`, `components/add-pane-menu.tsx`, `hooks/use-pane-layout.ts`, `hooks/use-pane-visibility.ts`, `lib/canvas-geometry.ts`, `lib/__tests__/canvas-geometry.test.ts`

- [ ] **Step 1: Switch the route on the breakpoint**

```tsx
  const wide = useIsWide();
  // …
  return wide
    ? <WorkspaceDock detail={detail} onRefetch={refetch} />
    : <WorkspaceTabs detail={detail} onRefetch={refetch} />;
```

Keep the existing `!detail` guard for the not-found card. **Do not branch on `isError`** — in react-query v5 a failed background refetch sets `status: "error"` while `data` is still good, and swapping the tree would unmount every terminal over a network blip. That was a review finding in the canvas work and the same trap exists here.

- [ ] **Step 2: Delete the canvas**

```bash
cd /Users/theo/projects/mote
git rm apps/frontend/src/components/workspace-canvas.tsx \
       apps/frontend/src/components/workspace-pane.tsx \
       apps/frontend/src/components/add-pane-menu.tsx \
       apps/frontend/src/hooks/use-pane-layout.ts \
       apps/frontend/src/hooks/use-pane-visibility.ts \
       apps/frontend/src/lib/canvas-geometry.ts \
       apps/frontend/src/lib/__tests__/canvas-geometry.test.ts
```

- [ ] **Step 3: Confirm nothing references the deleted modules**

```bash
grep -rn "canvas-geometry\|use-pane-layout\|use-pane-visibility\|workspace-canvas\|workspace-pane\|add-pane-menu" apps/frontend/src || echo "clean"
```
Expected: `clean`.

- [ ] **Step 4: Recreate the database and run the full gate**

```bash
rm -f data/mote.db*
bun run verify-types && bun run lint:check && bun run test && turbo build
```
Expected: all pass. This is the first point in the plan where `verify-types` is green.

- [ ] **Step 5: Record the bundle size after**

```bash
cd apps/frontend && bun run build 2>&1 | grep -E "sessions_\._id|index-" | tail -3
```
Compare with Task 5 Step 2. Report the delta; flag it if the gzipped growth exceeds ~150 KB.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(workspaces)!: tiling replaces the free-form canvas

Deletes the canvas, its pane component, the layout and visibility hooks
and the geometry maths — about 1,000 lines — and routes to the dock above
the breakpoint and tabs below it. Virtualization dissolves: tiled panes
are on screen by construction, so visibility is now just 'is this the
foreground tab'."
```

---

### Task 10: Theme dockview, document, and leave a standing probe

**Files:**
- Create: `apps/frontend/src/styles/dockview-theme.css` (or a Tailwind layer, matching how the app already loads CSS)
- Modify: `apps/frontend/src/routes/workspaces_.$id.tsx` (import the theme), `README.md`, `docs/overview.md`, `AGENTS.md`

- [ ] **Step 1: Theme the dock**

dockview ships `dockview-react/dist/styles/dockview.css` with a `dockview-theme-dark` class. Import it, then override its CSS variables to the app's palette — the terminal background is `#0f1216` and the canvas background was `#0a0c0f`. An unstyled dock against this app's dark theme is conspicuous, so treat this as real work rather than a formality: tab bar, active/inactive tab, the divider (sash) and the drop overlay all need checking.

- [ ] **Step 2: Update the docs**

`README.md` — replace the canvas bullet:

```markdown
- **Workspaces** — tile agent sessions side by side; split from any pane's menu, or
  drag a session onto the half of a pane it should take. On a tablet or phone the
  same workspace becomes tabs, one session at a time.
```

`docs/overview.md` — replace the workspaces row:

```markdown
| Workspaces | Per-user tiling layout of session panes via `dockview-react`; `layout_json` holds the split tree. Below 1024px it renders as tabs and never writes the layout, so a phone visit cannot flatten a desktop arrangement |
```

- [ ] **Step 3: Leave the standing dockview probe in `AGENTS.md`**

The no-remount property is a dependency's behaviour, not ours. A bump could regress it silently, and no automated test in this repo can catch it. Add to `AGENTS.md`, next to the migration note:

```markdown
### Upgrading `dockview-react`

Workspace panes hold live terminals. dockview must **not** remount a panel's
content when panels are moved or split — a remount disposes the terminal, closes
its WebSocket and forces a full history replay.

This was verified at 8.2.0 and is not covered by any automated test. After any
`dockview-react` upgrade, re-run the probe by hand:

1. Open a workspace with two or more panes and open DevTools → Network → WS.
2. Drag a pane onto another pane's edge to split, and drag a tab between groups.
3. **No new `/ws` connection may appear, and no existing one may close.**

If one does, the upgrade is not safe: pin back to the last known-good version.
Every panel must also keep `renderer: 'always'` — that is what keeps the DOM
alive when a panel is hidden.
```

- [ ] **Step 4: Full verification and manual drive**

```bash
bun run verify-types && bun run lint:check && bun run test && turbo build
bun run start
```

Then exercise it by hand — none of this is covered by automated tests:

1. Split from a pane's menu; split by dragging a session onto a pane's edge.
2. **Watch Network → WS while splitting and while dragging a tab between groups: no new socket, none closed.** This is the property the whole design rests on.
3. Reload and confirm the layout came back.
4. Narrow the window below 1024px: it becomes tabs, only the selected tab holds a socket.
5. **While narrow, add a pane and switch tabs, then widen again — the split tree must be exactly as you left it.** This is the read-only-layout rule.
6. Delete a session from `/sessions` and confirm its pane disappears from the workspace (the FK cascade plus pruning on read).
7. `/sessions/:id` sweep: `/` opens the palette and no `/` reaches the agent.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(workspaces): theme the dock, document tiling, add the upgrade probe

The no-remount guarantee belongs to dockview, not us, and no test here can
catch a regression — so AGENTS.md carries the manual probe to re-run on
any upgrade."
```

---

## Done when

- A workspace tiles sessions; splits come from a pane menu on any device and from a drag where a pointer exists.
- The layout survives a reload; a session delete removes its pane without stranding a dangling panel.
- Below 1024px the same workspace is tabs, only the foreground tab holds a socket, and the split tree is untouched by anything done there.
- Splitting and moving panes opens **no** new WebSocket.
- `bun run verify-types`, `bun run lint:check`, `bun run test` and `turbo build` all pass, and CI is green.
