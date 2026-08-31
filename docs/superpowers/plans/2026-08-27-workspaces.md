# Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace is a saved, per-user canvas of draggable windows, each holding one agent session, so an operator can watch and drive several sessions in one view.

**Architecture:** The xterm lifecycle is extracted from `sessions_.$id.tsx` into a reusable `<SessionTerminal>` whose `active` prop attaches or detaches the socket — that prop is what makes viewport virtualization possible. Two new tables (`workspaces`, `workspace_panes`) store per-user layout; both cascade on delete, which is the entire dangling-pane strategy. The canvas pans but never zooms: reading a pane closely is served by hovering (visual scale only) and clicking to expand (same terminal instance, bigger container).

**Tech Stack:** Bun, Elysia, Kysely + `bun:sqlite`, React 19, TanStack Router/Query, xterm 6, Tailwind + shadcn/ui (Base-UI), biome, turbo.

**Spec:** `docs/superpowers/specs/2026-08-27-workspaces-design.md`

## Global Constraints

- **Package manager is Bun only.** `bun install`, `bun run <script>`, `bunx`. Never npm/pnpm/yarn/npx.
- **No dynamic imports.** `await import(...)` breaks `bun build --compile`. Static top-level `import` only.
- **Pinned dependency versions** in every `package.json` — no `^` or `~`. This plan adds no new dependencies.
- **File size:** split beyond ~300-400 lines. Route components beyond ~200 lines move logic into `src/hooks/`, `src/components/`, `src/lib/`.
- **Every Elysia `t` schema property needs a `description`** — it generates the OpenAPI docs and the Eden client types.
- **JSDoc on every exported class, function, and interface property.**
- **Union types, not bare strings**, for fixed sets of values.
- **Migration file name and the `migrate.ts` provider-map key must match exactly** (`0006-workspaces`). The CLI scans the folder; the app's boot migrator reads the static map.
- **Verification after every task:** `bun run verify-types`, `bun run lint:check`, `bun run test`. All three must pass before commit.
- **Run `turbo build` after backend route/schema changes** — `@internal/backend-client` is an Eden Treaty client whose types are *inferred* from the backend's exported `App` type.
- **Commit style:** conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Enforced by commitlint.
- **Do not persist expansion state.** Opening a workspace always lands on the canvas.
- **The canvas has no zoom.** Do not add one.

---

## File Structure

**Task 1 — the enabling refactor (no workspace code):**
- Create `apps/frontend/src/components/session-terminal.tsx` — owns the xterm instance, its addons, the fit/ResizeObserver loop, the WS attach, uploads, and the connection state panels.
- Modify `apps/frontend/src/routes/sessions_.$id.tsx` — keeps header, session switcher, lifecycle actions, status polling, `/` palette, transcript search.

**Backend:**
- Create `apps/backend/src/db/migrations/0006-workspaces.ts` (+ `__tests__/0006-workspaces.test.ts`)
- Create `apps/backend/src/db/types/workspaces.db-types.ts`, `workspace-panes.db-types.ts`
- Create `apps/backend/src/db/repositories/workspaces.repository.ts`, `workspace-panes.repository.ts` (+ tests)
- Create `apps/backend/src/api/workspaces.route.ts` (+ `__tests__/workspaces-route.test.ts`)
- Modify `apps/backend/src/db/migrate.ts`, `db/types/index.ts`, `db/repositories/index.ts`, `api/models.ts`, `api/routes.ts`

**Frontend:**
- Create `apps/frontend/src/lib/canvas-geometry.ts` (+ `__tests__/canvas-geometry.test.ts`) — pure math
- Create `apps/frontend/src/lib/workspace-form.ts` (+ `__tests__/workspace-form.test.ts`)
- Create `apps/frontend/src/types/workspace.ts`
- Create `apps/frontend/src/hooks/use-workspaces.ts`, `use-workspace.ts`, `use-pane-layout.ts`
- Create `apps/frontend/src/components/workspace-canvas.tsx`, `workspace-pane.tsx`, `add-pane-menu.tsx`
- Create `apps/frontend/src/routes/workspaces.tsx`, `workspaces_.$id.tsx`
- Modify `apps/frontend/src/components/app-sidebar.tsx`

---

### Task 1: Extract `<SessionTerminal>` from the session route

This lands and is verified **on its own**, before any workspace code exists. It is a pure refactor: `/sessions/:id` must behave identically afterwards.

**Files:**
- Create: `apps/frontend/src/components/session-terminal.tsx`
- Modify: `apps/frontend/src/routes/sessions_.$id.tsx`

**Interfaces:**
- Consumes: `useSessionWs` (`@/lib/use-session-ws`), `useTerminalUploads` (`@/hooks/use-terminal-uploads`), `TerminalDropOverlay`, `SessionView` (`@/types/session`).
- Produces:
```ts
export interface SessionTerminalHandles {
  term: Terminal;
  serialize: SerializeAddon;
  search: SearchAddon;
}
export interface SessionTerminalProps {
  sessionId: string;
  session?: SessionView;          // drives the exited/terminated panels
  active?: boolean;              // default true; false = detach + snapshot
  showUploads?: boolean;         // default true
  onReady?: (h: SessionTerminalHandles) => void;
  onStatusChange?: (s: { connected: boolean; closed: boolean }) => void;
  onKeyDown?: (e: KeyboardEvent) => boolean;  // custom key handler passthrough
  onRestart?: () => void;
  onDelete?: () => void;
}
export function SessionTerminal(props: SessionTerminalProps): JSX.Element;
```

- [ ] **Step 1: Record the current behaviour you must preserve**

Read `apps/frontend/src/routes/sessions_.$id.tsx` end to end and write this list into your notes. These are the invariants:
1. `/` typed in the terminal opens the palette and the `/` does **not** reach the session. The handler calls `preventDefault()` **and** `stopPropagation()` and returns `false` — returning `false` alone is not enough, because xterm's keypress path would still emit the char via `onData`.
2. While the palette is open, every keystroke is swallowed; Ctrl/Meta/Alt or Escape cancels it.
3. A WS close code `>= 4000` is a server rejection → show the "Session is not running" panel. Any other close is transient → the hook reconnects and the "reconnecting…" pill shows.
4. `exited` means `session.status === "running" && session.alive === false` → exit-code panel with Restart/Delete.
5. The terminal is only rendered when `!exited && !closed`.

- [ ] **Step 2: Create the component with the terminal lifecycle**

Create `apps/frontend/src/components/session-terminal.tsx`. Move these verbatim out of the route: the `new Terminal({...})` options block, `FitAddon`/`SerializeAddon`/`SearchAddon` loading, the `WebglAddon` try/catch with `onContextLoss`, `term.open()`, the `ResizeObserver` → `fit()`, `term.write("")`, and the disposal cleanup.

```tsx
const TERMINAL_THEME = {
  background: "#0f1216",
  foreground: "#e4e4e7",
  cursor: "#8b8b90",
  selectionBackground: "#3b3b40",
} as const;

/** Terminal options shared by the full-page view and every workspace pane. */
const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 13,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  theme: TERMINAL_THEME,
  allowProposedApi: true,
  scrollback: 5000,
} as const;
```

The mount effect depends on `[active]`. When `active` is false, skip creating the terminal entirely and render the snapshot instead (Step 3).

- [ ] **Step 3: Implement detach-to-snapshot**

Before disposing (in the effect cleanup, and whenever `active` flips to false), capture the screen and keep it in state:

```tsx
const [snapshot, setSnapshot] = useState("");
// …in cleanup, before term.dispose():
setSnapshot(stripAnsi(serialize.serialize()));
```

`stripAnsi` comes from `@internal/backend-errors` — the route already imports it. When `active` is false render the snapshot, not a terminal:

```tsx
<pre className="h-full w-full overflow-hidden whitespace-pre p-2 font-mono text-[11px] text-muted-foreground">
  {snapshot}
</pre>
```

Disposing (not merely closing the socket) is the point: it is what releases the WebGL context.

- [ ] **Step 4: Point the route at the component**

In `sessions_.$id.tsx` delete the moved code and render `<SessionTerminal>`. Keep `termRef`/`serializeRef`/`search` in the route, populated from `onReady`, because `runCommand` and `TranscriptSearch` still need them. Keep `connected`/`closed` in the route, fed by `onStatusChange`. Pass the `/` palette key handler down via `onKeyDown`.

- [ ] **Step 5: Verify types, lint and tests**

```bash
bun run verify-types && bun run lint:check && bun run test
```
Expected: all pass. Note that no automated test covers this route — the next step is the real check.

- [ ] **Step 6: Drive the app and confirm every invariant from Step 1**

```bash
bun run start
```
Open `http://localhost:5174/sessions/<id>` and confirm, one at a time:
- output streams; typing reaches the agent
- `/` opens the palette and no `/` appears in the session; Esc cancels
- `/find` opens the finder and the match counter reads e.g. `1/1` (the xterm canvas renderer exposes no text nodes, so the counter is the authoritative check)
- dropping a file uploads it and injects the path
- terminating shows the exited panel with the right exit code
- restarting the backend shows "reconnecting…" and the terminal recovers on its own

- [ ] **Step 7: Confirm the route actually got smaller**

```bash
wc -l apps/frontend/src/routes/sessions_.\$id.tsx apps/frontend/src/components/session-terminal.tsx
```
Expected: the route is near ~200 lines (from 442), the component carries the rest.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/components/session-terminal.tsx apps/frontend/src/routes/sessions_.\$id.tsx
git commit -m "refactor(sessions): extract SessionTerminal from the session route

The xterm instance, its addons, the fit loop and the WS attach were inline
in a 442-line route, so nothing could render a second terminal. The new
component's \`active\` prop detaches the socket and disposes the terminal —
releasing its WebGL context — which is what workspace panes will use to
virtualize by viewport. Behaviour of /sessions/:id is unchanged."
```

---

### Task 2: Migration `0006-workspaces` and DB types

**Files:**
- Create: `apps/backend/src/db/migrations/0006-workspaces.ts`
- Create: `apps/backend/src/db/migrations/__tests__/0006-workspaces.test.ts`
- Create: `apps/backend/src/db/types/workspaces.db-types.ts`, `apps/backend/src/db/types/workspace-panes.db-types.ts`
- Modify: `apps/backend/src/db/migrate.ts`, `apps/backend/src/db/types/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `WorkspaceTable`, `NewWorkspace`, `WorkspaceUpdate`, `WorkspacePaneTable`, `NewWorkspacePane`, `WorkspacePaneUpdate`; `Database.workspaces`, `Database.workspacePanes`.

- [ ] **Step 1: Write the failing migration test**

Create `apps/backend/src/db/migrations/__tests__/0006-workspaces.test.ts`. The cascades are the whole dangling-pane strategy, so they are tested, not assumed.

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunSqliteDialect, openSqliteDatabase } from "@internal/sqlite-dialect";
import { CamelCasePlugin, type Generated, Kysely } from "kysely";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import { up as up006 } from "@/db/migrations/0006-workspaces.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  workspaces: {
    id: string;
    userId: string;
    name: string;
    description: string | null;
    canvasX: Generated<number>;
    canvasY: Generated<number>;
    createdAt: Generated<string>;
    updatedAt: Generated<string>;
  };
  workspacePanes: {
    id: string;
    workspaceId: string;
    sessionId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: Generated<number>;
    collapsed: Generated<number>;
    createdAt: Generated<string>;
    updatedAt: Generated<string>;
  };
}

describe("0006 workspaces migration", () => {
  let dbFile: string;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    dbFile = `/tmp/mote-006-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely({
      dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }),
      plugins: [new CamelCasePlugin()],
    });
    await initMigration.up(db);
    await operatorUxMigration.up(db);
    await remoteOpsMigration.up(db);
    await up006(db);
  });
  afterAll(() => {
    Bun.file(dbFile).unlink().catch(() => {});
    db.destroy().catch(() => {});
  });

  /** Inserts the profile + session rows a pane needs to point at. */
  async function seedSession(id: string): Promise<void> {
    const x = db.$extendTables<MigrationDatabase>();
    await x
      .insertInto("profiles")
      .values({
        id: `p-${id}`,
        userId: "u1",
        harnessId: "claude-code",
        name: `profile-${id}`,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
      })
      .execute();
    await x
      .insertInto("sessions")
      .values({
        id,
        userId: "u1",
        profileId: `p-${id}`,
        harnessId: "claude-code",
        name: `session-${id}`,
        workingDir: "/tmp",
        tmuxSocket: null,
      })
      .execute();
  }

  it("creates a workspace with canvas defaults", async () => {
    await db
      .$extendTables<MigrationDatabase>()
      .insertInto("workspaces")
      .values({ id: "w1", userId: "u1", name: "refactor", description: null })
      .execute();
    const row = await db
      .$extendTables<MigrationDatabase>()
      .selectFrom("workspaces")
      .select(["id", "name", "canvasX", "canvasY"])
      .where("id", "=", "w1")
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ id: "w1", name: "refactor", canvasX: 0, canvasY: 0 });
  });

  it("enforces a unique workspace name per user, but not across users", async () => {
    const x = db.$extendTables<MigrationDatabase>();
    await x.insertInto("workspaces").values({ id: "w2", userId: "u2", name: "dup", description: null }).execute();
    await expect(
      x.insertInto("workspaces").values({ id: "w3", userId: "u2", name: "dup", description: null }).execute(),
    ).rejects.toThrow();
    // A different user may reuse the name.
    await x.insertInto("workspaces").values({ id: "w4", userId: "u3", name: "dup", description: null }).execute();
  });

  it("deleting a workspace cascades to its panes", async () => {
    const x = db.$extendTables<MigrationDatabase>();
    await seedSession("s1");
    await x.insertInto("workspaces").values({ id: "w5", userId: "u1", name: "cascade-ws", description: null }).execute();
    await x
      .insertInto("workspacePanes")
      .values({ id: "pane1", workspaceId: "w5", sessionId: "s1", x: 0, y: 0, width: 600, height: 400 })
      .execute();

    await x.deleteFrom("workspaces").where("id", "=", "w5").execute();
    const panes = await x.selectFrom("workspacePanes").selectAll().where("id", "=", "pane1").execute();
    expect(panes).toHaveLength(0);
  });

  it("deleting a session cascades to the panes that reference it", async () => {
    const x = db.$extendTables<MigrationDatabase>();
    await seedSession("s2");
    await x.insertInto("workspaces").values({ id: "w6", userId: "u1", name: "cascade-sess", description: null }).execute();
    await x
      .insertInto("workspacePanes")
      .values({ id: "pane2", workspaceId: "w6", sessionId: "s2", x: 0, y: 0, width: 600, height: 400 })
      .execute();

    await x.deleteFrom("sessions").where("id", "=", "s2").execute();
    const panes = await x.selectFrom("workspacePanes").selectAll().where("id", "=", "pane2").execute();
    expect(panes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/backend && bun test src/db/migrations/__tests__/0006-workspaces.test.ts
```
Expected: FAIL — `Cannot find module '@/db/migrations/0006-workspaces.js'`.

- [ ] **Step 3: Write the migration**

Create `apps/backend/src/db/migrations/0006-workspaces.ts`:

```ts
import { type Kysely, sql } from "kysely";

/**
 * Workspaces: a per-user canvas of windows, each holding one session.
 *
 * These are the schema's first foreign keys. `PRAGMA foreign_keys = ON` is set
 * in packages/sqlite-dialect, so both cascades below are enforced: dropping a
 * workspace drops its panes, and deleting a session drops any pane pointing at
 * it — which is why no application code has to sweep dangling panes.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("workspaces")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("canvas_x", "real", (col) => col.notNull().defaultTo(0))
    .addColumn("canvas_y", "real", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema
    .createIndex("idx_workspaces_user_name")
    .on("workspaces")
    .columns(["user_id", "name"])
    .unique()
    .execute();

  await db.schema
    .createTable("workspace_panes")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("workspace_id", "text", (col) => col.notNull().references("workspaces.id").onDelete("cascade"))
    .addColumn("session_id", "text", (col) => col.notNull().references("sessions.id").onDelete("cascade"))
    .addColumn("x", "real", (col) => col.notNull())
    .addColumn("y", "real", (col) => col.notNull())
    .addColumn("width", "real", (col) => col.notNull())
    .addColumn("height", "real", (col) => col.notNull())
    .addColumn("z_index", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("collapsed", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema
    .createIndex("idx_workspace_panes_workspace")
    .on("workspace_panes")
    .column("workspace_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("workspace_panes").execute();
  await db.schema.dropTable("workspaces").execute();
}
```

- [ ] **Step 4: Run the test again**

```bash
cd apps/backend && bun test src/db/migrations/__tests__/0006-workspaces.test.ts
```
Expected: PASS, 4 tests.

If the two cascade tests fail while the others pass, foreign keys are not being enforced on this connection — check `PRAGMA foreign_keys = ON` in `packages/sqlite-dialect/src/database.ts`. Do **not** work around it by deleting panes manually.

- [ ] **Step 5: Register the migration**

In `apps/backend/src/db/migrate.ts` add the import and the map entry. The key must equal the file name:

```ts
import * as workspacesMigration from "@/db/migrations/0006-workspaces.js";
// …
"0006-workspaces": workspacesMigration,
```

- [ ] **Step 6: Write the DB types**

Create `apps/backend/src/db/types/workspaces.db-types.ts`:

```ts
/**
 * A workspace: a saved canvas of session windows, private to one user.
 */
export interface WorkspaceTable {
  /** Unique workspace id (uuid) */
  id: string;
  /** Owning user id; every query filters on this */
  userId: string;
  /** Friendly label, unique per user */
  name: string;
  /** Optional longer description */
  description: string | null;
  /** Saved canvas pan, x axis (canvas units) */
  canvasX: number;
  /** Saved canvas pan, y axis (canvas units) */
  canvasY: number;
  /** ISO 8601 timestamp when the workspace was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

/** Insert shape: DB defaults fill the canvas offsets and timestamps. */
export type NewWorkspace = Omit<WorkspaceTable, "createdAt" | "updatedAt" | "canvasX" | "canvasY"> & {
  canvasX?: number;
  canvasY?: number;
};

/** Update shape. */
export type WorkspaceUpdate = Partial<Omit<NewWorkspace, "id" | "userId">>;
```

Create `apps/backend/src/db/types/workspace-panes.db-types.ts`:

```ts
/**
 * One window on a workspace canvas, holding exactly one session.
 *
 * Both foreign keys cascade on delete, so a pane cannot outlive its workspace
 * or its session.
 */
export interface WorkspacePaneTable {
  /** Unique pane id (uuid) */
  id: string;
  /** Owning workspace (FK, cascades) */
  workspaceId: string;
  /** Session rendered in this pane (FK, cascades) */
  sessionId: string;
  /** Canvas x of the window's top-left corner */
  x: number;
  /** Canvas y of the window's top-left corner */
  y: number;
  /** Window width in canvas units */
  width: number;
  /** Window height in canvas units */
  height: number;
  /** Stacking order; clicking a pane raises it */
  zIndex: number;
  /** 1 = collapsed to its title bar */
  collapsed: number;
  /** ISO 8601 timestamp when the pane was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

/** Insert shape: DB defaults fill zIndex, collapsed and the timestamps. */
export type NewWorkspacePane = Omit<WorkspacePaneTable, "createdAt" | "updatedAt" | "zIndex" | "collapsed"> & {
  zIndex?: number;
  collapsed?: number;
};

/** Update shape. */
export type WorkspacePaneUpdate = Partial<Omit<NewWorkspacePane, "id" | "workspaceId">>;
```

Register both in `apps/backend/src/db/types/index.ts`:

```ts
import type { WorkspacePaneTable } from "@/db/types/workspace-panes.db-types.js";
import type { WorkspaceTable } from "@/db/types/workspaces.db-types.js";
// …inside the Database interface:
  workspaces: WorkspaceTable;
  workspacePanes: WorkspacePaneTable;
```

- [ ] **Step 7: Verify**

```bash
bun run verify-types && bun run lint:check && bun run test
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/db
git commit -m "feat(workspaces): add workspaces and workspace_panes tables

The schema's first foreign keys. Both cascade on delete, so a pane cannot
outlive its workspace or its session — which is the whole dangling-pane
strategy, and is why both cascades are tested rather than assumed."
```

---

### Task 3: Repositories

**Files:**
- Create: `apps/backend/src/db/repositories/workspaces.repository.ts`
- Create: `apps/backend/src/db/repositories/workspace-panes.repository.ts`
- Create: `apps/backend/src/db/repositories/__tests__/workspaces-repository.test.ts`
- Modify: `apps/backend/src/db/repositories/index.ts`

**Interfaces:**
- Consumes: `WorkspaceTable`, `NewWorkspace`, `WorkspaceUpdate`, `WorkspacePaneTable`, `NewWorkspacePane` from Task 2.
- Produces:
```ts
class WorkspacesRepository {
  create(w: NewWorkspace): Promise<WorkspaceTable>;
  findByIdForUser(id: string, userId: string): Promise<WorkspaceTable | undefined>;
  listByUser(userId: string): Promise<WorkspaceTable[]>;
  update(id: string, update: WorkspaceUpdate): Promise<WorkspaceTable | undefined>;
  delete(id: string): Promise<void>;
}
class WorkspacePanesRepository {
  listByWorkspace(workspaceId: string): Promise<WorkspacePaneTable[]>;
  create(pane: NewWorkspacePane): Promise<WorkspacePaneTable>;
  delete(id: string): Promise<void>;
  replaceGeometry(workspaceId: string, panes: PaneGeometry[]): Promise<void>;
}
interface PaneGeometry {
  id: string; x: number; y: number; width: number; height: number; zIndex: number; collapsed: number;
}
```

`findByIdForUser` takes the user id rather than a bare `findById`: a workspace is private, and making ownership part of the lookup signature means a handler cannot forget to check it.

- [ ] **Step 1: Write the failing repository test**

Create `apps/backend/src/db/repositories/__tests__/workspaces-repository.test.ts`:

```ts
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BunSqliteDialect, openSqliteDatabase } from "@internal/sqlite-dialect";
import { CamelCasePlugin, Kysely } from "kysely";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as workspacesMigration from "@/db/migrations/0006-workspaces.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { WorkspacePanesRepository } from "@/db/repositories/workspace-panes.repository.js";
import { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";
import type { Database } from "@/db/types/index.js";

const db = new Kysely<Database>({
  dialect: new BunSqliteDialect({ database: () => openSqliteDatabase(":memory:") }),
  plugins: [new CamelCasePlugin()],
});

const workspaces = new WorkspacesRepository(db);
const panes = new WorkspacePanesRepository(db);
const profiles = new ProfilesRepository(db);
const sessions = new SessionsRepository(db);

/** Creates a profile + session owned by `userId`, returning the session id. */
async function makeSession(userId: string): Promise<string> {
  const profile = await profiles.create({
    id: crypto.randomUUID(),
    userId,
    harnessId: "claude-code",
    name: `p-${crypto.randomUUID().slice(0, 8)}`,
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
  });
  const id = crypto.randomUUID();
  await sessions.create({
    id,
    userId,
    profileId: profile.id,
    harnessId: "claude-code",
    name: "s",
    workingDir: "/tmp",
    tmuxSocket: null,
  });
  return id;
}

beforeAll(async () => {
  await initMigration.up(db);
  await operatorUxMigration.up(db);
  await remoteOpsMigration.up(db);
  await workspacesMigration.up(db);
});

beforeEach(async () => {
  await db.deleteFrom("workspacePanes").execute();
  await db.deleteFrom("workspaces").execute();
});

describe("workspaces repository", () => {
  it("lists only the owner's workspaces, ordered by name", async () => {
    await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Theta", description: null });
    await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Alpha", description: null });
    await workspaces.create({ id: crypto.randomUUID(), userId: "u2", name: "Other", description: null });

    const mine = await workspaces.listByUser("u1");
    expect(mine.map((w) => w.name)).toEqual(["Alpha", "Theta"]);
  });

  it("findByIdForUser hides another user's workspace", async () => {
    const created = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "Mine", description: null });
    expect(await workspaces.findByIdForUser(created.id, "u1")).toBeTruthy();
    expect(await workspaces.findByIdForUser(created.id, "u2")).toBeUndefined();
  });

  it("updates the canvas offset and deletes", async () => {
    const created = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W", description: null });
    const updated = await workspaces.update(created.id, { canvasX: -120.5, canvasY: 40 });
    expect(updated?.canvasX).toBe(-120.5);
    expect(updated?.canvasY).toBe(40);

    await workspaces.delete(created.id);
    expect(await workspaces.findByIdForUser(created.id, "u1")).toBeUndefined();
  });
});

describe("workspace panes repository", () => {
  it("creates and lists panes for a workspace", async () => {
    const ws = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W", description: null });
    const sessionId = await makeSession("u1");
    await panes.create({
      id: crypto.randomUUID(),
      workspaceId: ws.id,
      sessionId,
      x: 10,
      y: 20,
      width: 600,
      height: 400,
    });

    const list = await panes.listByWorkspace(ws.id);
    expect(list).toHaveLength(1);
    expect(list[0].x).toBe(10);
    expect(list[0].zIndex).toBe(0);
  });

  it("replaceGeometry writes every pane in one pass", async () => {
    const ws = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "W", description: null });
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await panes.create({ id: a, workspaceId: ws.id, sessionId: await makeSession("u1"), x: 0, y: 0, width: 300, height: 200 });
    await panes.create({ id: b, workspaceId: ws.id, sessionId: await makeSession("u1"), x: 0, y: 0, width: 300, height: 200 });

    await panes.replaceGeometry(ws.id, [
      { id: a, x: 100, y: 110, width: 640, height: 480, zIndex: 2, collapsed: 0 },
      { id: b, x: 200, y: 210, width: 320, height: 240, zIndex: 1, collapsed: 1 },
    ]);

    const list = await panes.listByWorkspace(ws.id);
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    expect(byId[a].x).toBe(100);
    expect(byId[a].zIndex).toBe(2);
    expect(byId[b].collapsed).toBe(1);
  });

  it("replaceGeometry ignores ids belonging to another workspace", async () => {
    const mine = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "A", description: null });
    const other = await workspaces.create({ id: crypto.randomUUID(), userId: "u1", name: "B", description: null });
    const foreign = crypto.randomUUID();
    await panes.create({
      id: foreign,
      workspaceId: other.id,
      sessionId: await makeSession("u1"),
      x: 5,
      y: 5,
      width: 300,
      height: 200,
    });

    await panes.replaceGeometry(mine.id, [
      { id: foreign, x: 999, y: 999, width: 999, height: 999, zIndex: 9, collapsed: 0 },
    ]);

    const untouched = await panes.listByWorkspace(other.id);
    expect(untouched[0].x).toBe(5);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/backend && bun test src/db/repositories/__tests__/workspaces-repository.test.ts
```
Expected: FAIL — `Cannot find module '@/db/repositories/workspaces.repository.js'`.

- [ ] **Step 3: Write `WorkspacesRepository`**

```ts
import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewWorkspace, WorkspaceTable, WorkspaceUpdate } from "@/db/types/workspaces.db-types.js";

/**
 * Repository for per-user workspaces. Every read is scoped by user id — a
 * workspace is private to its owner.
 */
export class WorkspacesRepository extends BaseRepository {
  /** Inserts a workspace, stamping both timestamps. */
  async create(workspace: NewWorkspace): Promise<WorkspaceTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("workspaces")
      .values({
        ...workspace,
        canvasX: workspace.canvasX ?? 0,
        canvasY: workspace.canvasY ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Looks a workspace up *and* checks ownership in one query. Ownership is part
   * of the signature so a caller cannot forget it.
   */
  async findByIdForUser(id: string, userId: string): Promise<WorkspaceTable | undefined> {
    return this.db
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", id)
      .where("userId", "=", userId)
      .executeTakeFirst();
  }

  /** All of a user's workspaces, ordered by name. */
  async listByUser(userId: string): Promise<WorkspaceTable[]> {
    return this.db
      .selectFrom("workspaces")
      .selectAll()
      .where("userId", "=", userId)
      .orderBy("name", "asc")
      .execute();
  }

  /** Applies a partial update and returns the fresh row. */
  async update(id: string, update: WorkspaceUpdate): Promise<WorkspaceTable | undefined> {
    await this.db
      .updateTable("workspaces")
      .set({ ...update, updatedAt: sql`(datetime('now'))` })
      .where("id", "=", id)
      .execute();
    return this.db.selectFrom("workspaces").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** Deletes a workspace; its panes cascade away. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("workspaces").where("id", "=", id).execute();
  }
}
```

- [ ] **Step 4: Write `WorkspacePanesRepository`**

```ts
import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewWorkspacePane, WorkspacePaneTable } from "@/db/types/workspace-panes.db-types.js";

/** Geometry for one pane, as sent by the canvas's debounced bulk save. */
export interface PaneGeometry {
  /** Pane id */
  id: string;
  /** Canvas x of the top-left corner */
  x: number;
  /** Canvas y of the top-left corner */
  y: number;
  /** Window width in canvas units */
  width: number;
  /** Window height in canvas units */
  height: number;
  /** Stacking order */
  zIndex: number;
  /** 1 = collapsed to the title bar */
  collapsed: number;
}

/**
 * Repository for workspace panes. Panes are reached through their workspace,
 * so ownership is checked one level up before any of these run.
 */
export class WorkspacePanesRepository extends BaseRepository {
  /** All panes of a workspace, lowest z-index first. */
  async listByWorkspace(workspaceId: string): Promise<WorkspacePaneTable[]> {
    return this.db
      .selectFrom("workspacePanes")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .orderBy("zIndex", "asc")
      .execute();
  }

  /** Inserts a pane, stamping both timestamps. */
  async create(pane: NewWorkspacePane): Promise<WorkspacePaneTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("workspacePanes")
      .values({
        ...pane,
        zIndex: pane.zIndex ?? 0,
        collapsed: pane.collapsed ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Removes a single pane. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("workspacePanes").where("id", "=", id).execute();
  }

  /**
   * Writes the geometry of every pane in one transaction — the canvas saves the
   * whole set at once rather than a row per drag.
   *
   * Each update is additionally constrained to `workspaceId`, so a payload
   * naming a pane from another workspace silently affects nothing instead of
   * letting one workspace rewrite another's layout.
   */
  async replaceGeometry(workspaceId: string, panes: PaneGeometry[]): Promise<void> {
    if (panes.length === 0) return;
    await this.db.transaction().execute(async (trx) => {
      for (const pane of panes) {
        await trx
          .updateTable("workspacePanes")
          .set({
            x: pane.x,
            y: pane.y,
            width: pane.width,
            height: pane.height,
            zIndex: pane.zIndex,
            collapsed: pane.collapsed,
            updatedAt: sql`(datetime('now'))`,
          })
          .where("id", "=", pane.id)
          .where("workspaceId", "=", workspaceId)
          .execute();
      }
    });
  }
}
```

- [ ] **Step 5: Run the test again**

```bash
cd apps/backend && bun test src/db/repositories/__tests__/workspaces-repository.test.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 6: Register in the repositories index**

In `apps/backend/src/db/repositories/index.ts` add the imports and two `Repositories` fields:

```ts
import type { WorkspacePanesRepository } from "@/db/repositories/workspace-panes.repository.js";
import type { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";
// …inside the interface:
  workspaces: WorkspacesRepository;
  workspacePanes: WorkspacePanesRepository;
```

- [ ] **Step 7: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/db/repositories
git commit -m "feat(workspaces): workspaces and pane repositories

findByIdForUser takes the owner id so a handler cannot forget the check,
and replaceGeometry constrains every row to the workspace it names, so a
payload cannot rewrite another workspace's layout."
```

---

### Task 4: Workspaces API routes

**Files:**
- Create: `apps/backend/src/api/workspaces.route.ts`
- Create: `apps/backend/src/api/__tests__/workspaces-route.test.ts`
- Modify: `apps/backend/src/api/models.ts`, `apps/backend/src/api/routes.ts`

**Interfaces:**
- Consumes: `WorkspacesRepository`, `WorkspacePanesRepository`, `PaneGeometry` (Task 3); `authGuard` (`@/api/auth-guard.js`).
- Produces: `workspaceRoutes` (Elysia plugin, prefix `/api/workspaces`); `WorkspaceSchema`, `WorkspacePaneSchema` in `models.ts`.

Ownership rule for every handler: resolve via `findByIdForUser(id, user.id)` and **404 on a miss — never 403**, so the endpoint cannot be used to discover another user's workspace ids.

- [ ] **Step 1: Write the failing route test**

Create `apps/backend/src/api/__tests__/workspaces-route.test.ts`. It follows `mounts-admin.test.ts` and uses the same helpers.

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { workspaceRoutes } from "@/api/workspaces.route.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * Workspace CRUD is owner-scoped rather than admin-gated: another user's
 * workspace must read as 404, not 403, so ids cannot be probed.
 */
describe("workspaces route", () => {
  let ownerId: string;
  let otherId: string;
  let ownerEmail: string;
  let otherEmail: string;
  const password = "workspace-pass-1";

  beforeAll(async () => {
    await setupAuthTables();
    const repo = new UsersRepository(db);
    ownerEmail = `wsowner-${crypto.randomUUID()}@mote.local`;
    otherEmail = `wsother-${crypto.randomUUID()}@mote.local`;
    ownerId = await repo.createUser({ email: ownerEmail, passwordHash: await hashPassword(password), role: "user" });
    otherId = await repo.createUser({ email: otherEmail, passwordHash: await hashPassword(password), role: "user" });
  });

  beforeEach(async () => {
    await db.deleteFrom("workspacePanes").execute();
    await db.deleteFrom("workspaces").execute();
  });

  afterAll(async () => {
    await db.deleteFrom("userMeta").where("userId", "=", ownerId).execute();
    await db.deleteFrom("userMeta").where("userId", "=", otherId).execute();
    await deleteUserByEmailOrId(ownerEmail);
    await deleteUserByEmailOrId(otherEmail);
  });

  /** POSTs a workspace and returns its id. */
  async function createWorkspace(token: string, name: string): Promise<string> {
    const res = await workspaceRoutes.fetch(
      authedRequest("/api/workspaces", token, { method: "POST", body: JSON.stringify({ name }) }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }

  it("anonymous -> 401", async () => {
    const res = await workspaceRoutes.fetch(new Request("http://localhost:3080/api/workspaces"));
    expect(res.status).toBe(401);
  });

  it("creates a workspace and lists it back", async () => {
    const token = await signIn(ownerEmail, password);
    const name = `ws-${crypto.randomUUID().slice(0, 8)}`;
    const id = await createWorkspace(token, name);

    const list = await workspaceRoutes.fetch(authedRequest("/api/workspaces", token));
    const body = (await list.json()) as { id: string; name: string }[];
    expect(body.some((w) => w.id === id && w.name === name)).toBe(true);
  });

  it("duplicate name for the same user -> 409, but another user may reuse it", async () => {
    const ownerToken = await signIn(ownerEmail, password);
    const otherToken = await signIn(otherEmail, password);
    const name = `dup-${crypto.randomUUID().slice(0, 8)}`;
    await createWorkspace(ownerToken, name);

    const dup = await workspaceRoutes.fetch(
      authedRequest("/api/workspaces", ownerToken, { method: "POST", body: JSON.stringify({ name }) }),
    );
    expect(dup.status).toBe(409);

    const otherRes = await workspaceRoutes.fetch(
      authedRequest("/api/workspaces", otherToken, { method: "POST", body: JSON.stringify({ name }) }),
    );
    expect(otherRes.status).toBe(200);
  });

  it("another user's workspace reads as 404, not 403", async () => {
    const ownerToken = await signIn(ownerEmail, password);
    const otherToken = await signIn(otherEmail, password);
    const id = await createWorkspace(ownerToken, `private-${crypto.randomUUID().slice(0, 8)}`);

    const read = await workspaceRoutes.fetch(authedRequest(`/api/workspaces/${id}`, otherToken));
    expect(read.status).toBe(404);

    const del = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}`, otherToken, { method: "DELETE" }),
    );
    expect(del.status).toBe(404);
  });

  it("a pane cannot point at a session the caller does not own", async () => {
    const ownerToken = await signIn(ownerEmail, password);
    const id = await createWorkspace(ownerToken, `panes-${crypto.randomUUID().slice(0, 8)}`);

    const res = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}/panes`, ownerToken, {
        method: "POST",
        body: JSON.stringify({ sessionId: crypto.randomUUID(), x: 0, y: 0, width: 600, height: 400 }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("saves the canvas offset", async () => {
    const token = await signIn(ownerEmail, password);
    const id = await createWorkspace(token, `pan-${crypto.randomUUID().slice(0, 8)}`);

    const res = await workspaceRoutes.fetch(
      authedRequest(`/api/workspaces/${id}`, token, {
        method: "PUT",
        body: JSON.stringify({ canvasX: -240, canvasY: 80 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canvasX: number; canvasY: number };
    expect(body.canvasX).toBe(-240);
    expect(body.canvasY).toBe(80);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/backend && bun test src/api/__tests__/workspaces-route.test.ts
```
Expected: FAIL — `Cannot find module '@/api/workspaces.route.js'`.

- [ ] **Step 3: Add the response schemas to `models.ts`**

```ts
export const WorkspaceSchema = t.Object({
  id: t.String({ description: "Workspace id" }),
  name: t.String({ description: "Workspace name (unique per user)" }),
  description: t.Union([t.String({ description: "Longer description" }), t.Null()]),
  canvasX: t.Number({ description: "Saved canvas pan, x axis" }),
  canvasY: t.Number({ description: "Saved canvas pan, y axis" }),
  createdAt: t.String({ description: "Created timestamp" }),
  updatedAt: t.String({ description: "Updated timestamp" }),
});

export const WorkspacePaneSchema = t.Object({
  id: t.String({ description: "Pane id" }),
  sessionId: t.String({ description: "Session rendered in this pane" }),
  x: t.Number({ description: "Canvas x of the window's top-left corner" }),
  y: t.Number({ description: "Canvas y of the window's top-left corner" }),
  width: t.Number({ description: "Window width in canvas units" }),
  height: t.Number({ description: "Window height in canvas units" }),
  zIndex: t.Number({ description: "Stacking order" }),
  collapsed: t.Boolean({ description: "True when collapsed to the title bar" }),
  sessionName: t.String({ description: "Session display name, joined for the pane title" }),
  sessionStatus: t.String({ description: "running | terminated" }),
  sessionAlive: t.Boolean({ description: "False once the harness process has exited" }),
  workingDir: t.String({ description: "Absolute working directory of the session" }),
});

export const WorkspaceDetailSchema = t.Object({
  workspace: WorkspaceSchema,
  panes: t.Array(WorkspacePaneSchema, { description: "Windows on this workspace's canvas" }),
});
```

- [ ] **Step 4: Write the route**

Create `apps/backend/src/api/workspaces.route.ts`:

```ts
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { WorkspaceDetailSchema, WorkspaceSchema } from "@/api/models.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { WorkspacePanesRepository } from "@/db/repositories/workspace-panes.repository.js";
import { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";

const CreateWorkspaceBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 120, description: "Workspace name (unique per user)" }),
  description: t.Optional(t.String({ maxLength: 500, description: "Longer description" })),
});

const UpdateWorkspaceBodySchema = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 120, description: "Workspace name" })),
  description: t.Optional(t.String({ maxLength: 500, description: "Longer description" })),
  canvasX: t.Optional(t.Number({ description: "Saved canvas pan, x axis" })),
  canvasY: t.Optional(t.Number({ description: "Saved canvas pan, y axis" })),
});

const AddPaneBodySchema = t.Object({
  sessionId: t.String({ minLength: 1, description: "Session to render in the new pane" }),
  x: t.Number({ description: "Canvas x of the window's top-left corner" }),
  y: t.Number({ description: "Canvas y of the window's top-left corner" }),
  width: t.Number({ description: "Window width in canvas units" }),
  height: t.Number({ description: "Window height in canvas units" }),
});

const SaveLayoutBodySchema = t.Object({
  panes: t.Array(
    t.Object({
      id: t.String({ description: "Pane id" }),
      x: t.Number({ description: "Canvas x" }),
      y: t.Number({ description: "Canvas y" }),
      width: t.Number({ description: "Window width" }),
      height: t.Number({ description: "Window height" }),
      zIndex: t.Number({ description: "Stacking order" }),
      collapsed: t.Boolean({ description: "Collapsed to the title bar" }),
    }),
    { description: "Full pane set with its current geometry" },
  ),
});

/** Route error carrying an HTTP status; Elysia maps `status` to the response code. */
class WorkspacesError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "WorkspacesError";
  }
}

/** Elevates a duplicate (user_id, name) to a 409. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE");
}

export const workspaceRoutes = new Elysia({ prefix: "/api/workspaces" })
  .use(authGuard)
  .post(
    "/",
    async ({ body, user }) => {
      try {
        return await new WorkspacesRepository(db).create({
          id: crypto.randomUUID(),
          userId: user.id,
          name: body.name,
          description: body.description ?? null,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new WorkspacesError("duplicate", "You already have a workspace with that name", 409);
        }
        throw err;
      }
    },
    {
      body: CreateWorkspaceBodySchema,
      response: WorkspaceSchema,
      detail: {
        operationId: "createWorkspace",
        tags: ["workspaces"],
        description: "Creates a workspace for the authenticated user",
      },
    },
  )
  .get(
    "/",
    async ({ user }) => new WorkspacesRepository(db).listByUser(user.id),
    {
      response: t.Array(WorkspaceSchema, { description: "The caller's workspaces" }),
      detail: {
        operationId: "listWorkspaces",
        tags: ["workspaces"],
        description: "Lists the authenticated user's workspaces",
      },
    },
  )
  .get(
    "/:id",
    async ({ params, user }) => {
      const workspace = await new WorkspacesRepository(db).findByIdForUser(params.id, user.id);
      if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);

      const paneRows = await new WorkspacePanesRepository(db).listByWorkspace(workspace.id);
      const sessionsRepo = new SessionsRepository(db);
      const panes = [];
      for (const pane of paneRows) {
        // The FK cascade means the session always exists; the guard keeps the
        // types honest rather than covering a real case.
        const session = await sessionsRepo.findById(pane.sessionId);
        if (!session) continue;
        panes.push({
          id: pane.id,
          sessionId: pane.sessionId,
          x: pane.x,
          y: pane.y,
          width: pane.width,
          height: pane.height,
          zIndex: pane.zIndex,
          collapsed: pane.collapsed === 1,
          sessionName: session.name,
          sessionStatus: session.status,
          sessionAlive: session.alive === 1,
          workingDir: session.workingDir,
        });
      }
      return { workspace, panes };
    },
    {
      response: WorkspaceDetailSchema,
      detail: {
        operationId: "getWorkspace",
        tags: ["workspaces"],
        description: "Gets one workspace with its panes and each pane's session summary",
      },
    },
  )
  .put(
    "/:id",
    async ({ params, body, user }) => {
      const repo = new WorkspacesRepository(db);
      const existing = await repo.findByIdForUser(params.id, user.id);
      if (!existing) throw new WorkspacesError("not_found", "Workspace not found", 404);
      try {
        const updated = await repo.update(params.id, body);
        if (!updated) throw new WorkspacesError("not_found", "Workspace not found", 404);
        return updated;
      } catch (err) {
        if (err instanceof WorkspacesError) throw err;
        if (isUniqueViolation(err)) {
          throw new WorkspacesError("duplicate", "You already have a workspace with that name", 409);
        }
        throw err;
      }
    },
    {
      body: UpdateWorkspaceBodySchema,
      response: WorkspaceSchema,
      detail: {
        operationId: "updateWorkspace",
        tags: ["workspaces"],
        description: "Renames a workspace or saves its canvas pan",
      },
    },
  )
  .delete(
    "/:id",
    async ({ params, user }) => {
      const repo = new WorkspacesRepository(db);
      const existing = await repo.findByIdForUser(params.id, user.id);
      if (!existing) throw new WorkspacesError("not_found", "Workspace not found", 404);
      await repo.delete(params.id);
      return { ok: true };
    },
    {
      response: t.Object({ ok: t.Boolean({ description: "Always true" }) }),
      detail: {
        operationId: "deleteWorkspace",
        tags: ["workspaces"],
        description: "Deletes a workspace; its panes cascade away",
      },
    },
  )
  .post(
    "/:id/panes",
    async ({ params, body, user }) => {
      const workspace = await new WorkspacesRepository(db).findByIdForUser(params.id, user.id);
      if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);

      // A pane may only reference the caller's own session. Reported as 404 so
      // the endpoint never confirms another user's session id.
      const session = await new SessionsRepository(db).findById(body.sessionId);
      if (!session || session.userId !== user.id) {
        throw new WorkspacesError("not_found", "Session not found", 404);
      }

      const panesRepo = new WorkspacePanesRepository(db);
      const existing = await panesRepo.listByWorkspace(workspace.id);
      const created = await panesRepo.create({
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        sessionId: body.sessionId,
        x: body.x,
        y: body.y,
        width: body.width,
        height: body.height,
        // A new pane lands on top.
        zIndex: existing.reduce((max, p) => Math.max(max, p.zIndex), 0) + 1,
      });
      return { id: created.id };
    },
    {
      body: AddPaneBodySchema,
      response: t.Object({ id: t.String({ description: "Id of the new pane" }) }),
      detail: {
        operationId: "addWorkspacePane",
        tags: ["workspaces"],
        description: "Adds a pane holding one of the caller's sessions",
      },
    },
  )
  .put(
    "/:id/panes",
    async ({ params, body, user }) => {
      const workspace = await new WorkspacesRepository(db).findByIdForUser(params.id, user.id);
      if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);
      await new WorkspacePanesRepository(db).replaceGeometry(
        workspace.id,
        body.panes.map((p) => ({ ...p, collapsed: p.collapsed ? 1 : 0 })),
      );
      return { ok: true };
    },
    {
      body: SaveLayoutBodySchema,
      response: t.Object({ ok: t.Boolean({ description: "Always true" }) }),
      detail: {
        operationId: "saveWorkspaceLayout",
        tags: ["workspaces"],
        description: "Saves the geometry of every pane in one transaction",
      },
    },
  )
  .delete(
    "/:id/panes/:paneId",
    async ({ params, user }) => {
      const workspace = await new WorkspacesRepository(db).findByIdForUser(params.id, user.id);
      if (!workspace) throw new WorkspacesError("not_found", "Workspace not found", 404);
      const panesRepo = new WorkspacePanesRepository(db);
      const panes = await panesRepo.listByWorkspace(workspace.id);
      if (!panes.some((p) => p.id === params.paneId)) {
        throw new WorkspacesError("not_found", "Pane not found", 404);
      }
      await panesRepo.delete(params.paneId);
      return { ok: true };
    },
    {
      response: t.Object({ ok: t.Boolean({ description: "Always true" }) }),
      detail: {
        operationId: "removeWorkspacePane",
        tags: ["workspaces"],
        description: "Removes a pane from a workspace (the session is untouched)",
      },
    },
  );
```

- [ ] **Step 5: Wire it into the router**

In `apps/backend/src/api/routes.ts` add the import and `.use(workspaceRoutes)`:

```ts
import { workspaceRoutes } from "@/api/workspaces.route.js";
// …in the chain:
  .use(workspaceRoutes)
```

- [ ] **Step 6: Run the test again**

```bash
cd apps/backend && bun test src/api/__tests__/workspaces-route.test.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 7: Rebuild so the Eden client sees the new routes**

```bash
turbo build
```
`@internal/backend-client` infers its types from the backend's exported `App` type, so without this the frontend cannot see the new endpoints.

- [ ] **Step 8: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/api
git commit -m "feat(workspaces): owner-scoped workspaces API

Every handler resolves through findByIdForUser and answers 404 rather than
403 on a miss, so workspace and session ids cannot be probed from another
account."
```

---

### Task 5: Canvas geometry (pure functions)

All the canvas maths that is worth testing, with no React in it. This is the only part of the canvas covered by automated tests, so it carries the rules that matter.

**Files:**
- Create: `apps/frontend/src/lib/canvas-geometry.ts`
- Create: `apps/frontend/src/lib/__tests__/canvas-geometry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Viewport { x: number; y: number }          // canvas pan; there is no zoom
export interface Rect extends Point, Size {}
export const MIN_PANE_SIZE: Size;
export const VISIBILITY_MARGIN: number;
export function screenToCanvas(pt: Point, viewport: Viewport): Point;
export function canvasToScreen(pt: Point, viewport: Viewport): Point;
export function clampPaneSize(size: Size): Size;
export function paneIsVisible(pane: Rect, viewport: Viewport, viewportSize: Size, margin?: number): boolean;
export function nextPanePosition(existing: Rect[]): Point;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/lib/__tests__/canvas-geometry.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  canvasToScreen,
  clampPaneSize,
  MIN_PANE_SIZE,
  nextPanePosition,
  paneIsVisible,
  screenToCanvas,
  VISIBILITY_MARGIN,
} from "../canvas-geometry";

describe("screenToCanvas / canvasToScreen", () => {
  it("round-trips a point through both conversions", () => {
    const viewport = { x: -120, y: 45 };
    const point = { x: 300, y: 210 };
    expect(canvasToScreen(screenToCanvas(point, viewport), viewport)).toEqual(point);
  });

  it("subtracts the pan when going screen -> canvas", () => {
    expect(screenToCanvas({ x: 100, y: 100 }, { x: -50, y: 20 })).toEqual({ x: 150, y: 80 });
  });
});

describe("clampPaneSize", () => {
  it("leaves a comfortable size alone", () => {
    expect(clampPaneSize({ width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
  });

  it("floors a pane at the minimum usable terminal size", () => {
    expect(clampPaneSize({ width: 10, height: 10 })).toEqual(MIN_PANE_SIZE);
  });
});

describe("paneIsVisible", () => {
  const viewportSize = { width: 1000, height: 800 };
  const viewport = { x: 0, y: 0 };

  it("is visible when it overlaps the viewport", () => {
    expect(paneIsVisible({ x: 100, y: 100, width: 400, height: 300 }, viewport, viewportSize)).toBe(true);
  });

  it("stays visible just outside the edge, within the margin", () => {
    const justOutside = { x: 1000 + VISIBILITY_MARGIN - 50, y: 0, width: 100, height: 100 };
    expect(paneIsVisible(justOutside, viewport, viewportSize)).toBe(true);
  });

  it("is not visible well beyond the margin", () => {
    const farAway = { x: 1000 + VISIBILITY_MARGIN + 200, y: 0, width: 100, height: 100 };
    expect(paneIsVisible(farAway, viewport, viewportSize)).toBe(false);
  });

  it("accounts for the pan", () => {
    const pane = { x: 3000, y: 0, width: 400, height: 300 };
    expect(paneIsVisible(pane, { x: 0, y: 0 }, viewportSize)).toBe(false);
    // Panning the canvas so the pane sits at screen x=100 brings it into view.
    expect(paneIsVisible(pane, { x: -2900, y: 0 }, viewportSize)).toBe(true);
  });
});

describe("nextPanePosition", () => {
  it("places the first pane at the origin offset", () => {
    expect(nextPanePosition([])).toEqual({ x: 40, y: 40 });
  });

  it("cascades so a new pane never lands exactly on an existing one", () => {
    const existing = [{ x: 40, y: 40, width: 600, height: 400 }];
    const next = nextPanePosition(existing);
    expect(next).not.toEqual({ x: 40, y: 40 });
  });

  it("keeps cascading as panes accumulate", () => {
    const placed = [];
    for (let i = 0; i < 4; i++) {
      const at = nextPanePosition(placed);
      placed.push({ ...at, width: 600, height: 400 });
    }
    const seen = new Set(placed.map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(4);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/frontend && bun test src/lib/__tests__/canvas-geometry.test.ts
```
Expected: FAIL — cannot resolve `../canvas-geometry`.

- [ ] **Step 3: Implement**

Create `apps/frontend/src/lib/canvas-geometry.ts`:

```ts
/** A point in either screen or canvas space. */
export interface Point {
  /** Horizontal coordinate */
  x: number;
  /** Vertical coordinate */
  y: number;
}

/** Width and height in canvas units. */
export interface Size {
  /** Width */
  width: number;
  /** Height */
  height: number;
}

/**
 * The canvas pan. There is deliberately no zoom: a CSS-scaled xterm renders
 * blurry and loses its mouse mapping, so reading a pane closely is served by
 * expanding it instead.
 */
export interface Viewport {
  /** Canvas translation, x axis */
  x: number;
  /** Canvas translation, y axis */
  y: number;
}

/** A positioned, sized rectangle in canvas space. */
export interface Rect extends Point, Size {}

/** Smallest pane that still holds a usable terminal (roughly 40x10 cells). */
export const MIN_PANE_SIZE: Size = { width: 320, height: 200 };

/**
 * How far outside the viewport a pane stays attached, in pixels.
 *
 * Roughly half a viewport, so nudging the canvas does not tear down and
 * re-attach sockets at the edge.
 */
export const VISIBILITY_MARGIN = 400;

/** Where the first pane lands, and the step between cascaded panes. */
const CASCADE_ORIGIN: Point = { x: 40, y: 40 };
const CASCADE_STEP = 32;

/** Converts a screen point to canvas coordinates. */
export function screenToCanvas(pt: Point, viewport: Viewport): Point {
  return { x: pt.x - viewport.x, y: pt.y - viewport.y };
}

/** Converts a canvas point to screen coordinates. */
export function canvasToScreen(pt: Point, viewport: Viewport): Point {
  return { x: pt.x + viewport.x, y: pt.y + viewport.y };
}

/** Floors a pane at the minimum usable terminal size. */
export function clampPaneSize(size: Size): Size {
  return {
    width: Math.max(size.width, MIN_PANE_SIZE.width),
    height: Math.max(size.height, MIN_PANE_SIZE.height),
  };
}

/**
 * Whether a pane is close enough to the viewport to stay attached.
 *
 * This drives `SessionTerminal`'s `active` prop, and therefore whether the
 * pane holds a WebSocket and a WebGL context at all.
 */
export function paneIsVisible(
  pane: Rect,
  viewport: Viewport,
  viewportSize: Size,
  margin: number = VISIBILITY_MARGIN,
): boolean {
  const topLeft = canvasToScreen(pane, viewport);
  const left = topLeft.x;
  const top = topLeft.y;
  const right = left + pane.width;
  const bottom = top + pane.height;
  return (
    right >= -margin &&
    bottom >= -margin &&
    left <= viewportSize.width + margin &&
    top <= viewportSize.height + margin
  );
}

/**
 * Where a newly added pane should land: cascaded down-right from the origin so
 * it never lands exactly on top of an existing window.
 */
export function nextPanePosition(existing: Rect[]): Point {
  let candidate = { ...CASCADE_ORIGIN };
  const taken = new Set(existing.map((r) => `${r.x},${r.y}`));
  while (taken.has(`${candidate.x},${candidate.y}`)) {
    candidate = { x: candidate.x + CASCADE_STEP, y: candidate.y + CASCADE_STEP };
  }
  return candidate;
}
```

- [ ] **Step 4: Run the tests again**

```bash
cd apps/frontend && bun test src/lib/__tests__/canvas-geometry.test.ts
```
Expected: PASS, 10 tests.

- [ ] **Step 5: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/src/lib/canvas-geometry.ts apps/frontend/src/lib/__tests__/canvas-geometry.test.ts
git commit -m "feat(workspaces): canvas geometry helpers

paneIsVisible carries the rule that decides whether a pane holds a socket
and a WebGL context at all, so it is tested at the margin boundary."
```

---

### Task 6: Client types, form helpers and data hooks

**Files:**
- Create: `apps/frontend/src/types/workspace.ts`
- Create: `apps/frontend/src/lib/workspace-form.ts`
- Create: `apps/frontend/src/lib/__tests__/workspace-form.test.ts`
- Create: `apps/frontend/src/hooks/use-workspaces.ts`, `apps/frontend/src/hooks/use-workspace.ts`

**Interfaces:**
- Consumes: `apiFetch` (`@/lib/api`).
- Produces:
```ts
export interface WorkspaceRow { id: string; name: string; description: string | null; canvasX: number; canvasY: number; createdAt: string; updatedAt: string }
export interface WorkspacePaneRow { id: string; sessionId: string; x: number; y: number; width: number; height: number; zIndex: number; collapsed: boolean; sessionName: string; sessionStatus: string; sessionAlive: boolean; workingDir: string }
export interface WorkspaceDetail { workspace: WorkspaceRow; panes: WorkspacePaneRow[] }
export interface WorkspaceFormValue { name: string; description: string }
export function emptyWorkspaceForm(): WorkspaceFormValue;
export function workspaceFormFromRow(row: WorkspaceRow): WorkspaceFormValue;
export function toCreateWorkspace(v: WorkspaceFormValue): { name: string; description?: string };
export function useWorkspaces(): UseQueryResult<WorkspaceRow[]>;
export function useWorkspace(id: string): UseQueryResult<WorkspaceDetail>;
```

- [ ] **Step 1: Write the failing form test**

Create `apps/frontend/src/lib/__tests__/workspace-form.test.ts`, mirroring `mount-form.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { WorkspaceRow } from "@/types/workspace";
import { emptyWorkspaceForm, toCreateWorkspace, workspaceFormFromRow } from "../workspace-form";

const baseRow: WorkspaceRow = {
  id: "w1",
  name: "refactor",
  description: null,
  canvasX: 0,
  canvasY: 0,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

describe("emptyWorkspaceForm", () => {
  it("returns empty defaults", () => {
    expect(emptyWorkspaceForm()).toEqual({ name: "", description: "" });
  });
});

describe("workspaceFormFromRow", () => {
  it("maps a row to form state, null description -> empty string", () => {
    expect(workspaceFormFromRow(baseRow)).toEqual({ name: "refactor", description: "" });
  });

  it("keeps a present description", () => {
    expect(workspaceFormFromRow({ ...baseRow, description: "the big one" })).toEqual({
      name: "refactor",
      description: "the big one",
    });
  });
});

describe("toCreateWorkspace", () => {
  it("trims the name and omits an empty description", () => {
    expect(toCreateWorkspace({ name: "  refactor ", description: "  " })).toEqual({ name: "refactor" });
  });

  it("includes a trimmed description when present", () => {
    expect(toCreateWorkspace({ name: "a", description: " note " })).toEqual({ name: "a", description: "note" });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/frontend && bun test src/lib/__tests__/workspace-form.test.ts
```
Expected: FAIL — cannot resolve `@/types/workspace`.

- [ ] **Step 3: Write the types**

Create `apps/frontend/src/types/workspace.ts`:

```ts
/** A workspace as returned by the workspaces API. */
export interface WorkspaceRow {
  /** Workspace id */
  id: string;
  /** Name, unique per user */
  name: string;
  /** Optional longer description */
  description: string | null;
  /** Saved canvas pan, x axis */
  canvasX: number;
  /** Saved canvas pan, y axis */
  canvasY: number;
  /** Created timestamp (ISO 8601) */
  createdAt: string;
  /** Updated timestamp (ISO 8601) */
  updatedAt: string;
}

/** One window on a workspace canvas, with its session's summary joined in. */
export interface WorkspacePaneRow {
  /** Pane id */
  id: string;
  /** Session rendered in this pane */
  sessionId: string;
  /** Canvas x of the top-left corner */
  x: number;
  /** Canvas y of the top-left corner */
  y: number;
  /** Window width in canvas units */
  width: number;
  /** Window height in canvas units */
  height: number;
  /** Stacking order */
  zIndex: number;
  /** True when collapsed to the title bar */
  collapsed: boolean;
  /** Session display name, for the pane title */
  sessionName: string;
  /** "running" | "terminated" */
  sessionStatus: string;
  /** False once the harness process has exited */
  sessionAlive: boolean;
  /** Absolute working directory of the session */
  workingDir: string;
}

/** A workspace plus its panes, as returned by `GET /api/workspaces/:id`. */
export interface WorkspaceDetail {
  /** The workspace itself */
  workspace: WorkspaceRow;
  /** Windows on its canvas */
  panes: WorkspacePaneRow[];
}
```

- [ ] **Step 4: Write the form helpers**

Create `apps/frontend/src/lib/workspace-form.ts`:

```ts
import type { WorkspaceRow } from "@/types/workspace";

/** Live form state shared by the workspace create form and rename. */
export interface WorkspaceFormValue {
  /** Workspace name */
  name: string;
  /** Optional description; empty string means none */
  description: string;
}

/** Blank form state for the create dialog. */
export function emptyWorkspaceForm(): WorkspaceFormValue {
  return { name: "", description: "" };
}

/** Maps a row to form state; a null description becomes an empty string. */
export function workspaceFormFromRow(row: WorkspaceRow): WorkspaceFormValue {
  return { name: row.name, description: row.description ?? "" };
}

/** Builds the create/update body, trimming and dropping an empty description. */
export function toCreateWorkspace(v: WorkspaceFormValue): { name: string; description?: string } {
  const description = v.description.trim();
  return description ? { name: v.name.trim(), description } : { name: v.name.trim() };
}
```

- [ ] **Step 5: Run the test again**

```bash
cd apps/frontend && bun test src/lib/__tests__/workspace-form.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the data hooks**

Create `apps/frontend/src/hooks/use-workspaces.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { WorkspaceRow } from "@/types/workspace";

/** Shared query for the caller's workspaces. */
export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: () => apiFetch<WorkspaceRow[]>("/api/workspaces"),
  });
}
```

Create `apps/frontend/src/hooks/use-workspace.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { WorkspaceDetail } from "@/types/workspace";

/**
 * One workspace with its panes.
 *
 * Polled on an interval so a pane notices its session exiting, matching what
 * the full-page session view does.
 */
export function useWorkspace(id: string) {
  return useQuery({
    queryKey: ["workspace", id],
    queryFn: () => apiFetch<WorkspaceDetail>(`/api/workspaces/${id}`),
    refetchInterval: 5000,
  });
}
```

- [ ] **Step 7: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/src/types/workspace.ts apps/frontend/src/lib/workspace-form.ts apps/frontend/src/lib/__tests__/workspace-form.test.ts apps/frontend/src/hooks/use-workspace.ts apps/frontend/src/hooks/use-workspaces.ts
git commit -m "feat(workspaces): client types, form helpers and data hooks"
```

---

### Task 7: Workspace list route and sidebar entry

**Files:**
- Create: `apps/frontend/src/routes/workspaces.tsx`
- Modify: `apps/frontend/src/components/app-sidebar.tsx`

**Interfaces:**
- Consumes: `useWorkspaces` (Task 6), `emptyWorkspaceForm`/`toCreateWorkspace` (Task 6), `apiFetch`.
- Produces: route `/workspaces`; link target `/workspaces/$id` used by Task 9.

- [ ] **Step 1: Build the list route**

Create `apps/frontend/src/routes/workspaces.tsx`, following the shape of `mounts.tsx`: a header with a "New workspace" button, an inline create card with name + description inputs, and a grid of cards. Each card links to `/workspaces/$id` and has a delete button.

```tsx
export const Route = createFileRoute("/workspaces")({
  component: WorkspacesPage,
});
```

Create posts `toCreateWorkspace(form)` to `/api/workspaces`, then invalidates `["workspaces"]`. Delete confirms first, then `DELETE /api/workspaces/:id` and the same invalidation. Surface errors into an `error` state rendered above the grid, exactly as `mounts.tsx` does. A 409 from a duplicate name must show its message rather than failing silently.

- [ ] **Step 2: Add the sidebar entry**

In `apps/frontend/src/components/app-sidebar.tsx` add to `NAV_ITEMS`, after the Sessions entries and before Profiles:

```tsx
{ to: "/workspaces", label: "Workspaces", icon: LayoutDashboard, short: "Wksp" },
```

Import `LayoutDashboard` from `lucide-react`.

- [ ] **Step 3: Verify and drive it**

```bash
bun run verify-types && bun run lint:check && bun run test
bun run start
```
At `http://localhost:5174/workspaces`: create one, see it listed, create a second with the same name and confirm the 409 message shows, then delete one.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/routes/workspaces.tsx apps/frontend/src/components/app-sidebar.tsx
git commit -m "feat(workspaces): workspace list route and sidebar entry"
```

---

### Task 8: `<WorkspacePane>` — one window

**Files:**
- Create: `apps/frontend/src/components/workspace-pane.tsx`

**Interfaces:**
- Consumes: `SessionTerminal` + `SessionTerminalProps` (Task 1), `WorkspacePaneRow` (Task 6), `clampPaneSize`/`MIN_PANE_SIZE` (Task 5).
- Produces:
```ts
export interface WorkspacePaneProps {
  pane: WorkspacePaneRow;
  active: boolean;                                  // from paneIsVisible
  expanded: boolean;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, width: number, height: number) => void;
  onRaise: (id: string) => void;
  onExpand: (id: string) => void;
  onCollapseExpanded: () => void;
  onRemove: (id: string) => void;
  onRestart: (sessionId: string) => void;
}
export function WorkspacePane(props: WorkspacePaneProps): JSX.Element;
```

- [ ] **Step 1: Build the window frame**

An absolutely-positioned box at `pane.x`/`pane.y` sized `pane.width`/`pane.height`, `zIndex: pane.zIndex`, with:
- a **title bar**: session name, truncated `workingDir`, a status dot (green running / amber exited / grey terminated), an expand button, and a close (remove pane) button
- a **body**: `<SessionTerminal sessionId={pane.sessionId} active={active} showUploads />`
- a **resize handle** in the bottom-right corner

The title bar is the drag handle and the corner is the resize handle. **Do not attach drag handlers to the body** — xterm needs those clicks for selection and focus.

- [ ] **Step 2: Implement dragging from the title bar**

Use pointer events with capture so a fast drag does not escape the element:

```tsx
function onPointerDown(e: React.PointerEvent) {
  if (e.button !== 0) return;
  e.currentTarget.setPointerCapture(e.pointerId);
  const start = { px: e.clientX, py: e.clientY, x: pane.x, y: pane.y };
  dragRef.current = start;
  onRaise(pane.id);
}
function onPointerMove(e: React.PointerEvent) {
  const d = dragRef.current;
  if (!d) return;
  onMove(pane.id, d.x + (e.clientX - d.px), d.y + (e.clientY - d.py));
}
function onPointerUp(e: React.PointerEvent) {
  dragRef.current = null;
  e.currentTarget.releasePointerCapture(e.pointerId);
}
```

Resizing works the same way from the corner handle, passing the result through `clampPaneSize` before calling `onResize`.

- [ ] **Step 3: Add the hover peek**

```tsx
className={cn(
  "absolute overflow-hidden rounded-lg border bg-[#0f1216] shadow transition-transform duration-150",
  !expanded && "hover:z-50 hover:scale-[1.06] hover:shadow-xl",
)}
```

This is **CSS only — no re-fit, no resize frame**. Growing the terminal for real would change its cols/rows and make the agent re-wrap its output; on pointer-over that would reflow every session the cursor passes. Do not "improve" this by calling `fit()` on hover.

Suppress the hover transform while `expanded` is true, and while a drag or resize is in progress, or the pane will jump under the pointer.

- [ ] **Step 4: Render the non-running states**

When `pane.sessionStatus === "running" && !pane.sessionAlive` (exited) or `pane.sessionStatus === "terminated"`, render a small centred panel instead of the terminal with **Restart** (calls `onRestart(pane.sessionId)`) and **Remove pane** (calls `onRemove(pane.id)`). Deleted sessions need no branch — the FK cascade removes the pane server-side and it disappears on the next poll.

- [ ] **Step 5: Verify and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/src/components/workspace-pane.tsx
git commit -m "feat(workspaces): WorkspacePane window with drag, resize and hover peek

Hover is a CSS transform only: re-fitting a terminal sends a resize frame
and makes the agent re-wrap, which must not happen on pointer-over."
```

---

### Task 9: `<WorkspaceCanvas>` — pan, virtualization, layout persistence

**Files:**
- Create: `apps/frontend/src/components/workspace-canvas.tsx`
- Create: `apps/frontend/src/hooks/use-pane-layout.ts`
- Create: `apps/frontend/src/routes/workspaces_.$id.tsx`

**Interfaces:**
- Consumes: `WorkspacePane` (Task 8), `useWorkspace` (Task 6), `paneIsVisible`/`screenToCanvas`/`nextPanePosition` (Task 5).
- Produces:
```ts
export function usePaneLayout(workspaceId: string, initial: WorkspacePaneRow[]): {
  panes: WorkspacePaneRow[];
  movePane: (id: string, x: number, y: number) => void;
  resizePane: (id: string, width: number, height: number) => void;
  raisePane: (id: string) => void;
  removePane: (id: string) => Promise<void>;
  flush: () => void;
};
export function WorkspaceCanvas(props: { detail: WorkspaceDetail }): JSX.Element;
```

- [ ] **Step 1: Write the layout hook with a debounced save**

`usePaneLayout` holds panes in local state — local state is authoritative during a gesture, so dragging never waits on the network. After the last change it saves once:

```ts
const SAVE_DEBOUNCE_MS = 800;
```

`PUT /api/workspaces/:id/panes` with the **full** pane set. Also flush on unmount and on `visibilitychange` when the document becomes hidden, so a closed tab does not lose the last drag. If a save is already in flight when the next fires, drop the in-flight one rather than queueing — the newer payload carries the complete state anyway.

- [ ] **Step 2: Build the canvas surface**

Drive it from the hook and local viewport state:

```tsx
const { panes, movePane, resizePane, raisePane, removePane } = usePaneLayout(
  detail.workspace.id,
  detail.panes,
);
const [viewport, setViewport] = useState<Viewport>({
  x: detail.workspace.canvasX,
  y: detail.workspace.canvasY,
});
```

The surface is a `relative overflow-hidden` container filling the viewport below the header, holding one absolutely-positioned layer:

```tsx
<div style={{ transform: `translate(${viewport.x}px, ${viewport.y}px)` }} className="absolute inset-0">
```

There is **no scale** in that transform, and none should be added.

Pan by dragging the background (or middle-dragging anywhere), using the same pointer-capture pattern as Task 8. Save the viewport with a debounced `PUT /api/workspaces/:id` carrying `canvasX`/`canvasY`.

- [ ] **Step 3: Wire up virtualization**

Track the container's size with a `ResizeObserver`, then compute per pane:

```ts
const visible = paneIsVisible(pane, viewport, containerSize);
```

Pass it as `active` to `<WorkspacePane>`. **Debounce the false transition by ~2s** so panning across the canvas does not tear down every terminal it sweeps past; the true transition applies immediately so a pane coming into view attaches at once.

```ts
const DETACH_DEBOUNCE_MS = 2000;
```

- [ ] **Step 4: Build the route**

`apps/frontend/src/routes/workspaces_.$id.tsx` stays thin: read the id from params, call `useWorkspace(id)`, render a header (name, back link, and — once Task 11 lands — `<AddPaneMenu workspaceId={id} existing={detail.panes} onAdded={refetch} />`) plus `<WorkspaceCanvas detail={detail} />`. Show a "workspace not found" card when the query 404s, mirroring `mounts_.$id.tsx`.

Until Task 11 exists, leave the header's add slot empty rather than stubbing a component — the canvas is testable with panes inserted directly through the API.

- [ ] **Step 5: Verify and drive it**

```bash
bun run verify-types && bun run lint:check && bun run test
bun run start
```
With two panes on a canvas, confirm: dragging a window moves it and it stays put after a reload; panning the background works and the offset survives a reload; dragging a pane far off-screen closes its socket (its DevTools WS entry disappears) after ~2s and bringing it back re-attaches and repaints via replay.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/components/workspace-canvas.tsx apps/frontend/src/hooks/use-pane-layout.ts apps/frontend/src/routes/workspaces_.\$id.tsx
git commit -m "feat(workspaces): pannable canvas with viewport virtualization

Only panes near the viewport keep a socket and a WebGL context. Detach is
debounced so a pan across the canvas does not tear down every terminal it
sweeps past; attach is immediate."
```

---

### Task 10: Expand a pane to full view

**Files:**
- Modify: `apps/frontend/src/components/workspace-canvas.tsx`, `apps/frontend/src/components/workspace-pane.tsx`

- [ ] **Step 1: Add expanded state to the canvas**

`const [expandedPaneId, setExpandedPaneId] = useState<string | null>(null)` — component state only. **Do not persist it**: reopening a workspace always lands on the canvas.

- [ ] **Step 2: Expand without remounting the terminal**

This is the one subtle part of the task. The expanded pane must be **the same mounted `<WorkspacePane>`**, keeping its position in the React tree, with only its own container's style changing:

```tsx
style={
  expanded
    ? { position: "fixed", inset: "3.5rem 1rem 1rem", zIndex: 100 }
    : { position: "absolute", left: pane.x, top: pane.y, width: pane.width, height: pane.height, zIndex: pane.zIndex }
}
```

**Never** render the expanded pane from a different branch of the tree (a portal, a separate `{expanded && <WorkspacePane …/>}` block, or a Dialog that mounts its own children). React would unmount and remount it, and a remount here means dispose + re-attach + a full history replay — exactly what this design avoids. The pane keeps its `key` and its slot in the list; only styles change.

The existing `ResizeObserver` in `SessionTerminal` picks up the size change and calls `fit()` once, which is the single resize frame this costs.

- [ ] **Step 3: Add the affordances**

Clicking the title bar (not the buttons) or the expand button calls `onExpand(pane.id)`. While expanded, render a dimmed backdrop behind it whose click collapses, and bind Escape:

```tsx
useEffect(() => {
  if (!expandedPaneId) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setExpandedPaneId(null);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [expandedPaneId]);
```

Suppress drag and resize handlers while expanded — the pane's canvas geometry must be untouched so collapsing returns it exactly where it was.

- [ ] **Step 4: Mount the expanded-only chrome**

Per the spec's pane-vs-expanded split, an expanded pane grows a header carrying what does not
fit in a small window:

- **Terminate** (running), **Restart** and **Delete** (exited or terminated) — the same
  `POST /api/sessions/:id/terminate`, `/restart` and `DELETE /api/sessions/:id` calls
  `sessions_.$id.tsx` makes. Deleting removes the pane too, via the FK cascade.
- **`<TranscriptSearch>`**, fed the `search` addon that `SessionTerminal` hands back through
  `onReady`.

Do **not** add the `/` command palette. The canvas never swallows a keystroke — `/` goes to the
session in a pane and in an expanded pane alike, and the palette stays a `/sessions/:id`
feature. This keeps the subtle key-interception logic in exactly one place.

- [ ] **Step 5: Verify the claim that makes this worth doing**

```bash
bun run start
```
Open DevTools → Network → WS. Expand a pane and confirm: **no new WebSocket is opened, and the existing one is not closed**. If you see a new socket, the terminal remounted — fix the tree position rather than accepting the replay. Then confirm collapsing puts the window back at its exact previous position, and that a long expansion detaches the *other* panes (which is intended).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/components/workspace-canvas.tsx apps/frontend/src/components/workspace-pane.tsx
git commit -m "feat(workspaces): click a pane to expand it to full view

The expanded pane is the same mounted component with different styles, not
a second terminal, so expanding costs one resize frame rather than a
detach, re-attach and full history replay."
```

---

### Task 11: Add panes, and document the feature

**Files:**
- Create: `apps/frontend/src/components/add-pane-menu.tsx`
- Modify: `apps/frontend/src/routes/workspaces_.$id.tsx`, `README.md`, `docs/overview.md`

**Interfaces:**
- Consumes: `nextPanePosition` (Task 5), `useProfiles` (`@/hooks/use-profiles`), `useMounts` (`@/hooks/use-mounts`), `SessionView` (`@/types/session`).
- Produces:
```ts
export interface AddPaneMenuProps {
  workspaceId: string;
  existing: WorkspacePaneRow[];
  onAdded: () => void;   // refetch the workspace
}
export function AddPaneMenu(props: AddPaneMenuProps): JSX.Element;
```

- [ ] **Step 1: Build "Attach existing session"**

A dropdown listing the caller's sessions from `GET /api/sessions`, excluding ones already on this canvas. Choosing one POSTs to `/api/workspaces/:id/panes`:

```ts
const at = nextPanePosition(existing);
await apiFetch(`/api/workspaces/${workspaceId}/panes`, {
  method: "POST",
  body: JSON.stringify({ ...at, width: 640, height: 420, sessionId }),
});
```

Then call `onAdded()`.

- [ ] **Step 2: Build "New session here"**

A small dialog with the profile and mount pickers already used by `/new`, reusing `useProfiles` and `useMounts` rather than duplicating the form. On submit: `POST /api/sessions` to create the session, then `POST /api/workspaces/:id/panes` with the returned id and `nextPanePosition(existing)`. If the pane POST fails after the session was created, surface the error and leave the session — it is reachable from `/` and attaching it is one more click, which beats silently deleting a session the user just launched.

- [ ] **Step 3: Wire Restart**

`onRestart(sessionId)` in the canvas calls `POST /api/sessions/:id/restart`, which mints a **new** session id. Repoint the pane at it in place so the window keeps its position: remove the old pane and add one at the same geometry with the new session id, then refetch.

- [ ] **Step 4: Document the feature**

In `README.md`, add to the feature list:

```markdown
- **Workspaces** — a saved canvas of session windows; drag to arrange, hover to peek,
  click to expand. Off-screen panes detach automatically.
```

In `docs/overview.md`, add a row to the key-decisions table:

```markdown
| Workspaces | Per-user canvas of session panes; **no zoom** (a scaled xterm blurs and loses its mouse mapping) — hover peeks, click expands. Off-screen panes detach to free sockets and WebGL contexts |
```

Add a Key flows entry:

```markdown
6. **Workspace** (`/workspaces/:id`): panes attach only while near the viewport; expanding
   re-parents the existing terminal rather than mounting a second one
```

- [ ] **Step 5: Full verification**

```bash
turbo build
bun run verify-types && bun run lint:check && bun run test
```
Expected: all pass.

- [ ] **Step 6: Drive the whole feature end to end**

```bash
bun run start
```
Create a workspace, attach two existing sessions and launch a third into the canvas, arrange them, reload and confirm the layout is exactly as left, expand one and confirm no new WebSocket opens, terminate a session and confirm its pane offers Restart, restart it and confirm the window keeps its place, then delete a session from `/sessions` and confirm its pane disappears from the canvas on the next poll (the FK cascade).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/components/add-pane-menu.tsx apps/frontend/src/routes/workspaces_.\$id.tsx README.md docs/overview.md
git commit -m "feat(workspaces): add panes by attaching or launching a session

Restart repoints the pane at the new session id in place, so the window
keeps its position on the canvas."
```

---

## Done when

- `/workspaces` lists, creates and deletes workspaces; names are unique per user.
- `/workspaces/:id` shows a pannable canvas of session windows that survive a reload.
- Panes far from the viewport hold no socket; bringing them back re-attaches and repaints.
- Hovering peeks without sending a resize frame; expanding re-uses the same terminal.
- Terminated sessions offer Restart in place; deleted sessions take their panes with them.
- `bun run verify-types`, `bun run lint:check` and `bun run test` all pass, and CI is green.
