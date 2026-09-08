# Phone session header: two-line title/path, menu rename, title validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On phone widths the session-page header reflows to two rows (readable title + working-dir path, small font), renaming moves into a validated "Edit title" modal in the shared actions menu, and every name input validates client-side against the backend's rules.

**Architecture:** All changes live in `apps/frontend`. A shared component (`DetailBackHeader`) gains a `subtitle` prop and a `useIsWide()`-keyed two-row layout (below `WORKSPACE_TILING_MIN_WIDTH` = 1024px). A new `TitleDialog` (clone of the `NotesDialog` pattern) is opened from `SessionActionsMenu`. Validation is centralized in the shared `EditableText` (new `maxLength` prop + pre-flight errors) and the dialog; the backend routes already enforce the same rules (`minLength 1 / maxLength 120`; nodes 64) and are NOT touched.

**Tech Stack:** React 19, TanStack Router/Query, Base UI dialog (`components/ui/*`), Tailwind, `bun test` + `@testing-library/react` + happy-dom.

**Spec:** `docs/superpowers/specs/2026-09-02-phone-header-title-edit-design.md`

## Global Constraints

- Spec doc: `docs/superpowers/specs/2026-09-02-phone-header-title-edit-design.md` — read it before starting; it is the contract.
- No `apps/mobile` (RN app), no backend changes.
- No dynamic imports anywhere (`.claude/rules/code-style.md`).
- Tests run with `bun test` from `apps/frontend` (bunfig preloads `src/test-setup.ts`). CORRECTION FOUND DURING EXECUTION: happy-dom ships its own `matchMedia` that answers width queries against a 1024px window — the ambient test environment is therefore **wide**, and any width-sensitive test must override `matchMedia` explicitly (see `detail-back-header.test.tsx`'s `forceViewport`).
- Verification trio after the last task, from the repo root: `bun run verify-types && bun run lint:check && bun run test` — all must pass (same trio the pre-push hook runs).
- Error/validation copy exactly as written in this plan (tests assert on it).
- Every task ends with a commit; scope `git add` to the files that task touched.
- Pinned dependency rule applies if any package is added — this plan adds NONE.

---

### Task 1: Name-length constants + `EditableText` pre-flight validation

**Files:**
- Create: `apps/frontend/src/lib/name-limits.ts`
- Modify: `apps/frontend/src/components/editable-text.tsx`
- Test: `apps/frontend/src/components/__tests__/editable-text.test.tsx` (extend/adjust)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `NAME_MAX_DEFAULT = 120`, `NODE_NAME_MAX = 64` (from `@/lib/name-limits`).
  - `EditableText` gains prop `maxLength?: number` (default `NAME_MAX_DEFAULT`); commit now trims, keeps a blank draft open with error `"A name is required"`, rejects over-length with `` `Keep it under ${maxLength} characters` ``, and puts `maxLength` on the `Input`. Silent-revert on **unchanged** draft is kept. Task 2 renders its own errors (does not reuse these strings from EditableText), Task 5 passes `NODE_NAME_MAX`.

- [x] **Step 1: Write the failing test adjustments**

In `apps/frontend/src/components/__tests__/editable-text.test.tsx`, REPLACE the test `"an empty or unchanged draft reverts instead of saving"` (its current body asserts empty silently reverts — the new behavior says why) with these two tests:

```tsx
  it("a blank draft stays open and says why instead of silently reverting", async () => {
    const saved: string[] = [];
    const input = renderLine(async (v) => void saved.push(v));
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("A name is required")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Rename workspace" })).toBeDefined();
    // Typing a valid value and Enter clears the error and saves.
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(saved).toEqual(["New"]));
  });

  it("an unchanged draft reverts silently", async () => {
    const saved: string[] = [];
    const input = renderLine(async (v) => void saved.push(v));
    fireEvent.change(input, { target: { value: "Deck" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(saved).toEqual([]);
  });

  it("an over-length draft is rejected without calling onSave; maxLength caps the input", async () => {
    const saved: string[] = [];
    render(<EditableText value="Deck" label="Rename" onSave={async (v) => void saved.push(v)} maxLength={10} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename" });
    expect((input as HTMLInputElement).maxLength).toBe(10);
    // fireEvent bypasses the DOM maxlength, so the component guard is exercised too:
    fireEvent.change(input, { target: { value: "x".repeat(11) } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Keep it under 10 characters")).toBeDefined();
    expect(saved).toEqual([]);
  });
```

Add `render` to the import from `@testing-library/react` (the file currently imports `cleanup, fireEvent, render, screen, waitFor` — `render` is already there; verify).

- [x] **Step 2: Run to verify the new tests fail**

Run: `cd /home/theo/projects/mote/apps/frontend && bun test src/components/__tests__/editable-text.test.tsx`
Expected: FAIL on `"A name is required"` not found (old code silently reverts) and on the over-length test. The unchanged-draft test passes before and after.

- [x] **Step 3: Create `apps/frontend/src/lib/name-limits.ts`**

```ts
/**
 * Client-side mirrors of the backend's name-length rules, so inputs can
 * refuse an invalid value before the round-trip. Values copied verbatim from
 * the TypeBox schemas (`minLength: 1` + these maxima): sessions and
 * workspaces 120 (`sessions/update-session-name.route.ts`,
 * `workspaces/create-workspace.route.ts`), nodes 64
 * (`nodes/rename-node.route.ts`).
 */

/** Session / workspace display names. */
export const NAME_MAX_DEFAULT = 120;

/** Node display names. */
export const NODE_NAME_MAX = 64;
```

- [x] **Step 4: Implement in `editable-text.tsx`**

Add the import at the top: `import { NAME_MAX_DEFAULT } from "@/lib/name-limits";`

Add to the props (after `inputClassName`):

```ts
  /** Reject commits longer than this (post-trim) and cap typing; mirrors the backend rule for this entity */
  maxLength?: number;
```

and destructure `maxLength = NAME_MAX_DEFAULT`.

Replace the head of `commit()` — currently:

```ts
    const next = draft.trim();
    if (!next || next === value) {
      cancel();
      return;
    }
```

with:

```ts
    const next = draft.trim();
    if (next === value) {
      cancel();
      return;
    }
    if (!next) {
      setError("A name is required");
      return;
    }
    if (next.length > maxLength) {
      setError(`Keep it under ${maxLength} characters`);
      return;
    }
```

Add `maxLength={maxLength}` to the `<Input>` element.

- [x] **Step 5: Run to verify all pass**

Run: `cd /home/theo/projects/mote/apps/frontend && bun test src/components/__tests__/editable-text.test.tsx`
Expected: all PASS (the pre-existing five plus the two new/renamed ones and the over-length one).

- [x] **Step 6: Commit**

```bash
cd /home/theo/projects/mote
git add apps/frontend/src/lib/name-limits.ts apps/frontend/src/components/editable-text.tsx apps/frontend/src/components/__tests__/editable-text.test.tsx
git commit -m "feat(frontend): EditableText validates length/blank before saving (name-limits mirror)"
```

---

### Task 2: `TitleDialog` — the rename modal

**Files:**
- Create: `apps/frontend/src/components/ui/title-dialog.tsx`
- Create: `apps/frontend/src/components/ui/__tests__/title-dialog.test.tsx`

**Interfaces:**
- Consumes: `NAME_MAX_DEFAULT` (Task 1), `apiFetch`, `SESSION_QUERY_KEY` / `SESSIONS_QUERY_KEY` / `WORKSPACE_QUERY_KEY` from `@/lib/query-keys`.
- Produces: `TitleDialog({ sessionId, currentName, open, onOpenChange }: { sessionId: string; currentName: string; open: boolean; onOpenChange: (open: boolean) => void })` — controlled like `NotesDialog`, keyed by the CALLER. PATCHes `/api/sessions/:id/name` with `{ name }`; closes on success. Save button label `"Save title"`, input `aria-label="New session title"`. Task 3 mounts it.

- [x] **Step 1: Write the failing test**

Create `apps/frontend/src/components/ui/__tests__/title-dialog.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TitleDialog } from "@/components/ui/title-dialog";

/** Records mutation requests; answers every call with `{ ok: true }`. */
function mockFetch() {
  const calls: { method: string; url: string; body: string | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ method: init?.method ?? "GET", url: url.pathname, body: init?.body as string | undefined });
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderDialog(overrides: Partial<{ currentName: string; onOpenChange: (o: boolean) => void }> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TitleDialog
        sessionId="id-1"
        currentName={overrides.currentName ?? "Old title"}
        open
        onOpenChange={overrides.onOpenChange ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}

const saveButton = () => screen.getByRole("button", { name: "Save title" }) as HTMLButtonElement;

describe("TitleDialog", () => {
  afterEach(cleanup);

  it("saves a trimmed rename via PATCH and closes", async () => {
    let closed = false;
    const { calls, restore } = mockFetch();
    try {
      renderDialog({ onOpenChange: (o) => (closed = !o) });
      fireEvent.change(screen.getByRole("textbox", { name: "New session title" }), {
        target: { value: "  New title  " },
      });
      fireEvent.click(saveButton());
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "PATCH",
          url: "/api/sessions/id-1/name",
          body: JSON.stringify({ name: "New title" }),
        }),
      );
      await waitFor(() => expect(closed).toBe(true));
    } finally {
      restore();
    }
  });

  it("Save is disabled while the draft is blank or unchanged", () => {
    const { restore } = mockFetch();
    try {
      renderDialog();
      expect(saveButton().disabled).toBe(true); // unchanged (prefilled)
      fireEvent.change(screen.getByRole("textbox", { name: "New session title" }), { target: { value: "   " } });
      expect(saveButton().disabled).toBe(true); // blank
      fireEvent.change(screen.getByRole("textbox", { name: "New session title" }), { target: { value: "Other" } });
      expect(saveButton().disabled).toBe(false);
    } finally {
      restore();
    }
  });

  it("a >max draft is blocked with an inline message (input caps at 120)", () => {
    const { restore } = mockFetch();
    try {
      renderDialog();
      const input = screen.getByRole("textbox", { name: "New session title" }) as HTMLInputElement;
      expect(input.maxLength).toBe(120);
      // fireEvent bypasses the DOM maxlength, exercising the component guard:
      fireEvent.change(input, { target: { value: "x".repeat(121) } });
      expect(screen.getByText("Keep it under 120 characters")).toBeDefined();
      expect(saveButton().disabled).toBe(true);
    } finally {
      restore();
    }
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `cd /home/theo/projects/mote/apps/frontend && bun test src/components/ui/__tests__/title-dialog.test.tsx`
Expected: FAIL — cannot resolve `@/components/ui/title-dialog`.

- [x] **Step 3: Implement `apps/frontend/src/components/ui/title-dialog.tsx`**

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import { apiFetch } from "@/lib/api";
import { NAME_MAX_DEFAULT } from "@/lib/name-limits";
import { SESSION_QUERY_KEY, SESSIONS_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";

/**
 * Title editor for a session: a dialog with a single-line input, persisted via
 * `PATCH /api/sessions/:id/name` (saving PINS the name against the pane-title
 * auto-sweep — "Resume auto title" in the same menu is the way back).
 *
 * Controlled, with no trigger of its own, because the thing that opens it is
 * an item in the actions menu (same posture as NotesDialog). Mount it keyed
 * by session id so switching sessions gets a fresh draft.
 */
export function TitleDialog({
  sessionId,
  currentName,
  open,
  onOpenChange,
}: {
  /** The session being renamed */
  sessionId: string;
  /** Prefilled draft AND the "unchanged" comparison baseline */
  currentName: string;
  /** Dialog open state, owned by the caller */
  open: boolean;
  /** Called on close (Cancel, backdrop, Escape) and after a successful save */
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(currentName);
  const trimmed = text.trim();
  const tooLong = trimmed.length > NAME_MAX_DEFAULT;
  const unchanged = trimmed === currentName;

  const mutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ ok: boolean }>(`/api/sessions/${sessionId}/name`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      onOpenChange(false);
      // The detail view, the list feed/cards, and the workspace pane titles
      // (which carry the session name) all re-read from these.
      void queryClient.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY, sessionId] });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Edit title</DialogTitle>
          <DialogDescription>Up to {NAME_MAX_DEFAULT} characters. Saving pins the title.</DialogDescription>
        </DialogHeader>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={NAME_MAX_DEFAULT}
          aria-label="New session title"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && !(unchanged || trimmed === "" || tooLong || mutation.isPending)) {
              mutation.mutate(trimmed);
            }
          }}
        />
        {tooLong && <p className="text-destructive text-xs">Keep it under {NAME_MAX_DEFAULT} characters</p>}
        {mutation.isError && (
          <p className="text-destructive text-xs">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to save"}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate(trimmed)}
            disabled={mutation.isPending || unchanged || trimmed === "" || tooLong}
          >
            {mutation.isPending ? "Saving…" : "Save title"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

If `mutation.error` needs narrowing, `useMutation` types it as `Error` by default in TanStack Query 5 — no cast required; adjust only if `verify-types` complains.

- [x] **Step 4: Run to verify it passes**

Run: `cd /home/theo/projects/mote/apps/frontend && bun test src/components/ui/__tests__/title-dialog.test.tsx`
Expected: 3 PASS.

- [x] **Step 5: Commit**

```bash
cd /home/theo/projects/mote
git add apps/frontend/src/components/ui/title-dialog.tsx apps/frontend/src/components/ui/__tests__/title-dialog.test.tsx
git commit -m "feat(frontend): TitleDialog — validated session rename modal"
```

---

### Task 3: "Edit title" item in the shared actions menu

**Files:**
- Modify: `apps/frontend/src/components/session-actions-menu.tsx`
- Test: `apps/frontend/src/components/__tests__/session-actions-menu.test.tsx` (extend)

**Interfaces:**
- Consumes: `TitleDialog` (Task 2).
- Produces: a menu item labelled `"Edit title"` in the `canEdit` block for every surface that renders `SessionActionsMenu` (page header, cards, rows).

- [x] **Step 1: Write the failing test**

In `session-actions-menu.test.tsx`, inside `describe("SessionActionsMenu — access gating (spec §4.1)")`, extend the `"an edit grantee can manage…"` test: add these two lines right after its `expect(screen.getByRole("menuitem", { name: "Add note" })).toBeDefined();` line:

```tsx
      expect(screen.getByRole("menuitem", { name: "Edit title" })).toBeDefined();
```

and after the `expect(screen.queryByRole("menuitem", { name: "Delete session" })).toBeNull();` line add a real round-trip test as a NEW `it` in the same describe:

```tsx
  it("Edit title opens the rename dialog and a save PATCHes the trimmed name", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderMenu(makeSession({ id: "abc" }));
      await openMenu("session");
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit title" }));
      const input = await screen.findByRole("textbox", { name: "New session title" });
      fireEvent.change(input, { target: { value: " Renamed " } });
      fireEvent.click(screen.getByRole("button", { name: "Save title" }));
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "PATCH",
          url: "/api/sessions/abc/name",
          body: JSON.stringify({ name: "Renamed" }),
        }),
      );
    } finally {
      restore();
    }
  });
```

(The view-grantee case is already covered: the existing "renders no actions menu at all for a view grantee" test fails if the menu itself appears, and the item lives inside the `canEdit` block.)

- [x] **Step 2: Run to verify the new tests fail**

Run: `cd /home/theo/projects/mote/apps/frontend && bun test src/components/__tests__/session-actions-menu.test.tsx`
Expected: FAIL — no menuitem named "Edit title".

- [x] **Step 3: Wire it up**

In `session-actions-menu.tsx`:

- Add `TextCursorInput` to the `lucide-react` import list (alphabetical: after `SquareStop`, before `Trash2`).
- Add `import { TitleDialog } from "@/components/ui/title-dialog";` (with the other `@/components/ui/*` imports).
- Add state beside the others: `const [titleOpen, setTitleOpen] = useState(false);`
- In the `canEdit` items array, make `"Edit title"` the FIRST item (before the note item — renaming is the more common action):

```tsx
          {
            icon: TextCursorInput,
            label: "Edit title",
            onSelect: () => setTitleOpen(true),
          },
```

- Mount the dialog in the returned fragment next to `NotesDialog`:

```tsx
      <TitleDialog
        key={`${session.id}-title`}
        sessionId={session.id}
        currentName={session.name}
        open={titleOpen}
        onOpenChange={setTitleOpen}
      />
```

- [x] **Step 4: Run to verify it passes**

Run: `cd /home/theo/projects/mote/apps/frontend && bun test src/components/__tests__/session-actions-menu.test.tsx`
Expected: all PASS.

- [x] **Step 5: Commit**

```bash
cd /home/theo/projects/mote
git add apps/frontend/src/components/session-actions-menu.tsx apps/frontend/src/components/__tests__/session-actions-menu.test.tsx
git commit -m "feat(frontend): Edit title (validated modal) in the shared session actions menu"
```

---

### Task 4: `DetailBackHeader` — `subtitle` prop + two-row phone layout, session page wiring

**Files:**
- Modify: `apps/frontend/src/components/detail-back-header.tsx`
- Modify: `apps/frontend/src/routes/sessions_.$id.tsx`
- Create: `apps/frontend/src/components/__tests__/detail-back-header.test.tsx`

**Interfaces:**
- Consumes: `useIsWide` (`@/hooks/use-is-wide`).
- Produces: `DetailBackHeader` gains `subtitle?: ReactNode` (renders inline after the title when wide; on row 2 under the wide breakpoint). Narrow header element carries `flex-col` in its class list (the test asserts on it). The workspace header passes no `subtitle` and needs NO change — verify it still compiles.

- [x] **Step 1: Write the failing test**

Create `apps/frontend/src/components/__tests__/detail-back-header.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { DetailBackHeader } from "@/components/detail-back-header";

/** The header needs router context (Link + MobileNav's useLocation). */
async function renderHeader(extra: { subtitle?: string } = {}) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <DetailBackHeader to="/" backLabel="Back to sessions" title={<>Alpha</>} subtitle={extra.subtitle} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return document.querySelector("header");
}

/** matchMedia whose `(min-width: Npx)` queries all answer `matches`. */
function forceViewport(matches: boolean) {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof matchMedia;
  return () => (globalThis.matchMedia = original);
}

describe("DetailBackHeader", () => {
  afterEach(cleanup);

  it("narrow (test default: matchMedia matches=false): two rows, title + subtitle on row 2", async () => {
    const header = await renderHeader({ subtitle: "/home/theo/projects/mote" });
    expect(header?.className).toContain("flex-col");
    expect(screen.getByText("Alpha")).toBeDefined();
    expect(screen.getByText("/home/theo/projects/mote")).toBeDefined();
  });

  it("wide: one row, subtitle inline after the title", async () => {
    const restore = forceViewport(true);
    try {
      const header = await renderHeader({ subtitle: "/tmp/x" });
      expect(header?.className).not.toContain("flex-col");
      expect(screen.getByText("Alpha")).toBeDefined();
      expect(screen.getByText("/tmp/x")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("subtitle absent: row layout carries just the title", async () => {
    const header = await renderHeader();
    expect(header?.className).toContain("flex-col");
    expect(screen.getByText("Alpha")).toBeDefined();
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `cd /home/theo/projects/mote/apps/frontend && bun test src/components/__tests__/detail-back-header.test.tsx`
Expected: FAIL — `subtitle` is not a known prop (typecheck error surfaces at run too) and/or no `flex-col`.

- [x] **Step 3: Rewrite `detail-back-header.tsx`**

Full new content:

```tsx
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { MobileNav } from "@/components/mobile-top-bar";
import { Button } from "@/components/ui/button";
import { useIsWide } from "@/hooks/use-is-wide";

/**
 * The header bar of a full-height detail page: the nav-drawer trigger, a
 * back control to the owning list, a truncated title (plus an optional muted
 * subtitle — the session's working directory), and page actions on the right.
 *
 * The session page and the workspace header spelled this bar out twice —
 * down to the same phone-chrome comment — so it lives here once. The back
 * control is a `Button render={<Link/>}` (the house idiom): an anchor
 * wrapped around a button would announce a link containing a button.
 *
 * Below the tiling breakpoint (the same `useIsWide()` signal MobileNav keys
 * off) a single flex row cannot hold chrome + title + subtitle + badges +
 * menu — on a phone the title truncated to nothing. The bar reflows to two
 * rows instead: row 1 is chrome and actions, row 2 the title (small, bold)
 * and subtitle (xs, muted), both on their own line width.
 */
export function DetailBackHeader({
  to,
  backLabel,
  title,
  subtitle,
  actions,
}: {
  /** In-app destination of the back control, e.g. `"/"` or `"/workspaces"` */
  to: string;
  /** `aria-label` of the back control, e.g. "Back to sessions" */
  backLabel: string;
  /** Title content, truncated at the width the actions leave over */
  title: ReactNode;
  /** Muted one-liner beside (wide) or under (phone) the title, e.g. a path */
  subtitle?: ReactNode;
  /** Right-aligned page controls (badges, menus, find bars) */
  actions?: ReactNode;
}) {
  const wide = useIsWide();
  const chrome = (
    <>
      {/* On phones the nav hamburger rides in this bar rather than a second
          chrome row above it — every row here is terminal rows.
          MobileNav renders nothing on desktop. */}
      <MobileNav />
      <Button variant="ghost" size="icon" aria-label={backLabel} render={<Link to={to as never} />}>
        <ArrowLeft className="h-4 w-4" />
      </Button>
    </>
  );
  if (wide) {
    return (
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        {chrome}
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <div className="min-w-0 shrink truncate">{title}</div>
          {subtitle ? (
            <div className="min-w-0 truncate text-muted-foreground text-xs">{subtitle}</div>
          ) : null}
        </div>
        {actions}
      </header>
    );
  }
  return (
    <header className="flex shrink-0 flex-col gap-0.5 border-b px-4 py-2">
      <div className="flex min-w-0 items-center gap-3">
        {chrome}
        <div className="flex-1" />
        {actions}
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <div className="min-w-0 shrink truncate text-sm font-medium">{title}</div>
        {subtitle ? <div className="min-w-0 truncate text-muted-foreground text-xs">{subtitle}</div> : null}
      </div>
    </header>
  );
}
```

Note: the wide layout wraps `title` in a flex child rather than the old bare `flex-1 truncate` div — the old session-page inline `hidden sm:inline` workingDir span is GONE (replaced by this `subtitle`), and workspace titles (which carried `min-w-0 font-medium` on their `EditableText`) keep rendering identically.

- [x] **Step 4: Wire the session page**

In `apps/frontend/src/routes/sessions_.$id.tsx`:

Add imports: `import { useIsWide } from "@/hooks/use-is-wide";` and `import { cn } from "@/lib/utils";`

In `SessionPage`, beside the other hooks (after `const coarse = useIsCoarsePointer();`):

```tsx
  // On phones the title moves to the header's second row as a display-only
  // line — editing lives in the actions menu ("Edit title"). Desktop keeps
  // click-to-edit inline. Same signal DetailBackHeader uses for the reflow.
  const wide = useIsWide();
```

Replace the `title={...}` prop of `<DetailBackHeader>` (the fragment with `EditableText` + workingDir span, currently lines ~122-135) with:

```tsx
        title={
          wide ? (
            /* Click to rename; the id stands in, muted, until the record loads. */
            <EditableText
              value={session?.name ?? ""}
              placeholder={id}
              label="Rename session"
              onSave={saveName}
              className="font-medium"
              inputClassName="w-56"
            />
          ) : (
            <span className={cn("truncate", !session?.name && "text-muted-foreground")}>{session?.name || id}</span>
          )
        }
        subtitle={session?.workingDir}
```

(`session?.workingDir` is `string | undefined` while loading — `subtitle` is optional, so `undefined` renders nothing.)

- [x] **Step 5: Run the header tests + typecheck**

Run: `cd /home/theo/projects/mote/apps/frontend && bun test src/components/__tests__/detail-back-header.test.tsx && bunx tsc --noEmit -p .`
Expected: 3 PASS, no type errors (workspace header compiles unchanged).

- [x] **Step 6: Commit**

```bash
cd /home/theo/projects/mote
git add apps/frontend/src/components/detail-back-header.tsx apps/frontend/src/routes/sessions_.\$id.tsx apps/frontend/src/components/__tests__/detail-back-header.test.tsx
git commit -m "feat(frontend): two-row phone header with title + working-dir subtitle"
```

---

### Task 5: Remaining name inputs — length caps at the call sites

**Files:**
- Modify: `apps/frontend/src/routes/nodes_.$id.tsx` (the `EditableText` at ~line 116)
- Modify: `apps/frontend/src/components/session-picker/new-session-form.tsx` (the optional-name `Input`, ~line 302)
- Test: `apps/frontend/src/components/__tests__/new-session-form.test.tsx` (one assertion added)

**Interfaces:**
- Consumes: `NODE_NAME_MAX` / `NAME_MAX_DEFAULT` (Task 1), `maxLength` prop (Task 1).
- Produces: no new exports.

- [x] **Step 1: Write the failing assertion**

In `new-session-form.test.tsx`, add a test inside the top-level `describe` (uses the existing `renderForm` helper — it renders the form with a value; `emptyNewSessionForm()` is the initial value):

```tsx
    it("caps the optional session name at the backend's 120-char rule", () => {
      const restore = mockFetch([]);
      try {
        renderForm(emptyNewSessionForm());
        const input = screen.getByLabelText("Session name (optional)") as HTMLInputElement;
        expect(input.maxLength).toBe(120);
      } finally {
        restore();
      }
    });
```

Read the existing tests first: if `mockFetch` in that file takes different arguments or `renderForm` has a different signature than shown, match the file's actual helper signatures (both are file-local; the assertion itself is what matters).

Run: `cd /home/theo/projects/mote/apps/frontend && bun test src/components/__tests__/new-session-form.test.tsx`
Expected: FAIL — `maxLength` is `-1` (no cap today).

- [x] **Step 2: Apply the caps**

`new-session-form.tsx` — import `NAME_MAX_DEFAULT` from `@/lib/name-limits` and add `maxLength={NAME_MAX_DEFAULT}` to the optional-name `<Input>` (the one with `placeholder="Defaults to date/time"`).

`nodes_.$id.tsx` — import `NODE_NAME_MAX` from `@/lib/name-limits` and change the rename call site to:

```tsx
          canRename ? (
            <EditableText
              value={n.name}
              placeholder={n.id}
              label="Rename node"
              onSave={saveName}
              maxLength={NODE_NAME_MAX}
            />
          ) : (
            n.name
          )
```

- [x] **Step 3: Run to verify it passes**

Run: `cd /home/theo/projects/mote/apps/frontend && bun test src/components/__tests__/new-session-form.test.tsx`
Expected: all PASS.

- [x] **Step 4: Commit**

```bash
cd /home/theo/projects/mote
git add apps/frontend/src/routes/nodes_.\$id.tsx apps/frontend/src/components/session-picker/new-session-form.tsx apps/frontend/src/components/__tests__/new-session-form.test.tsx
git commit -m "feat(frontend): length caps on node rename and new-session name inputs"
```

---

### Task 6: Full verification + build

**Files:** none new.

- [x] **Step 1: Repo-wide verification (the pre-push trio)**

Run from `/home/theo/projects/mote`:

```bash
bun run verify-types
bun run lint:check
bun run test
```

Expected: all green. `lint:check` is read-only — if it flags formatting, run `bun run lint` to fix, re-check, and amend the relevant commit (or commit the fixes separately).

- [x] **Step 2: Build the frontend (bundle-integrity check)**

Run: `cd /home/theo/projects/mote && bunx turbo build`
Expected: all tasks successful.

- [ ] **Step 3: Manual phone-width smoke (optional but recommended if a dev backend is up)** — NOT RUN (headless session; component tests cover the reflow logic)

Serve the app, open a session page at ~400px width (devtools device mode): row 2 shows title + path legibly; ⋯ menu → Edit title → rename → header + list update; blank draft → Save disabled; node page rename input caps at 64.

- [x] **Step 4: If anything changed during smoke fixes, re-run Step 1 and commit.**

---

## Self-review notes (plan author)

- Spec coverage: §1 header → Task 4; §2 dialog+menu → Tasks 2–3; §3 validation → Tasks 1, 2, 5 (create-form trim already existed — noted, not duplicated); §4 error handling → inside Tasks 1–2; §5 tests → every task; out-of-scope items untouched.
- `DetailBackHeader` narrow-row asserts `flex-col` (white-box but stable); wide/narrow both assert title+subtitle presence.
- Known behavior change called out in the spec: workspace header ALSO reflows on phones (no subtitle). Task 4 Step 5 confirms it compiles unchanged; no workspace test asserts the old row count (checked: no `detail-back-header` test existed before).
