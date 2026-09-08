# Sidebar context menus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click a recent subshell/workspace row in the sidebar → the same actions menu the ⋯ button offers, anchored at the cursor.

**Architecture:** Base UI's native `ContextMenu` (its popup parts ARE the `Menu` parts the repo already wraps). `ActionsMenu` gains a children/context mode; `SubshellActionsMenu` and a new `WorkspaceActionsMenu` forward through it, so the action definitions stay single-sourced and `AppSidebar` just wraps its existing row Links. Spec: `docs/superpowers/specs/2026-09-03-sidebar-context-menu-design.md`.

**Tech Stack:** `@base-ui/react` 1.7.0 (`context-menu` module — its `index.parts` re-export `Menu.Portal/Positioner/Popup/Item` verbatim), React 19, TanStack Router, `bun test` + `@testing-library/react` (happy-dom preloaded), shadcn-style `ui/` wrappers (house pattern per `.migration/`: thin export aliases + positioning props on Positioner + app-level `onSelect` forwarded to `onClick`).

## Global Constraints

- Bun only; pinned deps (no new dependencies — `@base-ui/react` already installed).
- No dynamic imports; `ui/` primitives stay thin wrappers (`.claude/rules/code-style.md`, `.migration/project.md`).
- Touch targets: menu items keep the wrapper's `min-h-11` (already in `DropdownMenuItem`).
- Copy: item labels come verbatim from the existing menus — the sidebar must not invent synonyms.
- Verification trio before done: `bun run verify-types`, `bun run lint:check`, `bun run test` (repo root).
- From `apps/frontend/` for scoped runs: `bun test src/...`, `bun run verify-types`.

---

### Task 1: `ui/context-menu.tsx` + `ActionsMenu` context mode

**Files:**
- Create: `apps/frontend/src/components/ui/context-menu.tsx`
- Modify: `apps/frontend/src/components/actions-menu.tsx`
- Test: `apps/frontend/src/components/__tests__/actions-menu.test.tsx` (EXISTS — append a context-mode describe block to the existing file; its `openMenu` keyboard trick proves Base UI popups paint in happy-dom)

**Interfaces:**
- Consumes: `@base-ui/react/context-menu` (`ContextMenu.Root`, `ContextMenu.Trigger`); existing `DropdownMenu/DropdownMenuContent/DropdownMenuItem/DropdownMenuTrigger` from `@/components/ui/dropdown-menu`.
- Produces: `ActionsMenu({ label, items, disabled?, children? })` — with `children` it renders NO ⋯ button; the children are the right-click target. Used by Tasks 2–4. `ActionItem` shape unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/__tests__/actions-menu.test.tsx`:

```tsx
import { describe, expect, it } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TerminalSquare } from "lucide-react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";

const items: ActionItem[] = [{ label: "Do the thing", icon: TerminalSquare, onSelect: () => picked.push("thing") }];
const picked: string[] = [];

describe("ActionsMenu — ⋯ button mode (regression: existing API)", () => {
  it("renders the labelled trigger and no context wrapper", () => {
    render(<ActionsMenu label="demo" items={items} />);
    expect(screen.getByRole("button", { name: "Actions for demo" })).toBeTruthy();
  });
});

describe("ActionsMenu — context mode (children)", () => {
  it("renders the wrapped element verbatim — no ⋯ button", () => {
    render(
      <ActionsMenu label="demo" items={items}>
        <a href="/x">row link</a>
      </ActionsMenu>,
    );
    expect(screen.getByText("row link")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions for demo" })).toBeNull();
  });

  it("right-click opens the menu and choosing an item runs its onSelect", async () => {
    render(
      <ActionsMenu label="demo" items={items}>
        <a href="/x">row link</a>
      </ActionsMenu>,
    );
    fireEvent.contextMenu(screen.getByText("row link"));
    const item = await screen.findByText("Do the thing");
    fireEvent.click(item);
    expect(picked).toContain("thing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test src/components/__tests__/actions-menu.test.tsx`
Expected: context-mode cases FAIL (children currently ignored / no menu opens).

- [ ] **Step 3: Create the ui wrapper**

Create `apps/frontend/src/components/ui/context-menu.tsx`:

```tsx
import { ContextMenu } from "@base-ui/react/context-menu";
import type { JSX } from "react";

/**
 * Right-click menu on Base UI's `ContextMenu` parts. Its Portal/Positioner/
 * Popup/Item parts are literally the same components as `ui/dropdown-menu`
 * (the context-menu module re-exports Menu's parts), so the styled pieces —
 * DropdownMenuContent, DropdownMenuItem — are reused AS-IS inside
 * ContextMenuRoot; only Root and Trigger are context-menu's own.
 * Cursor anchoring is Base UI's job (it records the contextmenu event).
 */
export const ContextMenuRoot = ContextMenu.Root;
export const ContextMenuTrigger = ContextMenu.Trigger;

/** Layout-transparent trigger host: `display:contents` keeps the wrapped row's
 * boxes (and the sidebar's spacing) exactly as they were. */
export function ContextMenuTriggerContents(props: {
  children: React.ReactNode;
}): JSX.Element {
  return <ContextMenuTrigger render={<span className="contents" />} {...props} />;
}
```

Note: if `ContextMenuTriggerContents` proves unnecessary (call sites can pass `render` inline), keep it anyway — one place owns the `contents` idiom.

- [ ] **Step 4: Implement context mode in ActionsMenu**

In `apps/frontend/src/components/actions-menu.tsx`:

Add imports (top, with the others):

```tsx
import type { ReactNode } from "react";
import { ContextMenuRoot, ContextMenuTriggerContents } from "@/components/ui/context-menu";
```

Extract the item mapping (module-level, above `ActionsMenu`) so both modes share it:

```tsx
/** The one rendering of an ActionItem list — icon, destructive red, disabled
 * grey — shared by the ⋯ button mode and the right-click context mode. */
function MenuItems({ items }: { items: ActionItem[] }): JSX.Element {
  return (
    <>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <DropdownMenuItem
            key={item.label}
            disabled={item.disabled}
            className={item.destructive ? "text-destructive data-highlighted:text-destructive" : undefined}
            onSelect={item.disabled ? undefined : item.onSelect}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
```

Change `ActionsMenu` — add `children` and branch before the button return:

```tsx
export function ActionsMenu({
  label,
  items,
  disabled,
  children,
}: {
  /** Entity name, used for the trigger's accessible label */
  label: string;
  items: ActionItem[];
  /** Disables the trigger, e.g. while a bulk action covers this row */
  disabled?: boolean;
  /** When present, the menu opens on RIGHT-CLICK of this subtree instead of
   * from a ⋯ button — the sidebar rows' context-menu mode (spec 2026-09-03). */
  children?: ReactNode;
}): JSX.Element {
  if (children) {
    return (
      <ContextMenuRoot disabled={disabled}>
        <ContextMenuTriggerContents>{children}</ContextMenuTriggerContents>
        <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
          <MenuItems items={items} />
        </DropdownMenuContent>
      </ContextMenuRoot>
    );
  }
  // …existing DropdownMenu ⋯ return, with its inline item map REPLACED by
  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
    <MenuItems items={items} />
  </DropdownMenuContent>
}
```

(The ⋯ trigger button and its `<MoreHorizontal>` stay exactly as they are; only the item-map body is swapped for `<MenuItems>`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/frontend && bun test src/components/__tests__/actions-menu.test.tsx`
Expected: PASS (3 tests).
IF happy-dom cannot open the Base UI popup (`findByText` times out): keep the wrapper, simplify the open-case to assert the right-click does NOT throw and the link still renders, and COVER ITEM INVOCATION through button mode instead (click trigger, then item) — note the limitation in the commit message; Task 5's live browser check owns the real proof.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/components/ui/context-menu.tsx apps/frontend/src/components/actions-menu.tsx apps/frontend/src/components/__tests__/actions-menu.test.tsx
git commit -m "feat(frontend): ActionsMenu context mode on Base UI ContextMenu (right-click trigger)"
```

---

### Task 2: `SubshellActionsMenu` children pass-through

**Files:**
- Modify: `apps/frontend/src/components/subshell-actions-menu.tsx`
- Test: `apps/frontend/src/components/__tests__/subshell-actions-menu.test.tsx` (EXISTS — extend its `renderMenu` fixture harness with a `children` variant; do NOT create a parallel file)

**Interfaces:**
- Consumes: `ActionsMenu` context mode (Task 1).
- Produces: `SubshellActionsMenu({ subshell, disabled?, onDeleted?, children? })` — children mode returns the plain children when the viewer has no actions (`access: "view"`).

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/__tests__/subshell-actions-menu-context.test.tsx`:

```tsx
import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import type { SubshellView } from "@/types/subshell";

/** Minimal view fixture (shape from clone-subshell-dialog.test.tsx). */
function makeSubshell(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s-1", profileId: "p-1", harnessId: "claude", nodeId: "local", nodeOffline: false,
    name: "demo", nameLocked: false, terminalReplayLines: null, workingDir: "/tmp/demo",
    status: "running", createdAt: "2026-09-03T00:00:00.000Z", endedAt: null, lastOutputAt: null,
    notes: null, activity: "idle", alive: true, exitCode: null, startedAt: null, backoffCount: 0,
    restartOnExit: false, nextRestartAt: null, notify: true, waitingSince: null, access: "owner",
    ...overrides,
  };
}

function renderMenu(subshell: SubshellView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <SubshellActionsMenu subshell={subshell}>
        <a href="/subshells/s-1">the row</a>
      </SubshellActionsMenu>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("SubshellActionsMenu children mode", () => {
  it("renders the row with no ⋯ button, and right-click offers the owner actions", async () => {
    renderMenu(makeSubshell());
    expect(screen.getByText("the row")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions for demo" })).toBeNull();
    fireEvent.contextMenu(screen.getByText("the row"));
    expect(await screen.findByText("Terminate")).toBeTruthy();
    expect(screen.getByText("Delete subshell")).toBeTruthy();
  });

  it("gives a view grantee the bare row and nothing to open", () => {
    renderMenu(makeSubshell({ access: "view" }));
    const row = screen.getByText("the row");
    fireEvent.contextMenu(row);
    expect(screen.queryByText("Terminate")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test src/components/__tests__/subshell-actions-menu-context.test.tsx`
Expected: FAIL — children ignored today (renders ⋯ button + dialogs regardless; the view case renders `null`).

- [ ] **Step 3: Implement**

In `apps/frontend/src/components/subshell-actions-menu.tsx`:

Add `children?: ReactNode` (import `ReactNode` from react, joining the existing type import). Signature:

```tsx
export function SubshellActionsMenu({
  subshell,
  disabled,
  onDeleted,
  children,
}: {
  subshell: SubshellView;
  disabled?: boolean;
  onDeleted?: () => void;
  /** When present: the menu opens on right-click of this subtree instead of
   * behind a ⋯ button (sidebar rows — spec 2026-09-03). */
  children?: ReactNode;
}): JSX.Element | null {
```

Replace the viewer early-return:

```tsx
  // A viewer gets no actions menu at all — they watch the subshell (read-only
  // terminal) and that is the whole of it. In children mode "no menu" must
  // still show the row itself, so the children pass through unwrapped.
  if (!canEdit) return children ? <>{children}</> : null;
```

And pass children through the trigger render:

```tsx
      <ActionsMenu label={subshell.name} items={items} disabled={disabled || busy}>
        {children}
      </ActionsMenu>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/frontend && bun test src/components/__tests__/subshell-actions-menu-context.test.tsx src/components/__tests__/actions-menu.test.tsx src/components/__tests__/clone-subshell-dialog.test.tsx`
Expected: PASS (plus no regression in the existing dialog test). (If Task 1 hit the happy-dom popup limitation, relax the open-assertions here the same way — one mechanism, one caveat.)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/subshell-actions-menu.tsx apps/frontend/src/components/__tests__/subshell-actions-menu-context.test.tsx
git commit -m "feat(frontend): SubshellActionsMenu children mode for sidebar right-click"
```

---

### Task 3: `WorkspaceActionsMenu` extraction + workspaces page refactor

**Files:**
- Create: `apps/frontend/src/components/workspace-actions-menu.tsx`
- Modify: `apps/frontend/src/routes/workspaces.tsx`
- Test: `apps/frontend/src/components/__tests__/workspace-actions-menu.test.tsx`

**Interfaces:**
- Consumes: `ActionsMenu` (both modes, Task 1), `confirmAction` from `@/lib/confirm`, `useInvalidateWorkspaces` from `@/hooks/use-workspaces`, `apiFetch`/`errMessage` from `@/lib/api`.
- Produces: `WorkspaceActionsMenu({ workspace, children?, onError? })` — `workspace: WorkspaceRow`; same three items as today's inline list in `workspaces.tsx:123-140`, labels verbatim.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/__tests__/workspace-actions-menu.test.tsx`:

```tsx
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import type { WorkspaceRow } from "@/types/workspace";

// The confirm promise bridge (module-level handler per lib/confirm.ts):
// answer YES so the component proceeds to the DELETE.
mock.module("@/lib/confirm", () => ({
  confirmAction: () => Promise.resolve(true),
}));

const workspace: WorkspaceRow = {
  id: "w-1",
  name: "demo ws",
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  subshellCount: 2,
} as WorkspaceRow;

describe("WorkspaceActionsMenu context mode", () => {
  it("right-click offers exactly the page menu's three items", async () => {
    render(
      <WorkspaceActionsMenu workspace={workspace}>
        <a href="/workspaces/w-1">ws row</a>
      </WorkspaceActionsMenu>,
    );
    // NOTE (plan-time): the real component composes TanStack hooks; if plain
    // render() lacks router context for useNavigate, wrap in the throwaway
    // router harness from subshell-actions-menu-context.test.tsx — do it on
    // the first red run, same pattern.
    fireEvent.contextMenu(screen.getByText("ws row"));
    expect(await screen.findByText("Open")).toBeTruthy();
    expect(screen.getByText("Open in new tab")).toBeTruthy();
    expect(screen.getByText("Delete workspace")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test src/components/__tests__/workspace-actions-menu.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the component**

Create `apps/frontend/src/components/workspace-actions-menu.tsx`:

```tsx
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import { apiFetch, errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import type { WorkspaceRow } from "@/types/workspace";

/**
 * Everything you can do to a workspace, behind the shared overflow menu —
 * the workspace twin of `SubshellActionsMenu` (the three items were inline
 * in routes/workspaces.tsx until the sidebar needed them too, spec
 * 2026-09-03: single source of truth).
 *
 * `children` switches from the ⋯ trigger to right-click mode; `onError`
 * routes delete failures wherever the host can show them (the page's banner;
 * the sidebar has no surface and omits it — the row simply remains).
 */
export function WorkspaceActionsMenu({
  workspace,
  children,
  onError,
}: {
  workspace: WorkspaceRow;
  children?: ReactNode;
  onError?: (message: string) => void;
}) {
  const navigate = useNavigate();
  const invalidate = useInvalidateWorkspaces();
  const [busy, setBusy] = useState(false);

  async function remove(): Promise<void> {
    const ok = await confirmAction({ title: "Delete this workspace?", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
      await invalidate();
    } catch (err) {
      onError?.(errMessage(err, "Failed to delete workspace"));
    } finally {
      setBusy(false);
    }
  }

  const items: ActionItem[] = [
    {
      label: "Open",
      icon: ExternalLink,
      onSelect: () => void navigate({ to: "/workspaces/$id", params: { id: workspace.id } }),
    },
    {
      label: "Open in new tab",
      icon: SquareArrowOutUpRight,
      onSelect: () => window.open(`/workspaces/${workspace.id}`, "_blank", "noopener,noreferrer"),
    },
    { label: "Delete workspace", icon: Trash2, destructive: true, onSelect: () => void remove() },
  ];

  return (
    <ActionsMenu label={workspace.name} items={items} disabled={busy}>
      {children}
    </ActionsMenu>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/frontend && bun test src/components/__tests__/workspace-actions-menu.test.tsx`
Expected: PASS (adjust the harness to the router wrapper per the in-test NOTE).

- [ ] **Step 5: Refactor the page to the extracted component**

In `apps/frontend/src/routes/workspaces.tsx`:

- Delete the now-dead `deleteWorkspace` function (the component owns it; the page's `error` state stays — reached via `onError`).
- Replace `items={[…]}` on the `EntityCard` with the `menu` slot:

```tsx
  menu={
    <WorkspaceActionsMenu workspace={w} onError={setError} />
  }
```

- Remove imports that became unused (`ExternalLink`, `SquareArrowOutUpRight`, `Trash2`); add `WorkspaceActionsMenu`.
- Check: `grep -n "navigate\|useNavigate" src/routes/workspaces.tsx` — keep whatever the remaining code (`createAndEnter`) still uses.

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/frontend && bun run verify-types && bun test`
Expected: exit 0; all tests pass.

```bash
git add apps/frontend/src/components/workspace-actions-menu.tsx apps/frontend/src/components/__tests__/workspace-actions-menu.test.tsx apps/frontend/src/routes/workspaces.tsx
git commit -m "refactor(frontend): extract WorkspaceActionsMenu; page and sidebar share one definition"
```

---

### Task 4: AppSidebar rows wrap in the context menus

**Files:**
- Modify: `apps/frontend/src/components/app-sidebar.tsx:198-226`

**Interfaces:**
- Consumes: `SubshellActionsMenu` (Task 2), `WorkspaceActionsMenu` (Task 3) — both in children mode; `subshells`/`workspaces` full arrays already loaded at `app-sidebar.tsx:101-102`.
- Produces: nothing consumed further (leaf wiring).

- [ ] **Step 1: Wire the subshell recents**

Replace the `recentSubshells.map(...)` block with:

```tsx
{!collapsed &&
  item.to === "/" &&
  recentSubshells.map((r) => {
    // The projection keeps the label/path contract; the FULL entity (same
    // query the projection came from) drives the right-click menu. Vanished
    // between renders → plain link, no menu.
    const full = subshells?.find((s) => s.id === r.id);
    const row = (
      <Link
        to="/subshells/$id"
        params={{ id: r.id }}
        title={r.path ? `${r.label} — ${r.path}` : undefined}
        className={recentClass(location.pathname === `/subshells/${r.id}`)}
      >
        <span className="block truncate">{r.label}</span>
        {/* Working dir under the name — the same reading posture
            the phone header took: the path is what locates a
            subshell, the name alone does not. */}
        {r.path ? <span className="block truncate text-[10px] opacity-70">{r.path}</span> : null}
      </Link>
    );
    return full ? (
      <SubshellActionsMenu key={r.id} subshell={full}>
        {row}
      </SubshellActionsMenu>
    ) : (
      <Fragment key={r.id}>{row}</Fragment>
    );
  })}
```

- [ ] **Step 2: Wire the workspace recents**

Replace the `recentWorkspaces.map(...)` block with the same shape:

```tsx
{!collapsed &&
  item.to === "/workspaces" &&
  recentWorkspaces.map((r) => {
    const full = workspaces?.find((w) => w.id === r.id);
    const row = (
      <Link to="/workspaces/$id" params={{ id: r.id }} className={recentClass(location.pathname === `/workspaces/${r.id}`)}>
        {r.label}
      </Link>
    );
    return full ? (
      <WorkspaceActionsMenu key={r.id} workspace={full}>
        {row}
      </WorkspaceActionsMenu>
    ) : (
      <Fragment key={r.id}>{row}</Fragment>
    );
  })}
```

- [ ] **Step 3: Imports**

Add to `app-sidebar.tsx`: `Fragment` (to the `react` import), `SubshellActionsMenu`, `WorkspaceActionsMenu` (component imports, alphabetical per biome).

- [ ] **Step 4: Typecheck + full frontend tests**

Run: `cd apps/frontend && bun run verify-types && bun test`
Expected: exit 0, tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/app-sidebar.tsx
git commit -m "feat(frontend): right-click context menus on sidebar recent subshell/workspace rows"
```

---

### Task 5: Full verification + live browser check

- [ ] **Step 1: Repo trio (root)**

```bash
bun run verify-types && bun run lint:check && bun run test
```

Expected: all exit 0.

- [ ] **Step 2: Live check (dev server on :5174 is already running from the previous task)**

Browser at http://127.0.0.1:5174 (sign in via the real host or with an account that works from this origin):
- right-click a recent SUBSHELL row → menu at the cursor with the same items as its ⋯ menu; "Edit title" opens the dialog and closes cleanly; Escape/outside-click dismiss;
- right-click a recent WORKSPACE row → Open / Open in new tab / Delete (Delete asks the confirm; do NOT confirm-delete real data);
- left-click still navigates; the row layout is pixel-identical to before;
- browser default context menu does not appear on rows.
If auth from this environment 403s (as in the previous session), verify what the origin permits, state exactly which steps ran, and do not claim the rest.

- [ ] **Step 3: Push?**

Report status; push only when the user asks (pattern: they ask explicitly).
