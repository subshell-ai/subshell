# Sessions → Subshells rename + Clone action + Profiles icon — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the product entity "session" to "subshell" across code, wire, and DB (no back-compat); add a "Clone…" actions-menu item that relaunches a subshell from the same node+profile+dir with an optional name; give the Profiles nav item the `SlidersHorizontal` icon.

**Architecture:** Spec `docs/superpowers/specs/2026-09-02-sessions-to-subshells-design.md` is the source of truth — read it first. Phase A (Clone + icon) lands on today's vocabulary; Phase B renames in four lockstep waves (protocol package → backend/packages/agent → frontend → mobile), then e2e/docs/rollout.

**Tech Stack:** Bun workspaces + Turborepo, ElysiaJS, Kysely/SQLite, React 19 + TanStack Router/Query, Expo/React Native (treaty client), Playwright e2e, `bun test` (NOT vitest), Biome.

## Global Constraints

- Package manager: **bun only** (`bun install`, `bunx`; never npm/npx). Pinned versions only.
- Verification after every code task, all three, from repo root: `bun run verify-types && bun run lint:check && bun run test` (lint:check is the read-only one; use `bun run lint` to fix).
- No dynamic imports anywhere (breaks `bun build --compile`).
- New migrations must exist in `apps/backend/src/db/migrations/` **and** be registered in the static map in `apps/backend/src/db/migrate.ts` (file name == map key).
- Test files live in `__tests__/` next to the code; component tests use `@testing-library/react` + happy-dom (preloaded via `bunfig.toml`).
- The e2e suite (`bun run test:e2e`) is NOT part of `bun run test`; run only the touched specs.
- **Boundary rule (spec §1.1) — the KEEP list.** These "session" senses NEVER rename:
  - `harnessSession`, `harnessSessionId`, `harness_session_id` (the harness CLI's own session id; also `--resume` flag strings in `packages/harnesses`).
  - better-auth *session* tokens in `apps/backend/src/auth.ts` / `src/auth/` / `src/plugins/auth.plugin.ts` / `src/lib/auth*`, and the frontend's auth-session helpers `getSessionUser`, `useCurrentUser` + the better-auth `get-session` endpoint string in `apps/frontend/src/lib/auth.ts` (and mobile's equivalent).
  - The generic socket sense in `apps/backend/src/ws/ws.plugin.ts` comments.
- Working branch: `feat/subshell-rename-clone-icon` (already checked out; spec commit `4c63218` on it). **Never push; never touch the live systemd services.**
- Commit style: conventional commits as in `git log` (e.g. `feat(frontend): …`, `refactor(backend): …`). Pre-commit hook runs automatically (do NOT use `--no-verify`).

---

## Phase A — Clone action + Profiles icon (pre-rename vocabulary)

### Task 1: Profiles icon in the sidebar

**Files:**
- Create: `apps/frontend/src/components/__tests__/app-sidebar.test.ts`
- Modify: `apps/frontend/src/components/app-sidebar.tsx:2,34`

**Interfaces:**
- Consumes: `visibleNavItems(isAdmin: boolean | undefined): readonly NavItem[]` (exported, pure; `NavItem = { to, label, icon: LucideIcon, short?, requiresAdmin? }`).
- Produces: NAV_ITEMS where Profiles' `icon === SlidersHorizontal` and Server's `icon === Settings`.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/__tests__/app-sidebar.test.ts` (pure module test — no DOM render; imports only `visibleNavItems`, whose module-level imports stay inert):

```ts
import { describe, expect, it } from "bun:test";
import { Settings, SlidersHorizontal } from "lucide-react";
import { visibleNavItems } from "@/components/app-sidebar";

describe("sidebar nav icons (spec 2026-09-02 §3)", () => {
  const items = visibleNavItems(true);

  it("Profiles uses SlidersHorizontal, not the Server gear", () => {
    expect(items.find((i) => i.to === "/profiles")?.icon).toBe(SlidersHorizontal);
  });

  it("Server keeps the plain Settings gear", () => {
    expect(items.find((i) => i.label === "Server")?.icon).toBe(Settings);
  });

  it("no two visible items share an icon", () => {
    const icons = items.map((i) => i.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/frontend && bun test src/components/__tests__/app-sidebar.test.ts`
Expected: FAIL — "Profiles uses SlidersHorizontal" (got `Settings`).

- [ ] **Step 3: Implement**

In `app-sidebar.tsx`: add `SlidersHorizontal` to the lucide import (line 2, alphabetical: after `Settings`), and change line 34 to:

```ts
  { to: "/profiles", label: "Profiles", icon: SlidersHorizontal, short: "Prof" },
```

Update the comment above NAV_ITEMS only if it mentions profiles' gear (it doesn't). No other icon changes here — the wider audit of profile-representing icons (page headers, cards, mobile nav) runs in Task 6 Step 1 as part of the frontend sweep: `grep -rn "Settings" apps/frontend/src apps/mobile --include='*.tsx' | grep -vi settings\.route\|/settings` and align any profile surface found.

- [ ] **Step 4: Run tests, verify green**

Run: `cd apps/frontend && bun test src/components/__tests__/app-sidebar.test.ts` → PASS (3 tests).

- [ ] **Step 5: Full verification + commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/src/components/app-sidebar.tsx apps/frontend/src/components/__tests__/app-sidebar.test.ts
git commit -m "feat(frontend): Profiles nav gets SlidersHorizontal — no longer shares the Server gear"
```

(Hereafter "VERIFY" = the three root commands; run them before every commit and fix before proceeding.)

### Task 2: Clone dialog component

**Files:**
- Create: `apps/frontend/src/components/clone-subshell-dialog.tsx`
- Create: `apps/frontend/src/components/__tests__/clone-subshell-dialog.test.tsx`

**Interfaces:**
- Consumes: `SessionView` (`@/types/session` — fields `profileId`, `harnessId`, `nodeId?`, `workingDir`), `useCreateSession` / `CreateSessionInput` (`@/hooks/use-create-session`), `createSessionErrorMessage(err, fallback)` (`@/lib/create-session-error`), `useProfiles({ node: "any" })` → `ProfileRow[]` (has `id`,`name`,`harnessId`), `useNodes()` → `{ nodes: Node[] } | undefined`, `nodeOptionLabel(node, localLabel)` (`@/lib/node-label`), `NAME_MAX_DEFAULT`, dialog primitives from `@/components/ui/dialog` (`Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle`), `Button`, `Input`, `Label`.
- Produces: `CloneSubshellDialog(props: { source: SessionView; open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element | null` and pure `cloneInputFromSource(source: SessionView, name: string): CreateSessionInput`. Named entity- neutrally per spec §2 (file survives the rename waves unchanged).

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/components/__tests__/clone-subshell-dialog.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CloneSubshellDialog, cloneInputFromSource } from "@/components/clone-subshell-dialog";
import type { SessionView } from "@/types/session";

/** Minimal full view (mirrors session-actions-menu's fixture) with overrides. */
function makeSource(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "src-1", profileId: "profile-1", harnessId: "claude", nodeId: "mac-mini",
    nodeOffline: false, name: "source", nameLocked: false, terminalReplayLines: null,
    workingDir: "/home/theo/projects/demo", status: "running",
    createdAt: "2026-09-02T00:00:00.000Z", endedAt: null, lastOutputAt: null,
    notes: null, activity: "idle", alive: true, exitCode: null, startedAt: null,
    backoffCount: 0, restartOnExit: false, nextRestartAt: null, notify: false,
    waitingSince: null, access: "owner", ...overrides,
  };
}

describe("cloneInputFromSource", () => {
  it("copies profile/dir/node and trims the name; absent node means local", () => {
    expect(cloneInputFromSource(makeSource(), "  Copy  ")).toEqual({
      profileId: "profile-1", workingDir: "/home/theo/projects/demo", nodeId: "mac-mini", name: "Copy",
    });
    expect(cloneInputFromSource(makeSource({ nodeId: undefined }), "").nodeId).toBe("local");
  });
});

describe("CloneSubshellDialog", () => {
  afterEach(cleanup);

  /** Records fetch calls; profiles/node lists answer with one row each;
   *  the create POST answers with a new id. */
  function mockFetch(createBody?: unknown) {
    const calls: { method: string; url: string; body: string | undefined }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
      if (url.pathname === "/api/profiles")
        return Promise.resolve(new Response(JSON.stringify([{ id: "profile-1", name: "Claude", harnessId: "claude" }])));
      if (url.pathname === "/api/nodes")
        return Promise.resolve(new Response(JSON.stringify({ nodes: [{ id: "mac-mini", kind: "agent", status: "ready", name: "mac-mini", os: "darwin", arch: "arm64", harnesses: [] }] })));
      if (createBody !== undefined) return Promise.resolve(new Response(JSON.stringify(createBody), { status: 409 }));
      return Promise.resolve(new Response(JSON.stringify({ id: "new-1" })));
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
  }

  /** Renders the dialog inside a throwaway router (it calls useNavigate). */
  function renderDialog(source: SessionView, onOpenChange = (_: boolean) => {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <CloneSubshellDialog source={source} open onOpenChange={onOpenChange} />,
    });
    const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]), history: createMemoryHistory({ initialEntries: ["/"] }), defaultPreload: false });
    return render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it("shows the copied node, profile and working directory read-only and launches with the typed name", async () => {
    const { calls, restore } = mockFetch();
    try {
      renderDialog(makeSource());
      expect(await screen.findByText("mac-mini · darwin/arm64")).toBeDefined();
      expect(screen.getByText("Claude (claude)")).toBeDefined();
      expect(screen.getByText("/home/theo/projects/demo")).toBeDefined();
      fireEvent.change(screen.getByRole("textbox", { name: "Clone name" }), { target: { value: "demo copy" } });
      fireEvent.click(screen.getByRole("button", { name: "Launch clone" }));
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "POST", url: "/api/sessions",
          body: JSON.stringify({ profileId: "profile-1", workingDir: "/home/theo/projects/demo", nodeId: "mac-mini", name: "demo copy" }),
        }),
      );
    } finally { restore(); }
  });

  it("a rejected launch shows the mapped error and keeps the dialog open", async () => {
    const { restore } = mockFetch({ message: "node is offline", code: "NODE_OFFLINE" });
    try {
      let closed: boolean | undefined;
      renderDialog(makeSource(), (o) => { closed = o; });
      fireEvent.click(screen.getByRole("button", { name: "Launch clone" }));
      expect(await screen.findByText(/start its subshell or pick another node/i)).toBeDefined();
      expect(closed).toBeUndefined();
    } finally { restore(); }
  });
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `cd apps/frontend && bun test src/components/__tests__/clone-subshell-dialog.test.tsx`
Expected: FAIL — cannot resolve `@/components/clone-subshell-dialog`.

- [ ] **Step 3: Implement the component**

Create `apps/frontend/src/components/clone-subshell-dialog.tsx`:

```tsx
import { useNavigate } from "@tanstack/react-router";
import { useState, type JSX } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCreateSession, type CreateSessionInput } from "@/hooks/use-create-session";
import { useNodes } from "@/hooks/use-nodes";
import { useProfiles } from "@/hooks/use-profiles";
import { createSessionErrorMessage } from "@/lib/create-session-error";
import { nodeOptionLabel } from "@/lib/node-label";
import { NAME_MAX_DEFAULT } from "@/lib/name-limits";
import type { SessionView } from "@/types/session";

/**
 * The launch input a clone copies from its source: same profile, same
 * directory, same node; only the (optional) name is the operator's. An
 * absent nodeId on an older cached view means "local" (the server default).
 * Pure so the mapping is testable without a dialog.
 */
export function cloneInputFromSource(source: SessionView, name: string): CreateSessionInput {
  return {
    profileId: source.profileId,
    workingDir: source.workingDir,
    name,
    nodeId: source.nodeId ?? "local",
  };
}

/**
 * Clone = launch a fresh copy of THIS subshell's launch (spec 2026-09-02 §2):
 * node, profile and working directory are copied read-only, the name is the
 * only input, and the POST runs under the CALLER's credentials — the clone
 * is owned by whoever launches it, and shares are never copied. Copy here is
 * entity-neutral so the vocabulary rename (spec §1) does not rewrite the UI.
 */
export function CloneSubshellDialog({
  source,
  open,
  onOpenChange,
}: {
  /** The subshell being cloned */
  source: SessionView;
  /** Controlled open state, owned by the actions menu (TitleDialog posture) */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const create = useCreateSession();
  // "any": the source's profile may live on another node than the default list filters.
  const { data: profiles } = useProfiles({ node: "any" });
  const { data: nodeData } = useNodes();
  const profile = (profiles ?? []).find((p) => p.id === source.profileId);
  const node = (nodeData?.nodes ?? []).find((n) => n.id === (source.nodeId ?? "local"));
  // Same display grammar as the launch pickers, so the rows read identical.
  const profileLabel = profile ? `${profile.name} (${profile.harnessId})` : source.harnessId;
  const nodeLabel = node ? nodeOptionLabel(node, "Local") : (source.nodeId ?? "local");

  async function launch() {
    try {
      const created = await create.mutateAsync(cloneInputFromSource(source, name));
      onOpenChange(false);
      void navigate({ to: "/sessions/$id", params: { id: created.id } });
    } catch {
      // The mutation keeps the error; it renders under the name field.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Clone</DialogTitle>
          <DialogDescription>
            Launches a fresh copy with the same node, profile and working directory. Blank name
            defaults to date/time.
          </DialogDescription>
        </DialogHeader>
        <dl className="text-sm">
          <dt className="text-muted-foreground">Node</dt>
          <dd className="mb-2 truncate">{nodeLabel}</dd>
          <dt className="text-muted-foreground">Profile</dt>
          <dd className="mb-2 truncate">{profileLabel}</dd>
          <dt className="text-muted-foreground">Working directory</dt>
          <dd className="mb-3 truncate font-mono text-xs">{source.workingDir}</dd>
        </dl>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="clone-name">
            Name (optional)
          </label>
          <Input
            id="clone-name"
            aria-label="Clone name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX_DEFAULT}
            placeholder="Defaults to date/time"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !create.isPending) void launch();
            }}
          />
          {create.error && (
            <p className="text-destructive text-sm">
              {createSessionErrorMessage(create.error, "Failed to launch the clone")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={create.isPending} onClick={() => void launch()}>
            {create.isPending ? "Starting…" : "Launch clone"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

NOTE: confirm `useNodes()`'s return shape (`nodeData?.nodes`) against `@/hooks/use-nodes` — adapt if it unwraps differently.

- [ ] **Step 4: Run tests, verify green**

Run: `cd apps/frontend && bun test src/components/__tests__/clone-subshell-dialog.test.tsx` → PASS (3 tests). If happy-dom does not paint Base UI dialog content, mirror the open-state trick used in `components/__tests__/title-dialog` consumers (see `notes-dialog.test.tsx` if it exists) rather than changing the component.

- [ ] **Step 5: VERIFY + commit**

```bash
git add apps/frontend/src/components/clone-subshell-dialog.tsx apps/frontend/src/components/__tests__/clone-subshell-dialog.test.tsx
git commit -m "feat(frontend): clone dialog — copies node, profile and dir; name is the only input"
```

### Task 3: Wire "Clone…" into the actions menu

**Files:**
- Modify: `apps/frontend/src/components/session-actions-menu.tsx` (imports, state, items array, dialogs)
- Modify: `apps/frontend/src/components/__tests__/session-actions-menu.test.tsx` (add one test)

**Interfaces:**
- Consumes: `CloneSubshellDialog` from Task 2; existing `canEdit`, `session`, dialogs state pattern.
- Produces: a `menuitem` named `Clone…` visible to `edit`+`owner` that opens the dialog.

- [ ] **Step 1: Write the failing test**

Append to the access-gating describe in `session-actions-menu.test.tsx`:

```tsx
  it("Clone… appears for edit grantees and opens the clone dialog", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSession({ access: "edit" }));
      await openMenu("session");
      fireEvent.click(screen.getByRole("menuitem", { name: "Clone…" }));
      expect(await screen.findByLabelText("Clone name")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Launch clone" })).toBeDefined();
    } finally {
      restore();
    }
  });
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/frontend && bun test src/components/__tests__/session-actions-menu.test.tsx`
Expected: FAIL — no `Clone…` menuitem.

- [ ] **Step 3: Implement**

In `session-actions-menu.tsx`:

1. Imports: add `Copy` to the lucide import list; add
   `import { CloneSubshellDialog } from "@/components/clone-subshell-dialog";`.
2. State: add `const [cloneOpen, setCloneOpen] = useState(false);` beside the others.
3. Items: inside the `canEdit` block that holds Terminate / Restart / Start again (the one ending at the `: []` before the `profile` spread), append the item right after that launch item:

```ts
    ...(canEdit
      ? [
          // …existing Terminate/Start-again item stays…
          {
            icon: Copy,
            label: "Clone…",
            // A clone is a FRESH launch under the caller's account — unlike
            // "Start again", which revives this row. Spec 2026-09-02 §2.
            onSelect: () => setCloneOpen(true),
          },
        ]
      : []),
```

4. Dialogs: add after the `{isOwner && <SharingDialog …/>}` line:

```tsx
      <CloneSubshellDialog
        key={`${session.id}-clone`}
        source={session}
        open={cloneOpen}
        onOpenChange={setCloneOpen}
      />
```

- [ ] **Step 4: Run the menu tests, verify green**

Run: `cd apps/frontend && bun test src/components/__tests__/session-actions-menu.test.tsx` → PASS (existing + new).

- [ ] **Step 5: VERIFY + commit**

```bash
git add apps/frontend/src/components/session-actions-menu.tsx apps/frontend/src/components/__tests__/session-actions-menu.test.tsx
git commit -m "feat(frontend): 'Clone…' action relaunches a copy of the same node+profile+dir"
```

---

## Phase B — the rename waves

### Task 4 (wave 1): rename `@internal/session-protocol` → `@internal/subshell-protocol`

**Files:**
- Move: `packages/session-protocol/` → `packages/subshell-protocol/` (`git mv`)
- Modify: `packages/subshell-protocol/package.json` (`"name"`), every `from "@internal/session-protocol"` import, root/`AGENTS.md` + root `CLAUDE.md` mentions, `apps/frontend/AGENTS.md`, `apps/backend/AGENTS.md`, `apps/agent/AGENTS.md` package lists, `turbo.json` if it names the package.

**Interfaces:**
- Produces: workspace package `@internal/subshell-protocol`, same exports.

- [ ] **Step 1:** `git mv packages/session-protocol packages/subshell-protocol`
- [ ] **Step 2:** `sed -i 's/@internal\/session-protocol/@internal\/subshell-protocol/g' $(grep -rl '@internal/session-protocol' apps packages --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' | grep -v node_modules)` — plus edit `packages/subshell-protocol/package.json` name field with the same substitution. Also `grep -rn "session-protocol" .` (excluding node_modules, dist, docs/superpowers/specs+plans, package-lock) and fix the remaining doc/AGENTS mentions.
- [ ] **Step 3:** `bun install` (relinks the workspace), then VERIFY.
- [ ] **Step 4:** `git add -A && git commit -m "refactor(packages): session-protocol → subshell-protocol"`

### Task 5 (wave 2): backend + packages + agent — entity rename, DB migration, wire

The biggest task. Order matters: DB migration first (it defines the storage truth), then the curated sweep, then compiler-guided cleanup.

**Files (main):** `apps/backend/src/**` (routes dir `api/sessions/`→`api/subshells/`, `db/types/sessions.db-types.ts`→`subshells.db-types.ts`, `db/types/session-shares.db-types.ts`→`subshell-shares.db-types.ts`, services, repositories, `ws/session-ws.ts`→`ws/subshell-ws.ts`, `ws/remote-session-ws.ts`→`ws/remote-subshell-ws.ts`, uploads/files/ws-token routes, constants/env), new `apps/backend/src/db/migrations/0019-subshell-rename.ts`, `apps/backend/src/db/migrate.ts`, `packages/mcp-core/src/**`, `packages/harnesses/src/**`, `packages/backend-client/src/**`, `apps/agent/src/**`, plus `git mv` of every file whose name contains `session` (except Global-Constraints keepers).

**Interfaces:**
- Produces (waves 3–4 build on): REST base `/api/subshells`; WS attach query param `subshell`; env `SUBSHELL_ID`, `SUBSHELL_NAME`, `SUBSHELL_SERVER_DATA_DIR`; type `SubshellView` (`packages/backend-client` and frontend each own theirs); Kysely `db.subshells`, `db.subshellShares`, column `subshell_id`; scope permission values remain free-form (no wire change).

- [ ] **Step 1: Write the DB migration**

Create `apps/backend/src/db/migrations/0019-subshell-rename.ts`:

```ts
import type { Kysely } from "kysely";

/**
 * Sessions → Subshells (spec 2026-09-02 §1.3): the entity's tables, columns
 * and indexes adopt the product vocabulary. SQLite rewrites REFERENCES
 * clauses on RENAME TO (legacy_alter_table is off), so the cascade FKs on
 * the renamed columns/tables follow without recreation.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("session_shares").renameTo("subshell_shares").execute();
  await db.schema.alterTable("sessions").renameTo("subshells").execute();
  await db.schema.alterTable("subshell_shares").renameColumn("session_id", "subshell_id").execute();
  await db.schema.alterTable("workspace_panes").renameColumn("session_id", "subshell_id").execute();
  // SQLite has no ALTER INDEX RENAME — drop + recreate (definitions from 0001/0016).
  await db.raw("DROP INDEX idx_session_shares_session").execute();
  await db.raw("CREATE INDEX idx_subshell_shares_subshell ON subshell_shares (subshell_id)").execute();
  await db.raw("DROP INDEX idx_sessions_user_created").execute();
  await db.raw("CREATE INDEX idx_subshells_user_created ON subshells (user_id, created_at)").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.raw("DROP INDEX idx_subshell_shares_subshell").execute();
  await db.raw("CREATE INDEX idx_session_shares_session ON session_shares (session_id)").execute();
  await db.raw("DROP INDEX idx_subshells_user_created").execute();
  await db.raw("CREATE INDEX idx_sessions_user_created ON sessions (user_id, created_at)").execute();
  await db.schema.alterTable("workspace_panes").renameColumn("subshell_id", "session_id").execute();
  await db.schema.alterTable("subshell_shares").renameColumn("subshell_id", "session_id").execute();
  await db.schema.alterTable("subshells").renameTo("sessions").execute();
  await db.schema.alterTable("subshell_shares").renameTo("session_shares").execute();
}
```

**The column/index inventory is verified from the migration sources**: `session_id` exists only on `workspace_panes` (0006) and `session_shares` (0016); `recent_paths` has no such column; `idx_workspace_panes_workspace` names no session word; `harness_session_id` STAYS (harness's own id). If a live schema ever differs, fix the migration to match reality, not the other way round.

Register in `migrate.ts`: import as `subshellRenameMigration` from `@/db/migrations/0019-subshell-rename.js`, map key `"0019-subshell-rename"`.

- [ ] **Step 2: Run the backend test suite to prove the migration applies**

Run: `cd apps/backend && bun test src/db` → PASS (test DBs boot through the real migrator).

- [ ] **Step 3: The curated sweep**

Special replacements FIRST (exact strings, order matters), across `apps/backend/src`, `apps/agent/src`, `packages/*/src`, `packages/*/package.json`, root `AGENTS.md`, app `AGENTS.md`s, `.claude/rules/`:

```bash
grep -rl 'SUBSHELL_SESSION_ID\|SUBSHELL_SESSION_NAME\|SESSION_DATA_DIR' apps packages .claude AGENTS.md | grep -v node_modules | xargs sed -i \
  -e 's/SUBSHELL_SESSION_ID/SUBSHELL_ID/g' \
  -e 's/SUBSHELL_SESSION_NAME/SUBSHELL_NAME/g' \
  -e 's/SESSION_DATA_DIR/SUBSHELL_SERVER_DATA_DIR/g'
```

Then the generic entity sweep with word-boundary `sed` (`\b`) — token by token, longest first, for every token in the inventory this command prints:

```bash
grep -rhoIE '[A-Za-z_]*[Ss][Ee][Ss][Ss][Ii][Oo][Nn][A-Za-z_]*' apps/backend/src apps/agent/src packages/*/src --include='*.ts' | sort -u
```

Classify each printed token ONCE and record the verdict; the default mapping is `session→subshell` in every case (also uppercase/lowercase variants: `Session→Subshell`, `SESSION→SUBSHELL`, `sessions→subshells`, `Sessions→Subshells`, `SESSIONS→SHELLS` is WRONG — treat `SESSIONS_*` explicitly: `SESSIONS_QUERY_KEY` etc. only exist frontend-side). **KEEP tokens** (never rewrite, per Global Constraints): `harnessSession`, `harnessSessionId`, `harness_session_id`, plus any token matched inside the keep-list files. If a KEEP token got swept (`harness_subshell_id`), undo it:

```bash
grep -rl 'harness_subshell' apps packages | xargs sed -i 's/harness_subshell/harness_session/g'
```

Route paths ride the same sweep: `"/api/sessions` → `"/api/subshells`, `/sessions/$id` stays frontend-wave for now, `?session=` → `?subshell=` and `query.session` → `query.subshell` (backend ws), `.ws("/ws"…` unchanged.

- [ ] **Step 4: File/dir renames**

```bash
cd apps/backend/src && for f in $(git ls-files | grep -i session); do git mv "$f" "$(echo "$f" | sed 's/[Ss]ession/Subshell/g; s/session/subshell/g; s/SESSION/SUBSHELL/g')"; done
```

(Adapt casing per file; `git mv` api/sessions/ dir → api/subshells/. Keepers from Global Constraints are not session-named files — re-check each rename.) Same loop in `packages/mcp-core/src`, `packages/harnesses/src`, `apps/agent/src` for session-named files. Fix every now-broken relative import (the compiler lists them all).

- [ ] **Step 5: Compiler-guided cleanup until VERIFY is green**

`bun run verify-types` — fix every error (imports, Kysely type file renames `SessionsTable`→`SubshellsTable`, repository class names `SessionsRepository`→`SubshellsRepository` ride the sweep already). Then `bun run lint:check` (biome sort fixes via `bun run lint`) and `bun run test`. Expect test-file string assertions (`/api/sessions/...` in route tests) to have swept automatically; anything hand-written that compares old strings gets updated.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(backend,agent,packages): sessions → subshells across wire, DB and code"
```

### Task 6 (wave 3): frontend

Same method as Task 5, scoped to `apps/frontend/src` (+ its `AGENTS.md`):

- [ ] **Step 1:** Sweep (specials first: `SUBSHELL_SESSION_ID` none here; `?session=` in `lib/use-session-ws.ts` line ~100 → `?subshell=`; `"/api/sessions` → `"/api/subshells`; `"No sessions yet"`/`"New session"`/`"Session name"` and all UI copy → subshell wording; h1 `Sessions` → `Subshells` in `routes/index.tsx:74`), then rename session-named files, then fix imports.
- [ ] **Step 2:** Route file rename `routes/sessions_.$id.tsx` → `routes/subshells_.$id.tsx` and all `to="/sessions/$id"` → `to="/subshells/$id"`; regenerate the route tree by running `cd apps/frontend && bun run build` once (the TanStack router vite plugin rewrites `routeTree.gen.ts`); `git add src/routeTree.gen.ts`.
- [ ] **Step 3:** VERIFY. The clone dialog and its tests ride the sweep (`CloneSubshellDialog` untouched; `SessionView`→`SubshellView`, navigate target renamed). Mobile is still old-vocabulary but does not import frontend — expect VERIFY to stay green.
- [ ] **Step 4:** `git commit -am "refactor(frontend): sessions → subshells (routes, copy, types, WS param)"`

### Task 7 (wave 4): mobile

Mobile uses the Eden treaty client — property access renames with the routes (`client.sessions()` → `client.subshells()`, `client.sessions(":id")` → `client.subshells(":id")`).

- [ ] **Step 1:** Same sweep scoped to `apps/mobile` (incl. `(tabs)/_layout.tsx` title "Sessions" → "Subshells", `src/types/session.ts` → `subshell.ts`, `lib/session-*` files, `src/lib/node-anchor.ts` comments untouched by KEEP rule).
- [ ] **Step 2:** VERIFY (turbo covers mobile typecheck; run `cd apps/mobile && bun run test` too if it defines tests).
- [ ] **Step 3:** `git commit -am "refactor(mobile): sessions → subshells incl. treaty client call sites"`

### Task 8: e2e + docs + rollout addendum

**Files:** `e2e/tests/01-setup-wizard.spec.ts:37`, `05-workspaces.spec.ts:20`, `08-mobile-shell.spec.ts:100` (+ grep the whole `e2e/` dir for `/sessions/`, `session`, `Session`), `e2e/AGENTS.md` if present, `docs/subshell-rollout.md`, root `AGENTS.md`, `apps/backend/AGENTS.md`, `apps/frontend/AGENTS.md`, `apps/agent/AGENTS.md`, `.claude/rules/security-context.md`, `docs/architecture.md` §4 + `docs/overview.md` vocabulary pass.

- [ ] **Step 1:** Sweep e2e: heading `"Sessions"`→`"Subshells"`, buttons `"New session"`→`"New subshell"` (check the actual post-rename frontend labels — the sweep decides copy: `/new` card title becomes "New subshell"), any `page.goto("/sessions/…")` → `/subshells/…`. Run the three specs: `bun run test:e2e` filtered to files 01, 05, 08 (Playwright: `bunx playwright test 01 05 08` from `e2e/` per its AGENTS.md).
- [ ] **Step 2:** Docs pass: in every file listed above, replace product-entity wording per §1.1 boundary (auth/tmux senses stay); env var table entries `SUBSHELL_SESSION_ID`→`SUBSHELL_ID` etc.
- [ ] **Step 3:** Append to `docs/subshell-rollout.md`:

```markdown
## 2026-09-02: sessions → subshells (breaking)

One-time breaking rename (no aliases): REST /api/sessions→/api/subshells, WS
?session→?subshell, DB tables/columns renamed by migration 0019, env
SUBSHELL_SESSION_ID→SUBSHELL_ID, SUBSHELL_SESSION_NAME→SUBSHELL_NAME,
SESSION_DATA_DIR→SUBSHELL_SERVER_DATA_DIR.

1. Backup the DB, then: bunx turbo build && bun run release:agent
2. Edit the backend unit's EnvironmentFile: rename SESSION_DATA_DIR.
3. systemctl --user restart subshell-server.service  (migration 0019 runs)
4. Re-run the node enroll/update one-liner on every enrolled node.
5. Rebuild + reinstall the mobile app; restart any running harness sessions
   (their baked env vars are gone — their MCP tools break until restart).
```

- [ ] **Step 4:** VERIFY + `git commit -am "docs+e2e: subshell vocabulary, rollout steps for the breaking rename"`

### Task 9: final gate

- [ ] **Step 1:** `grep -rn "sessions" apps packages e2e --include='*.ts' --include='*.tsx' -l | grep -v node_modules | grep -v harness` — inspect every hit against §1.1; only keep-list senses (harness, tmux, ws-generic) may remain. Same for `grep -rni "session" apps/frontend/src --include='*.tsx' | grep -v harness` — the sweep should have left auth-session wording and tmux wording only.
- [ ] **Step 2:** `bun run verify-types && bun run lint:check && bun run test` — all green.
- [ ] **Step 3:** Confirm nothing was pushed and the branch holds the whole change: `git log --oneline main..HEAD`.

## Spec corrections discovered while planning

- Spec §1.2/§1.3 API-key scope rewrite: **not needed** — API keys carry free-form optional permission arrays; no `sessions:*` token exists on the wire or in stored JSON. No rewrite in migration 0019.
- Spec §1.2 WS param: the wire name is `session` (frontend `use-session-ws.ts:100`), renamed to `subshell` — already reflected above.
- Superseded by the spec's "Amendment (2026-09-02, final review)": the first bullet above is wrong — migration 0019 DOES rewrite apikey metadata `{kind,sessionId}` → `{kind,subshellId}` and the permission key `sessions` → `subshells`, roundtrip-tested in `0019-subshell-rename.test.ts`.
