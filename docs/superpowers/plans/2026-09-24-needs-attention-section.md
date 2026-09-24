# Needs Attention Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Needs Attention" section to the sidebar rail (above the machine groups) and the home page (above "Running") that lists only the subshells with an unanswered push, and disappears entirely when there are none.

**Architecture:** One pure client-side selector (`needsAttention`) shared by both surfaces, filtering the already-live subshell list on `unseenPush && access === "owner"`. The rail renders a non-collapsible spotlight above `groupSubshellsByNode`'s output; the home page reuses its existing `TileSection`. No server, protocol, or feed change — `unseenPush` already rides every view and the feed announces every write to it.

**Tech Stack:** React 19, TanStack Router/Query, lucide-react, `bun test` + happy-dom + @testing-library/react, Tailwind (design-system tokens).

**Spec:** `docs/superpowers/specs/2026-09-24-needs-attention-section-design.md`

## Global Constraints

- `unseenPush` and `access` are existing fields on `SubshellView` (`apps/server/web/src/types/subshell.ts`, both declared required); read them, never add them. The selector filters `s.unseenPush === true && s.access === "owner"` — `access` other than `"owner"` is EXCLUDED, including `undefined`, which is a RUNTIME state (the feed carries no per-viewer access, so a row can arrive before any snapshot stamps it).
- The section is a **sibling above** the node groups, not a member of `groupSubshellsByNode`; the grouping module, the collapse preference (`sidebar-node-group-pref`), `RECENT_LIMIT`, `SubshellNodeGroup`, and the "No matches." logic stay byte-identical.
- The rail header is **not collapsible and has no chevron** — no `SubshellNodeGroup`, no `aria-controls`, no localStorage write.
- Copy is exactly `Needs Attention` (no em dash; design-system copy rule). Type roles: `text-detail` + `font-strong`, colours by shadcn name — pick a role, never a raw size.
- Spotlight, not extraction: an unseen pane still renders in its machine group (rail) and its status group (home); the section is additive.
- Opening a pane is the dismiss — do NOT add a dismiss button; clearing comes from the server-side `last_push_urgency` reset already shipped.
- Tests use `bun test` only (never vitest); component tests import `afterEach(cleanup)` and mount through a memory router like the existing sidebar suite.
- Commits are scoped per task with `feat(web): …` / `test(web): …` messages.

---

### Task 1: The `needsAttention` selector

**Files:**
- Modify: `apps/server/web/src/lib/subshell-node-groups.ts` (append the export; add `SubshellView` is already imported)
- Test: `apps/server/web/src/lib/__tests__/subshell-node-groups.test.ts` (append a new describe block; `subshell()` helper already in the file)

**Interfaces:**
- Consumes: `SubshellView` (imported at the top of the lib file already).
- Produces: `needsAttention(rows: readonly SubshellView[]): SubshellView[]` — pure, order-preserving, no cap. Both later tasks import it from `@/lib/subshell-node-groups`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/web/src/lib/__tests__/subshell-node-groups.test.ts`. The file already defines `subshell(over)` returning a full `SubshellView`; it does NOT set `unseenPush`, so every existing row is `unseenPush: undefined` → seen. Add these cases at the end of the file:

```ts
describe("needsAttention — the shared spotlight rule (spec 2026-09-24)", () => {
  it("keeps exactly the owner's unseen rows, in the caller's order", () => {
    const rows = [
      subshell({ id: "a", unseenPush: true }),
      subshell({ id: "b", unseenPush: false }),
      subshell({ id: "c", unseenPush: true }),
    ];
    expect(needsAttention(rows).map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("excludes a grantee's unseen row — they can never clear it", () => {
    // Every clear site for last_push_urgency requires the OWNER's cookie, so
    // a shared pane would sit in this section forever as permanent noise.
    const rows = [
      subshell({ id: "mine", unseenPush: true, access: "owner" }),
      subshell({ id: "theirs", unseenPush: true, access: "view" }),
      subshell({ id: "theirs2", unseenPush: true, access: "edit" }),
    ];
    expect(needsAttention(rows).map((s) => s.id)).toEqual(["mine"]);
  });

  it("excludes a row the feed has not stamped an access for — skipped, never guessed", () => {
    // The live feed carries no per-viewer access; a row arriving before any
    // snapshot has an undefined access (the fixture omits the field).
    const rows = [subshell({ id: "unstamped", unseenPush: true, access: undefined })];
    expect(needsAttention(rows)).toEqual([]);
  });

  it("returns nothing for a seen list or an empty one", () => {
    expect(needsAttention([subshell({ unseenPush: false }), subshell()])).toEqual([]);
    expect(needsAttention([])).toEqual([]);
  });
});
```

Add the import at the top of the test file (line 3, extend the existing import from `@/lib/subshell-node-groups`):

```ts
import { groupSubshellsByNode, needsAttention, nodeLabelFor } from "@/lib/subshell-node-groups";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server/web && bun test src/lib/__tests__/subshell-node-groups.test.ts`
Expected: FAIL — `needsAttention is not exported` / `SyntaxError` on the import (or `needsAttention is not a function`).

- [ ] **Step 3: Implement the selector**

Append to `apps/server/web/src/lib/subshell-node-groups.ts`:

```ts
/**
 * The panes that pushed and have not been answered — the spotlight rule the
 * rail's Needs Attention section and the home page's are both built from
 * (spec 2026-09-24).
 *
 * It is a filter, not a sort: the caller's order (the rail's status band, the
 * home's already-filtered feed-order list) is preserved, and the list is
 * uncapped — a pane that pushed is news however many rows sit above it.
 *
 * `access === "owner"` is load-bearing, not tidy: every clear site for
 * `last_push_urgency` requires the OWNER's cookie, so a shared pane's unseen
 * push is a state a grantee can see but never end. Listing it in THEIR rail
 * would be a bell no click can silence — permanent noise about a machine that
 * is not theirs. `unseenPush` alone is the whole predicate on the owner's own
 * rows: a muted pane pushed nothing, so it is absent here exactly as it is
 * absent from the bell, and the waiting chip (a different signal) does not
 * belong to this section at all.
 *
 * @param rows - the surface's already-ordered list (own + shared; the feed's
 *               rows may carry no `access` until a snapshot stamps it)
 */
export function needsAttention(rows: readonly SubshellView[]): SubshellView[] {
  return rows.filter((row) => row.unseenPush && row.access === "owner");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/server/web && bun test src/lib/__tests__/subshell-node-groups.test.ts`
Expected: all pass (including the four new `needsAttention` cases).

- [ ] **Step 5: Type-check the package and commit**

Run: `cd apps/server/web && bun run verify-types`
Expected: no errors.

```bash
git add apps/server/web/src/lib/subshell-node-groups.ts apps/server/web/src/lib/__tests__/subshell-node-groups.test.ts
git commit -m "feat(web): the needsAttention spotlight rule"
```

---

### Task 2: The rail's Needs Attention section

**Files:**
- Modify: `apps/server/web/src/components/app-sidebar.tsx` (extend the `@/lib/subshell-node-groups` import ~line 46; add a selector call after `nodeGroups` ~line 325; add the section JSX before the `nodeGroups.map` ~line 626)
- Test: `apps/server/web/src/components/__tests__/app-sidebar-node-groups.test.tsx` (append a describe block reusing `withRail`, `subshell`, `groupHeaders`, `groupList`)

**Interfaces:**
- Consumes: `needsAttention(rows)` from `@/lib/subshell-node-groups` (Task 1); `nodeLabelFor`, `FALLBACK_NODE_ID` from the same lib; `SubshellRecentRow` (already imported at line 30); `byStatus`, `q`, `subshellQuery`, `nodeData`, `location`, `agentLabel`, `presetLabel`, `collapsed`, `item` already in scope in `AppSidebar`.
- Produces: a `<section aria-label="Needs Attention">` in the rail, present iff `attentionRows.length > 0`. No export other than the rendered DOM.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/web/src/components/__tests__/app-sidebar-node-groups.test.tsx`. `subshell()` there omits `unseenPush`, so pass it explicitly. Add helpers + cases:

```tsx
/** The rail's Needs Attention region, found by the accessible name it now carries. */
function attentionRegion(): HTMLElement | null {
  return screen.queryByRole("region", { name: "Needs Attention" });
}

describe("the rail's Needs Attention spotlight (spec 2026-09-24)", () => {
  it("renders nothing when no pane has an unseen push", async () => {
    await withRail([subshell({ id: "a", name: "seen" })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(1));
      expect(attentionRegion()).toBeNull();
    });
  });

  it("lists the owner's unseen rows above the first machine group", async () => {
    await withRail(
      [
        subshell({ id: "a", name: "waiting", nodeId: "n1", unseenPush: true }),
        subshell({ id: "b", name: "seen", nodeId: "local" }),
      ],
      async () => {
        await waitFor(() => expect(groupHeaders()).toHaveLength(2));
        const region = attentionRegion();
        expect(region).not.toBeNull();
        expect(region?.textContent).toContain("waiting");
        expect(region?.textContent).not.toContain("seen");
        // Above every machine group: the region precedes the first group header
        // in document order, whatever the group sort did with the unseen row's
        // own node.
        const firstButton = groupHeaders()[0]!;
        expect(
          (region!.compareDocumentPosition(firstButton) & Node.DOCUMENT_POSITION_FOLLOWING) ===
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBe(true);
      },
    );
  });

  it("spotlights without extracting — the unseen row is ALSO in its node group", async () => {
    await withRail([subshell({ id: "a", name: "waiting", nodeId: "n1", unseenPush: true })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(1));
      expect(attentionRegion()?.textContent).toContain("waiting");
      // The group it belongs to still lists it and still counts it; no row
      // jumps between groups when the pane is opened.
      expect(groupList("n1").textContent).toContain("waiting");
      expect(groupHeader("n1").textContent).toContain("1");
    });
  });

  it("excludes a grantee's unseen row from the owner's spotlight", async () => {
    await withRail([subshell({ id: "a", name: "shared", unseenPush: true, access: "view" })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(1));
      expect(attentionRegion()).toBeNull();
    });
  });

  it("narrows with the filter and empties when no unseen row matches", async () => {
    await withRail(
      [
        subshell({ id: "a", name: "keep-me", unseenPush: true }),
        subshell({ id: "b", name: "other", unseenPush: true }),
      ],
      async () => {
        await waitFor(() => expect(attentionRegion()).not.toBeNull());
        fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "keep" } });
        await waitFor(() => expect(attentionRegion()?.textContent).toContain("keep-me"));
        expect(attentionRegion()?.textContent).not.toContain("other");

        fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "zzz-nomatch" } });
        await waitFor(() => expect(attentionRegion()).toBeNull());
      },
    );
  });
});
```

`screen`, `fireEvent`, `waitFor`, `describe`, `it`, `expect` are already imported at the top of that test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server/web && bun test src/components/__tests__/app-sidebar-node-groups.test.tsx`
Expected: FAIL — the three cases expecting a region find none (`attentionRegion()` returns `null`, so the `textContent`/document-order assertions throw); the two negative cases ("renders nothing", "excludes a grantee") pass immediately — they assert the absence the pre-feature rail already has, which is honest coverage, not a freebie.

- [ ] **Step 3: Extend the import in `app-sidebar.tsx`**

Change line ~46 from

```ts
import { groupSubshellsByNode } from "@/lib/subshell-node-groups";
```

to

```ts
import { FALLBACK_NODE_ID, groupSubshellsByNode, needsAttention, nodeLabelFor } from "@/lib/subshell-node-groups";
```

- [ ] **Step 4: Compute the spotlight rows**

Immediately after the `nodeGroups = groupSubshellsByNode(...)` call closes (~line 325, before `const listedCount` on ~326), add:

```ts
  // The "Needs Attention" spotlight above the machine groups (spec 2026-09-24):
  // the SAME status-ordered rows the groups are built from — the live filter
  // applied identically — narrowed to the owner's unseen pushes. Computed from
  // the filter set, not from `nodeGroups`, so a match in filter mode shows here
  // exactly as it shows in the (forced-open) group, and the cap that groups
  // apply never hides a pane that pushed.
  const attentionRows = needsAttention(q ? filterSubshells(byStatus, subshellQuery) : byStatus);
```

- [ ] **Step 5: Render the section above the node groups**

In the `item.to === "/"` list region, immediately BEFORE the `{!collapsed && item.to === "/" && nodeGroups.map((group) => (` block (~line 626) and AFTER the "No matches." `<p>` block (~line 625), insert:

```tsx
              {!collapsed && item.to === "/" && attentionRows.length > 0 && (
                <section aria-label="Needs Attention" className="mb-1">
                  <div className="flex w-full items-center gap-2 py-1 pr-2 pl-3 text-detail text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate font-strong">Needs Attention</span>
                    <span className="shrink-0 tabular-nums opacity-70">{attentionRows.length}</span>
                  </div>
                  {attentionRows.map((sub) => (
                    <SubshellRecentRow
                      key={`attention-${sub.id}`}
                      subshell={sub}
                      active={location.pathname === `/subshells/${sub.id}`}
                      nodeLabel={
                        nodeLabelFor(sub.nodeId || FALLBACK_NODE_ID, nodeData?.nodes, nodeData === undefined).label
                      }
                      agentLabel={agentLabel(sub.harnessId)}
                      presetLabel={presetLabel(sub.presetId)}
                    />
                  ))}
                </section>
              )}
```

Why a `<section aria-label>` and not `SubshellNodeGroup`: the section never collapses, so it has no button, no `aria-controls`, no chevron, and never touches the collapse-preference store — reusing `SubshellNodeGroup` would import all three of those behaviours the design forbids. `<section>` with an accessible name becomes a landmark region, which is what the test finds. `nodeLabel` uses `nodeLabelFor` (the same exported ladder the group headers and the diagnostics HUD share) so a spotlight row's tooltip names its machine identically to that machine's own group header.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/server/web && bun test src/components/__tests__/app-sidebar-node-groups.test.tsx`
Expected: all pass, including the four new spotlight cases.

- [ ] **Step 7: Type-check and commit**

Run: `cd apps/server/web && bun run verify-types`
Expected: no errors.

```bash
git add apps/server/web/src/components/app-sidebar.tsx apps/server/web/src/components/__tests__/app-sidebar-node-groups.test.tsx
git commit -m "feat(web): a Needs Attention spotlight above the rail's machine groups"
```

---

### Task 3: The home page's Needs Attention section

**Files:**
- Modify: `apps/server/web/src/routes/index.tsx` (import `needsAttention`; compute `attention` after `groups`; render a `TileSection` before the "Running" one ~line 149)
- Test: `apps/server/web/src/routes/__tests__/home-needs-attention.test.tsx` (create)

**Interfaces:**
- Consumes: `needsAttention(rows)` (Task 1); the page's existing `filtered` (`filterSubshells(subshells, query)`), `isLoading`, and the existing `TileSection` component in this file; `SubshellView` type.
- Produces: a `<section><h2>Needs Attention</h2>…</section>` from `TileSection` when `attention.length > 0`, first among the three tiled sections. No new export.

- [ ] **Step 1: Write the failing test**

Create `apps/server/web/src/routes/__tests__/home-needs-attention.test.tsx`:

```tsx
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Route } from "@/routes/index";
import * as quickAdd from "@/components/quick-add";
import { setFetchRouter } from "@/test-setup";
import type { SubshellView } from "@/types/subshell";

/**
 * The home page's Needs Attention section (spec 2026-09-24): the same
 * `needsAttention` rule the rail uses, rendered through the page's existing
 * TileSection ahead of "Running", and absent when nothing is unseen. The
 * selector itself is pinned in lib; what lives here is the page wiring —
 * ordering, the owner-only exclusion, and hide-when-empty.
 */

function subshell(over: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: null,
    harnessId: "claude-code",
    nodeId: "local",
    nodeOffline: false,
    name: "s1",
    workingDir: "/Users/theo",
    status: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    preview: [],
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    nameLocked: false,
    notify: true,
    waitingSince: null,
    access: "owner",
    shareCount: 0,
    sharedWithEveryone: false,
    ...over,
  } as SubshellView;
}

function mount(subshells: SubshellView[]): () => void {
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/subshells")
      ? subshells
      : url.includes("/api/settings/public")
        ? { viewerIsAdmin: false, instanceName: "Test plane" }
        : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
    openLaunch: () => {},
    openNewWorkspace: () => {},
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  // The REAL route object re-parented under a bare root (the nodes-detail
  // idiom): `Route.useSearch()` inside the page resolves against this exact
  // object, so a reconstructed `createRoute` carrying the component would
  // detach the `?view=` search-param wiring. `/subshells/$id` exists only as a
  // Link target for the cards the page renders.
  const homeRoute = Route.update({ id: "/", path: "/", getParentRoute: () => rootRoute } as any);
  const subRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/subshells/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, subRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return () => {
    spy.mockRestore();
    setFetchRouter(null);
  };
}

/** The tiled sections' headings, in rendered order. */
async function headings(): Promise<string[]> {
  await waitFor(() => {
    const hs = [...document.querySelectorAll("h2")].map((h) => h.textContent ?? "");
    expect(hs.length).toBeGreaterThan(0);
    return hs;
  });
  return [...document.querySelectorAll("h2")].map((h) => h.textContent ?? "");
}

afterEach(cleanup);

describe("home Needs Attention section (spec 2026-09-24)", () => {
  it("renders above Running and holds the unseen owner rows", async () => {
    const restore = mount([
      subshell({ id: "a", name: "waiting", unseenPush: true }),
      subshell({ id: "b", name: "seen", unseenPush: false }),
    ]);
    try {
      const hs = await headings();
      expect(hs[0]).toBe("Needs Attention");
      expect(hs).toContain("Running");
      const attention = [...document.querySelectorAll("section")].find(
        (s) => s.querySelector("h2")?.textContent === "Needs Attention",
      );
      expect(attention?.textContent).toContain("waiting");
      expect(attention?.textContent).not.toContain("seen");
    } finally {
      restore();
    }
  });

  it("is absent entirely when nothing is unseen", async () => {
    const restore = mount([subshell({ id: "a", name: "only", unseenPush: false })]);
    try {
      const hs = await headings();
      expect(hs).not.toContain("Needs Attention");
      expect(hs).toContain("Running");
    } finally {
      restore();
    }
  });

  it("excludes a grantee's unseen row from the owner's section", async () => {
    const restore = mount([subshell({ id: "a", name: "shared", unseenPush: true, access: "view" })]);
    try {
      const hs = await headings();
      expect(hs).not.toContain("Needs Attention");
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server/web && bun test src/routes/__tests__/home-needs-attention.test.tsx`
Expected: FAIL — first case sees `hs[0] === "Running"` (no "Needs Attention" heading exists yet).

- [ ] **Step 3: Implement the home section**

In `apps/server/web/src/routes/index.tsx`, add the import (with the other `@/lib/…` imports, near line 18):

```ts
import { needsAttention } from "@/lib/subshell-node-groups";
```

After the `groups.running = priorityRunning(groups.running);` line (~line 72), add:

```ts
  // The owner's unanswered pushes, gathered above the status sections
  // (spec 2026-09-24). `filtered` (not `subshells`) so the page's own search
  // narrows it exactly as it narrows the three status groups; the selector is
  // owner-only, so a shared unseen pane is not listed here any more than in
  // the rail. `TileSection` renders nothing when the list is empty, so the
  // whole section disappears with the last unseen push — no empty heading.
  const attention = needsAttention(filtered);
```

In the tiled branch, render the new section FIRST (~line 148-152):

```tsx
      {!isLoading && filtered.length > 0 && view === "tiled" && (
        <>
          <TileSection title="Needs Attention" subshells={attention} />
          <TileSection title="Running" subshells={groups.running} />
          <TileSection title="Paused / exited" subshells={groups.exited} />
          <TileSection title="Completed" subshells={groups.terminated} />
        </>
      )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/server/web && bun test src/routes/__tests__/home-needs-attention.test.tsx`
Expected: all three cases pass.

- [ ] **Step 5: Type-check and commit**

Run: `cd apps/server/web && bun run verify-types`
Expected: no errors.

```bash
git add apps/server/web/src/routes/index.tsx apps/server/web/src/routes/__tests__/home-needs-attention.test.tsx
git commit -m "feat(web): a Needs Attention section ahead of Running on the home page"
```

---

### Task 4: Changeset, the rail's documentation, and full verification

**Files:**
- Create: `.changeset/needs-attention-section.md`
- Modify: `apps/server/web/AGENTS.md` (one sentence appended to the sidebar-grouping paragraph)

**Interfaces:** none — release note, documentation, and the verification gate.

- [ ] **Step 0: Document the section where the rail's rules live**

The grouping paragraph in `apps/server/web/AGENTS.md` ("**The recent list is GROUPED by the machine each subshell runs on** …") is where every rail rule is recorded, so the new always-on-top section belongs there. Append this sentence to the end of that paragraph (before the `**There is no cadence…**` paragraph):

```markdown
**Above the groups sits a `Needs Attention` spotlight** (spec 2026-09-24,
`needsAttention()` in the same lib): the owner's rows whose push has not been
opened since, filtered by the same rule as the bell. It is a sibling, never a
group — no chevron, no collapse pref, and an unseen row stays in its machine
group too (spotlight, not extraction: group counts stay true and no row jumps
when a pane is opened). It filters with the box and vanishes entirely when
nothing is unseen; the home page's identically-named `TileSection` is the same
selector over its own list.
```

- [ ] **Step 1: Write the changeset**

Create `.changeset/needs-attention-section.md`:

```md
---
"@internal/server": minor
---

The subshell list has a new "Needs Attention" section, in the sidebar above the machine groups and on the home page above Running. It gathers the panes that pushed and have not been opened since — only your own, and only while a push sits unanswered. Opening the pane clears it; when nothing is unseen the section is gone entirely.
```

(`@internal/server-web` is changeset-ignored — the SPA ships embedded in the server binary, so the note rides `@internal/server`. Never write a changeset naming `@internal/server-web`.)

- [ ] **Step 2: Full verification**

```bash
bunx turbo build
bun run verify-types
bun run lint:check
bun run test
```

Expected: all four green. If `lint:check` reformats nothing and the rest pass, the work is done.

- [ ] **Step 3: Commit the changeset**

```bash
git add .changeset/needs-attention-section.md
git commit -m "chore: changeset for the Needs Attention section"
```

---

## Out of scope (do not build)

- Any server, DB, protocol, or `/ws/live` change — `unseenPush` already exists and is already announced.
- A dismiss/close affordance on the section or its rows — opening the pane is the dismiss.
- A mobile-app section, a `/notifications` route, or grouping the spotlight by node.
- Making the section collapsible, or persisting any state for it.
- Changing `groupSubshellsByNode`, the collapse-preference module, `SubshellNodeGroup`, `RECENT_LIMIT`, or the "No matches." line.
