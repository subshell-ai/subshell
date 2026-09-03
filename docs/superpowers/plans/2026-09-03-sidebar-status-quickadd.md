# Sidebar status dots, quick-add, and drag-to-workspace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live status dots, quick-add dialogs, a compact filter, and drag-a-session-into-a-workspace to the app sidebar, backed by an SSE feed mounted at the root so the data is current on every page.

**Architecture:** A pure `subshellIndicator()` lib owns the one status precedence (shared by the home cards and the new sidebar dot). The home page's SSE stream lifts into a root-layout provider that writes the subshell list into the shared TanStack Query cache — every surface already reads that key. Two new dialogs reuse the existing `NewSubshellForm` / `ExistingSubshellList` pieces, and HTML5 drag with a dedicated MIME constant rides onto the dock's existing `handleAdd` and the pane-attach endpoint.

**Tech Stack:** React 19, TanStack Router/Query, Tailwind, Base-UI-backed shadcn primitives (`Dialog`, `Segmented`, `Button`, `Input`), lucide icons, bun:test + @testing-library/react + happy-dom.

**Spec:** `docs/superpowers/specs/2026-09-03-sidebar-status-quickadd-design.md`

## Global Constraints

- Bun only (`bun test`, `bunx`, never npm/npx). All commands run from `apps/frontend/` unless stated.
- No dynamic imports anywhere (static `import` only — `.claude/rules/code-style.md`).
- No new dependencies; no new backend endpoints.
- After every task: `bun run verify-types && bun run lint:check && bun test src` from `apps/frontend/` must pass before committing (repo verification rule; `bun test src` = the app's `bun test` script scope).
- Copy strings exact (e2e pins some app copy; the strings below are the contract): dot/badge labels `working`, `idle`, `waiting for you`, `exited`, `ended`, `node unreachable`.
- Sidebar chrome (dots, filter, `+`) renders only while the rail is expanded (`!collapsed`).
- Commit style: `feat(frontend): …` / `refactor(frontend): …` / `test(frontend): …`, one commit per task.
- Deviation from spec §2 (decided at planning): the dot is `aria-hidden` with a `title` tooltip; screen-reader parity was judged noise at one-word-per-row cost. Spec §6's `enabled` prop (below) prevents the pre-auth token POST.

All paths below are relative to `apps/frontend/src/` unless the `src/` prefix is shown. Test files live in `__tests__/` next to the code. Run single test files with `bun test <path>` from `apps/frontend/`.

---

### Task 1: `lib/subshell-indicator.ts` — one status vocabulary

**Files:**
- Create: `src/lib/subshell-indicator.ts`
- Create: `src/lib/__tests__/subshell-indicator.test.ts`
- Modify: `src/components/subshell-card.tsx` (drop local `ACTIVITY_LABEL`/`ACTIVITY_VARIANT`, reroute `accessoryFor`)

**Interfaces:**
- Consumes: `isWaiting` from `src/lib/subshell-order.ts` (existing), `SubshellView` from `src/types/subshell.ts` (existing).
- Produces:
  - `type SubshellIndicator = "node-offline" | "exited" | "waiting" | "active" | "idle" | "terminated"`
  - `subshellIndicator(s: IndicatorProbe): SubshellIndicator` where `IndicatorProbe = Pick<SubshellView, "status" | "alive" | "activity" | "nodeOffline" | "waitingSince">`
  - `INDICATOR_LABEL: Record<SubshellIndicator, string>`
  - `INDICATOR_VARIANT: Record<SubshellIndicator, "success" | "warning" | "muted">` (Badge variants — consumed by Task 1's card refactor only)

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/subshell-indicator.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { INDICATOR_LABEL, subshellIndicator } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/** The five fields the probe reads; every other field is irrelevant here. */
const probe = (overrides: Partial<SubshellView> = {}): SubshellView =>
  ({
    status: "running",
    alive: true,
    activity: "active",
    nodeOffline: false,
    waitingSince: null,
    ...overrides,
  }) as SubshellView;

describe("subshellIndicator", () => {
  it("passes activity through for a plain live subshell", () => {
    expect(subshellIndicator(probe({ activity: "active" }))).toBe("active");
    expect(subshellIndicator(probe({ activity: "idle" }))).toBe("idle");
  });

  it("terminated passes through even though it is also a status", () => {
    expect(
      subshellIndicator(probe({ status: "terminated", alive: false, activity: "terminated" })),
    ).toBe("terminated");
  });

  it("running-but-dead reads exited", () => {
    expect(subshellIndicator(probe({ alive: false, activity: "idle" }))).toBe("exited");
  });

  it("waiting outranks active/idle but requires the isWaiting fields", () => {
    expect(subshellIndicator(probe({ waitingSince: "2026-09-03T00:00:00.000Z" }))).toBe("waiting");
    // A dead subshell is never "waiting for you" (isWaiting's own guard).
    expect(
      subshellIndicator(probe({ alive: false, waitingSince: "2026-09-03T00:00:00.000Z" })),
    ).toBe("exited");
  });

  it("node-offline outranks everything", () => {
    expect(
      subshellIndicator(
        probe({ nodeOffline: true, alive: false, waitingSince: "2026-09-03T00:00:00.000Z" }),
      ),
    ).toBe("node-offline");
    expect(subshellIndicator(probe({ nodeOffline: true, activity: "active" }))).toBe("node-offline");
  });

  it("an absent nodeOffline field (older payload) reads online-ish", () => {
    const noField = { ...probe(), nodeOffline: undefined } as unknown as SubshellView;
    expect(subshellIndicator(noField)).toBe("active");
  });

  it("labels match the words the cards use today", () => {
    expect(INDICATOR_LABEL.active).toBe("working");
    expect(INDICATOR_LABEL.idle).toBe("idle");
    expect(INDICATOR_LABEL.terminated).toBe("ended");
    expect(INDICATOR_LABEL.exited).toBe("exited");
    expect(INDICATOR_LABEL.waiting).toBe("waiting for you");
    expect(INDICATOR_LABEL["node-offline"]).toBe("node unreachable");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test src/lib/__tests__/subshell-indicator.test.ts`
Expected: FAIL — cannot resolve `@/lib/subshell-indicator`.

- [ ] **Step 3: Write the module**

Create `src/lib/subshell-indicator.ts`:

```ts
import { isWaiting } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/**
 * The six coarse states a subshell can be shown in, in the precedence the
 * home cards established (`accessoryFor` in subshell-card.tsx): node-offline
 * outranks everything — with the agent down, `alive`/`waitingSince` are
 * last-known facts, not current state (spec 2026-08-31 §5.6); then `exited`;
 * then `waiting`; then the server's `activity`.
 *
 * Shared by the card's corner badge and the sidebar status dot (spec
 * 2026-09-03 sidebar-quickadd §1) so one subshell can never read as two
 * different states in two places.
 */
export type SubshellIndicator = "node-offline" | "exited" | "waiting" | "active" | "idle" | "terminated";

/** The exact fields the computation reads — mirrors `WaitingProbe`'s tolerance. */
type IndicatorProbe = Pick<SubshellView, "status" | "alive" | "activity" | "nodeOffline" | "waitingSince">;

/** The indicator for one subshell view (see {@link SubshellIndicator} for the precedence). */
export function subshellIndicator(s: IndicatorProbe): SubshellIndicator {
  // `=== true` matches the card's posture: older payloads without the field
  // read online-ish.
  if (s.nodeOffline === true) return "node-offline";
  if (s.status === "running" && !s.alive) return "exited";
  if (isWaiting(s)) return "waiting";
  return s.activity;
}

/** The word for each state — the exact copy the home cards already use. */
export const INDICATOR_LABEL: Record<SubshellIndicator, string> = {
  "node-offline": "node unreachable",
  exited: "exited",
  waiting: "waiting for you",
  active: "working",
  idle: "idle",
  terminated: "ended",
};

/** The Badge variant each state maps to on the card (the waiting arm renders `WaitingChip`, not a Badge). */
export const INDICATOR_VARIANT: Record<SubshellIndicator, "success" | "warning" | "muted"> = {
  "node-offline": "warning",
  exited: "muted",
  waiting: "warning",
  active: "success",
  idle: "warning",
  terminated: "muted",
};
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test src/lib/__tests__/subshell-indicator.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Refactor `subshell-card.tsx` onto the shared module**

In `src/components/subshell-card.tsx`: delete the local `ACTIVITY_LABEL` and `ACTIVITY_VARIANT` consts (lines 12–21) and replace `accessoryFor` (lines ~23–39) with the indicator-driven version — labels/variants/precedence are now the shared module's, and the waiting arm keeps rendering `WaitingChip`:

```tsx
import { INDICATOR_LABEL, INDICATOR_VARIANT, subshellIndicator } from "@/lib/subshell-indicator";
```

```tsx
/**
 * The card's corner badge: delegates the state to the shared `subshellIndicator`
 * precedence (node unreachable → exited → waiting-for-you → activity — see
 * lib/subshell-indicator.ts) and renders it. `WaitingChip` self-guards, but the
 * indicator branch keeps it explicit: the waiting arm outranks the plain
 * activity chip.
 */
function accessoryFor(subshell: SubshellView): ReactNode {
  const indicator = subshellIndicator(subshell);
  if (indicator === "node-offline") return <Badge variant="warning">{INDICATOR_LABEL["node-offline"]}</Badge>;
  if (indicator === "exited") return <Badge variant="muted">{INDICATOR_LABEL.exited}</Badge>;
  if (indicator === "waiting") return <WaitingChip subshell={subshell} />;
  return <Badge variant={INDICATOR_VARIANT[indicator]}>{INDICATOR_LABEL[indicator]}</Badge>;
}
```

Update the single call site (`SubshellCard` body) from `accessory={accessoryFor(subshell, exited, nodeOffline)}` to `accessory={accessoryFor(subshell)}`. **Keep** the local `exited`/`nodeOffline` consts — the dead-state body rows still use them. Remove the now-unused `isWaiting` import **only if** nothing else in the file uses it (`grep -n "isWaiting" src/components/subshell-card.tsx` after the edit; the body may still use it — leave the import if so).

- [ ] **Step 6: Run the card's existing tests (behavior must be identical)**

Run: `bun test src/components/__tests__/subshell-card.test.tsx src/components/__tests__/subshell-dead-state.test.ts`
Expected: PASS. (These pin the badge copy; identical output proves the refactor changed nothing.)

- [ ] **Step 7: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun test src
git add src/lib/subshell-indicator.ts src/lib/__tests__/subshell-indicator.test.ts src/components/subshell-card.tsx
git commit -m "refactor(frontend): one status-indicator precedence shared by card badges"
```

---

### Task 2: `lib/subshell-dnd.ts` — the drag payload

**Files:**
- Create: `src/lib/subshell-dnd.ts`
- Create: `src/lib/__tests__/subshell-dnd.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const SUBSHELL_DND_TYPE = "application/x-subshell-id"`
  - `encodeSubshellDrag(dt: DataTransfer, id: string): void`
  - `readSubshellDrag(dt: Pick<DataTransfer, "types" | "getData">): string | null` — returns `null` for any transfer that isn't ours (file drops, dockview-internal drags)

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/subshell-dnd.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { SUBSHELL_DND_TYPE, readSubshellDrag } from "@/lib/subshell-dnd";

/** The two fields `readSubshellDrag` touches — a stand-in for DataTransfer. */
const transfer = (types: string[], values: Record<string, string>) => ({
  types,
  getData: (t: string) => values[t] ?? "",
});

describe("readSubshellDrag", () => {
  it("returns the id when our MIME is present", () => {
    expect(readSubshellDrag(transfer([SUBSHELL_DND_TYPE], { [SUBSHELL_DND_TYPE]: "sub-1" }))).toBe("sub-1");
  });

  it("returns null for a Files-only transfer (a terminal file-upload drag)", () => {
    expect(readSubshellDrag(transfer(["Files"], {}))).toBeNull();
  });

  it("returns null for a text/plain transfer (a dockview tab drag, an OS text drag)", () => {
    expect(readSubshellDrag(transfer(["text/plain"], { "text/plain": "whatever" }))).toBeNull();
  });

  it("returns null when the type is listed but the payload empty", () => {
    expect(readSubshellDrag(transfer([SUBSHELL_DND_TYPE], {}))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test src/lib/__tests__/subshell-dnd.test.ts`
Expected: FAIL — cannot resolve `@/lib/subshell-dnd`.

- [ ] **Step 3: Write the module**

Create `src/lib/subshell-dnd.ts`:

```ts
/**
 * The drag payload for "put this subshell where I'm dropping" (spec 2026-09-03
 * sidebar-quickadd §5a). A dedicated MIME is the whole safety story: the same
 * drop surfaces already receive xterm's file-upload drags and dockview's own
 * tab drags, and every handler here reacts ONLY to transfers carrying this
 * type — so neither existing gesture is touched.
 */
export const SUBSHELL_DND_TYPE = "application/x-subshell-id";

/** Stamps a dragstart with the subshell id. `text/plain` mirrors the id for debugging and future drop targets that only read text. */
export function encodeSubshellDrag(dt: DataTransfer, id: string): void {
  dt.setData(SUBSHELL_DND_TYPE, id);
  dt.setData("text/plain", id);
  dt.effectAllowed = "copy";
}

/** The dragged subshell's id, or null when the transfer is not one of ours. */
export function readSubshellDrag(dt: Pick<DataTransfer, "types" | "getData">): string | null {
  if (!Array.from(dt.types).includes(SUBSHELL_DND_TYPE)) return null;
  return dt.getData(SUBSHELL_DND_TYPE) || null;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test src/lib/__tests__/subshell-dnd.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify + commit**

```bash
bun run verify-types && bun run lint:check
git add src/lib/subshell-dnd.ts src/lib/__tests__/subshell-dnd.test.ts
git commit -m "feat(frontend): subshell drag payload with a dedicated MIME"
```

---

### Task 3: The dot, the recent row, 8 recents

Turns the sidebar's recent-subshell rows into shared `SubshellRecentRow` components: status dot, drag source, right-click menu (unchanged), 8 instead of 3.

**Files:**
- Create: `src/components/sidebar/SubshellDot.tsx`
- Create: `src/components/sidebar/SubshellRecentRow.tsx`
- Create: `src/components/sidebar/__tests__/subshell-dot.test.tsx`
- Modify: `src/lib/sidebar-recents.ts` (export `RECENT_LIMIT` 8; delete `recentSubshellLinks` — its consumer is replaced by a slice the sidebar does itself, since rows now need full entities, not the projection)
- Modify: `src/lib/__tests__/sidebar-recents.test.ts` (drop the `recentSubshellLinks` describe; move its cap test to `recentWorkspaceLinks` at 8)
- Modify: `src/components/app-sidebar.tsx:200-229` (the recent-subshell map block)

**Interfaces:**
- Consumes: `subshellIndicator`/`INDICATOR_LABEL` (Task 1), `encodeSubshellDrag` (Task 2), `SubshellActionsMenu` (existing children mode), `Link` from `@tanstack/react-router`.
- Produces:
  - `SubshellDot({ subshell, className? })`
  - `SubshellRecentRow({ subshell, active })`
  - `export const RECENT_LIMIT = 8` from `@/lib/sidebar-recents`

- [ ] **Step 1: Write the failing dot test**

Create `src/components/sidebar/__tests__/subshell-dot.test.tsx`:

```tsx
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { SubshellDot } from "@/components/sidebar/SubshellDot";
import type { SubshellView } from "@/types/subshell";

const probe = (overrides: Partial<SubshellView> = {}): SubshellView =>
  ({
    status: "running",
    alive: true,
    activity: "active",
    nodeOffline: false,
    waitingSince: null,
    ...overrides,
  }) as SubshellView;

describe("SubshellDot", () => {
  it("maps each indicator to its fill and tooltip word", () => {
    const cases: Array<[Partial<SubshellView>, string, string]> = [
      [{ activity: "active" }, "bg-success", "working"],
      [{ activity: "idle" }, "bg-muted-foreground", "idle"],
      [{ waitingSince: "2026-09-03T00:00:00.000Z" }, "bg-warning", "waiting for you"],
      [{ alive: false }, "bg-muted-foreground/50", "exited"],
      [{ status: "terminated", alive: false, activity: "terminated" }, "border-muted-foreground", "ended"],
      [{ nodeOffline: true }, "bg-orange-500", "node unreachable"],
    ];
    for (const [overrides, fill, label] of cases) {
      const { unmount } = render(<SubshellDot subshell={probe(overrides)} />);
      const dot = document.querySelector('[aria-hidden="true"]');
      expect(dot?.getAttribute("class") ?? "").toContain(fill);
      expect(dot?.getAttribute("title")).toBe(label);
      unmount();
    }
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test src/components/sidebar/__tests__/subshell-dot.test.tsx`
Expected: FAIL — cannot resolve `@/components/sidebar/SubshellDot`.

- [ ] **Step 3: Write the dot**

Create `src/components/sidebar/SubshellDot.tsx`:

```tsx
import { INDICATOR_LABEL, subshellIndicator, type SubshellIndicator } from "@/lib/subshell-indicator";
import { cn } from "@/lib/utils";
import type { SubshellView } from "@/types/subshell";

/**
 * Fill classes per state, in the rail's own visual language (spec
 * 2026-09-03 sidebar-quickadd §1 note): tone is a sidebar concern, so this
 * table lives with the dot, not in the shared indicator module. Two dead
 * states stay readable at 6px by shape, not just hue — `exited` is a faint
 * fill, `terminated` a hollow ring. Unlike the home cards' waiting chip, the
 * rail never animates.
 */
const DOT_CLASS: Record<SubshellIndicator, string> = {
  active: "bg-success",
  idle: "bg-muted-foreground",
  waiting: "bg-warning",
  exited: "bg-muted-foreground/50",
  terminated: "border border-muted-foreground",
  "node-offline": "bg-orange-500",
};

/**
 * The 6px state dot on a sidebar recent row. `aria-hidden` with a `title` —
 * the tooltip spells the word; the link text beside it stays the row's only
 * read-aloud content (planning deviation from spec §2, deliberate).
 */
export function SubshellDot({ subshell, className }: { subshell: SubshellView; className?: string }) {
  const indicator = subshellIndicator(subshell);
  return (
    <span
      aria-hidden
      title={INDICATOR_LABEL[indicator]}
      className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[indicator], className)}
    />
  );
}
```

- [ ] **Step 4: Run the dot test, verify it passes**

Run: `bun test src/components/sidebar/__tests__/subshell-dot.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the row component**

Create `src/components/sidebar/SubshellRecentRow.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { SubshellDot } from "@/components/sidebar/SubshellDot";
import { encodeSubshellDrag } from "@/lib/subshell-dnd";
import { cn } from "@/lib/utils";
import type { SubshellView } from "@/types/subshell";

/**
 * One recent subshell in the sidebar: dot + name + working dir, right-click
 * for its actions menu (spec 2026-09-03 sidebar-context-menu), and HTML5-drag
 * — dragging it onto the workspace dock or a workspace card attaches it there
 * (spec 2026-09-03 sidebar-quickadd §5b). Left-click still navigates; a press
 * without movement never starts a drag, so the three gestures coexist.
 *
 * Takes the FULL entity (not the recents projection): the dot needs the
 * status fields, the menu needs the access level, and the sidebar's filter
 * mode has full entities anyway.
 */
export function SubshellRecentRow({ subshell, active }: { subshell: SubshellView; active: boolean }) {
  const row = (
    <Link
      to="/subshells/$id"
      params={{ id: subshell.id }}
      draggable
      onDragStart={(e) => encodeSubshellDrag(e.dataTransfer, subshell.id)}
      title={subshell.workingDir ? `${subshell.name} — ${subshell.workingDir}` : undefined}
      className={cn(
        "flex items-start gap-2 rounded-md py-1 pr-3 pl-3 text-xs transition-colors",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
      )}
    >
      <SubshellDot subshell={subshell} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{subshell.name}</span>
        {subshell.workingDir ? (
          <span className="block truncate text-[10px] opacity-70">{subshell.workingDir}</span>
        ) : null}
      </span>
    </Link>
  );
  return <SubshellActionsMenu subshell={subshell}>{row}</SubshellActionsMenu>;
}
```

(Note: the old `recentClass()` gutter was `pl-10` to clear the nav icon; the dot now provides that indentation, so this row is `pl-3` + dot. `recentClass` itself STAYS — the workspace rows still use it.)

- [ ] **Step 6: Update `sidebar-recents.ts`**

In `src/lib/sidebar-recents.ts`: change the limit and delete `recentSubshellLinks` + its doc comment; the projection interface and `recentWorkspaceLinks` stay:

```ts
/** How many entries each sub-list shows. (Spec 2026-09-03 sidebar-quickadd §3: 3 was too few to spot a session among; the nav scrolls, so 8 costs nothing structurally.) Exported because the sidebar slices its own recents to this number — rows render full entities, not the projection. */
export const RECENT_LIMIT = 8;
```

Also remove the now-unused `SidebarRecentLink.path` doc-line? NO — keep `SidebarRecentLink` unchanged (workspace rows still use it).

In `src/lib/__tests__/sidebar-recents.test.ts`: delete the whole `describe("recentSubshellLinks", …)` block; replace `describe("recentWorkspaceLinks")`'s cap test with:

```ts
  it("caps at eight entries without mutating the input", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      workspace(`w${i}`, `W${i}`, `2026-0${i + 1}-01T00:00:00.000Z`),
    );
    const links = recentWorkspaceLinks(many);
    expect(links).toHaveLength(8);
    expect(links[0]?.id).toBe("w8");
    expect(many.map((w) => w.id)).toEqual(Array.from({ length: 9 }, (_, i) => `w${i}`));
  });
```

- [ ] **Step 7: Wire the sidebar**

In `src/components/app-sidebar.tsx`:
- Add imports: `import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";` and `import { RECENT_LIMIT } from "@/lib/sidebar-recents";`; drop the `recentSubshellLinks` import (keep `recentWorkspaceLinks`).
- Delete the `const recentSubshells = recentSubshellLinks(subshells);` line (keep `recentWorkspaces`).
- Replace the entire recent-subshell block (lines 200–229 — `{!collapsed && item.to === "/" && recentSubshells.map(…)}`) with:

```tsx
              {!collapsed &&
                item.to === "/" &&
                (subshells ?? []).slice(0, RECENT_LIMIT).map((s) => (
                  <SubshellRecentRow key={s.id} subshell={s} active={location.pathname === `/subshells/${s.id}`} />
                ))}
```

(The projection + vanished-entity fallback branches disappear: rows are now sliced straight from the live full list, so every rendered row HAS its entity.)

- [ ] **Step 8: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun test src
git add src/components/sidebar/ src/lib/sidebar-recents.ts src/lib/__tests__/sidebar-recents.test.ts src/components/app-sidebar.tsx
git commit -m "feat(frontend): status dots and drag sources on sidebar recent subshells"
```

---

### Task 4: The SSE feed moves to the app root

**Files:**
- Create: `src/hooks/use-live-subshells-feed.tsx`
- Create: `src/hooks/__tests__/live-subshells-feed.test.tsx`
- Modify: `src/hooks/useLiveSubshells.ts` (becomes a thin consumer)
- Modify: `src/routes/__root.tsx` (mount the provider, signed-in only)

**Interfaces:**
- Consumes: `SUBSHELLS_QUERY_KEY` (`@/lib/query-keys`), `apiFetch` (`@/lib/api`), `useQueryClient` (react-query), `queryClient` is NOT imported — the provider uses `useQueryClient()` (it renders under `QueryClientProvider`).
- Produces:
  - `LiveSubshellsFeedProvider({ enabled, children })` — `enabled: boolean` gates the stream
  - `useLiveSubshellsFeed(): { connected: boolean; lastList: SubshellView[] | null }`
  - `useLiveSubshells()` — SAME return shape as today (`{ subshells, connected, isLoading, isError, refetch }`), so `routes/index.tsx` and `live-status.tsx` need no changes.

- [ ] **Step 1: Write the failing provider test**

Create `src/hooks/__tests__/live-subshells-feed.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { LiveSubshellsFeedProvider, useLiveSubshellsFeed } from "@/hooks/use-live-subshells-feed";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";

/** Minimal EventSource double: records instances, lets the test fire frames. */
class FakeES {
  static instances: FakeES[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(_url: string) {
    FakeES.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

function Consumer() {
  const feed = useLiveSubshellsFeed();
  return <p data-testid="state">{`${feed.connected}:${feed.lastList?.length ?? -1}`}</p>;
}

function setup(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LiveSubshellsFeedProvider enabled={enabled}>
        <Consumer />
      </LiveSubshellsFeedProvider>
    </QueryClientProvider>,
  );
  return client;
}

const original = { es: globalThis.EventSource, fetch: globalThis.fetch };
afterEach(() => {
  cleanup();
  globalThis.EventSource = original.es;
  globalThis.fetch = original.fetch;
  FakeES.instances = [];
});

function stubAuthOk() {
  globalThis.fetch = (async () => new Response(JSON.stringify({ token: "t1" }), { status: 200 })) as typeof fetch;
  globalThis.EventSource = FakeES as unknown as typeof EventSource;
}

describe("LiveSubshellsFeedProvider", () => {
  it("writes each frame into the query cache and exposes connected/lastList", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    act(() => {
      FakeES.instances[0].onmessage?.({
        data: JSON.stringify({ subshells: [{ id: "a" }, { id: "b" }] }),
      } as MessageEvent);
    });
    expect(screen.getByTestId("state").textContent).toBe("true:2");
    expect(client.getQueryData(SUBSHELLS_QUERY_KEY)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("stays silent (no token POST, no socket) while disabled", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    globalThis.EventSource = FakeES as unknown as typeof EventSource;
    setup(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toBe(0);
    expect(FakeES.instances.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test src/hooks/__tests__/live-subshells-feed.test.tsx`
Expected: FAIL — cannot resolve `@/hooks/use-live-subshells-feed`.

- [ ] **Step 3: Write the provider**

Create `src/hooks/use-live-subshells-feed.tsx`. The SSE mechanics (single-use ws-token auth, bounded-backoff reconnect, malformed-frame tolerance) move VERBATIM from `useLiveSubshells`'s effect — the only new behavior is the `setQueryData` line and the `enabled` gate:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

interface LiveSubshellsFeedValue {
  /** True while the `/api/events` stream is open and delivering. */
  connected: boolean;
  /** The most recent frame's list, or null until the stream has delivered one. */
  lastList: SubshellView[] | null;
}

const FeedContext = createContext<LiveSubshellsFeedValue>({ connected: false, lastList: null });

/**
 * The ONE live subshell feed for the whole signed-in session (spec
 * 2026-09-03 sidebar-quickadd §6). Mounted by `__root.tsx`; each SSE frame is
 * written straight into the shared `SUBSHELLS_QUERY_KEY` cache, so the
 * sidebar's status dots, the home cards, and every picker read one live
 * source instead of a snapshot taken at navigation.
 *
 * Auth uses the same short-lived single-use ws token as the WS attach path
 * (EventSource cannot send the HttpOnly cookie), so the stream is (re)opened
 * with a fresh token whenever the previous one dies — bounded backoff,
 * mechanics lifted verbatim from the old `useLiveSubshells`.
 *
 * `enabled` gates the stream so it never fires its token POST pre-auth (the
 * provider stays mounted for tree stability; the effect simply does not run).
 */
export function LiveSubshellsFeedProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastList, setLastList] = useState<SubshellView[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    async function connect() {
      try {
        const { token } = await apiFetch<{ token: string }>("/api/auth/ws-token", { method: "POST" });
        if (cancelled) return;
        // One connection per token (tokens are single-use + 30s TTL).
        es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data as string) as { subshells: SubshellView[] };
            queryClient.setQueryData(SUBSHELLS_QUERY_KEY, data.subshells);
            setLastList(data.subshells);
            setConnected(true);
          } catch {
            // ignore malformed frame
          }
        };
        // EventSource auto-reconnects on network errors, but the consumed/expired
        // token would 401 forever — tear the stream down and retry with a fresh
        // token (bounded backoff).
        es.onerror = () => {
          setConnected(false);
          es?.close();
          es = null;
          if (!cancelled) {
            const delay = reconnectTimer ? 3000 : 1000;
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              void connect();
            }, delay);
          }
        };
      } catch {
        // token fetch failed; consumers fall back to the REST list cache
        setConnected(false);
      }
    }
    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [enabled, queryClient]);

  return <FeedContext.Provider value={{ connected, lastList }}>{children}</FeedContext.Provider>;
}

/** The root feed's state — read by `useLiveSubshells`; nothing else should need it. */
export function useLiveSubshellsFeed(): LiveSubshellsFeedValue {
  return useContext(FeedContext);
}
```

- [ ] **Step 4: Run the provider test, verify it passes**

Run: `bun test src/hooks/__tests__/live-subshells-feed.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Reduce `useLiveSubshells` to a consumer**

Replace the body of `src/hooks/useLiveSubshells.ts` entirely:

```ts
import { useLiveSubshellsFeed } from "@/hooks/use-live-subshells-feed";
import { useSubshellsList } from "@/hooks/use-subshells";
import type { SubshellView } from "@/types/subshell";

/**
 * Live subshell list for the home page — the thin READ end of the root feed.
 *
 * The EventSource transport moved to `LiveSubshellsFeedProvider` in
 * `__root.tsx` (spec 2026-09-03 sidebar-quickadd §6); this hook now just
 * merges the provider's most recent frame with the REST query (initial load,
 * older backends without `/api/events`, and the invalidation-driven refresh).
 * The returned shape is unchanged.
 */
export function useLiveSubshells(): {
  subshells: SubshellView[];
  connected: boolean;
  isLoading: boolean;
  /** True when the REST list failed AND the SSE stream has delivered nothing */
  isError: boolean;
  /** Re-runs the REST list fetch (the retry affordance for `isError`) */
  refetch: () => Promise<unknown>;
} {
  const rest = useSubshellsList();
  const feed = useLiveSubshellsFeed();
  // `isError` is deliberately gated on `lastList === null`: once the stream
  // has delivered a list, the page has current data no matter what the REST
  // fallback did, and calling that an error would be a lie of its own.
  return {
    subshells: feed.lastList ?? rest.data ?? [],
    connected: feed.connected,
    isLoading: rest.isLoading && feed.lastList === null,
    isError: rest.isError && feed.lastList === null,
    refetch: rest.refetch,
  };
}
```

- [ ] **Step 6: Mount it in `__root.tsx`**

Add the import `import { LiveSubshellsFeedProvider } from "@/hooks/use-live-subshells-feed";` and wrap the content row (currently `<div className="flex min-h-0 flex-1 overflow-hidden">…</div>`):

```tsx
      {/* The live feed covers everything below it — sidebar dots, home cards,
          pickers — for the whole signed-in session (spec 2026-09-03 §6). The
          enabled gate keeps its token POST away from /login and /setup. */}
      <LiveSubshellsFeedProvider enabled={!!user && !bare}>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {wide && !bare && <AppSidebar />}
          <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            <Outlet />
          </div>
        </div>
      </LiveSubshellsFeedProvider>
```

- [ ] **Step 7: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun test src
git add src/hooks/use-live-subshells-feed.tsx src/hooks/__tests__/live-subshells-feed.test.tsx src/hooks/useLiveSubshells.ts src/routes/__root.tsx
git commit -m "feat(frontend): one SSE subshell feed at the root, writing the shared cache"
```

(If an existing test rendered a page that called `useLiveSubshells` without the provider, the default context value `{connected:false,lastList:null}` keeps it rendering from REST — no wrapper changes should be needed; if one fails, that is a real signal to check it, not to paper over.)

---

### Task 5: The sidebar filter field

**Files:**
- Modify: `src/components/app-sidebar.tsx`

**Interfaces:**
- Consumes: `filterSubshells(subshells, query)` from `@/lib/subshell-filter` (existing), `SubshellRecentRow` (Task 3), `Input` from `@/components/ui/input`.
- Produces: nothing new for other tasks.

- [ ] **Step 1: Add the state + field + swap**

In `src/components/app-sidebar.tsx`:
- Imports: `import { Input } from "@/components/ui/input";` and `import { filterSubshells } from "@/lib/subshell-filter";`
- State (next to the collapsed state): `const [subshellQuery, setSubshellQuery] = useState("");`
- Compute right after the existing `recentWorkspaces` line:

```tsx
  // Filter mode replaces the 8 recents with matches over the FULL cached list
  // (no server call — the list is already client-side). Same predicate as
  // the home page and the add-subshell dialog (lib/subshell-filter).
  const q = subshellQuery.trim();
  const listedSubshells = q ? filterSubshells(subshells ?? [], q) : (subshells ?? []).slice(0, RECENT_LIMIT);
```

- Replace Task 3's recent-subshell block with (search field above the rows, same nav slot):

```tsx
              {!collapsed && item.to === "/" && (
                <div className="px-2 pt-1 pb-2">
                  <Input
                    value={subshellQuery}
                    onChange={(e) => setSubshellQuery(e.target.value)}
                    placeholder="Filter subshells…"
                    aria-label="Filter subshells"
                    className="h-7 text-xs"
                  />
                </div>
              )}
              {!collapsed && item.to === "/" && q !== "" && listedSubshells.length === 0 && (
                <p className="px-3 py-1 text-[10px] text-muted-foreground">No matches.</p>
              )}
              {!collapsed &&
                item.to === "/" &&
                listedSubshells.map((s) => (
                  <SubshellRecentRow key={s.id} subshell={s} active={location.pathname === `/subshells/${s.id}`} />
                ))}
```

- [ ] **Step 2: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun test src
git add src/components/app-sidebar.tsx
git commit -m "feat(frontend): sidebar subshell filter over the full cached list"
```

(Manual: `bun run dev`, rail expanded, type into Filter — rows swap; clear the field — 8 recents return.)

---

### Task 6: `LaunchSubshellDialog` + the Subshells **+**

**Files:**
- Create: `src/components/sidebar/launch-subshell-dialog.tsx`
- Create: `src/components/sidebar/__tests__/launch-subshell-dialog.test.tsx`
- Modify: `src/components/app-sidebar.tsx` (plus button + dialog mount)

**Interfaces:**
- Consumes: `NewSubshellForm`/`canSubmit`/`emptyNewSubshellForm` (existing), `useCreateSubshell` (existing; resolves `{ id: string }`), `createSubshellErrorMessage` (existing), Dialog primitives, `useNavigate`.
- Produces: `LaunchSubshellDialog({ open, onOpenChange })`.

- [ ] **Step 1: Write the failing test**

Create `src/components/sidebar/__tests__/launch-subshell-dialog.test.tsx` (router+client wrapper per `components/__tests__/new-subshell-form.test.tsx`, fetch stub per `add-node-dialog.test.tsx`):

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
import { cleanup, render, screen } from "@testing-library/react";
import { LaunchSubshellDialog } from "@/components/sidebar/launch-subshell-dialog";

/**
 * Gating + composition only: the form itself is pinned by new-subshell-form.
 * test.tsx and the POST by use-create-subshell's existing coverage — filling
 * the searchable profile combobox here would re-test the combobox, not the
 * dialog. The launch flow is e2e-pinned on /new (same hooks).
 */
afterEach(cleanup);

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const subshellRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/subshells/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, subshellRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router}>
        <LaunchSubshellDialog open onOpenChange={() => {}} />
      </RouterProvider>
    </QueryClientProvider>,
  );
}

describe("LaunchSubshellDialog", () => {
  it("renders the shared launch form behind a titled dialog, Start gated until complete", () => {
    renderDialog();
    expect(screen.getByText("New subshell")).toBeDefined();
    // The dialog's default (DIALOG_IDS) working-dir field id is shared with the
    // workspace add-dialog — both instances never mount at once.
    expect(document.querySelector("#picker-working-dir")).not.toBeNull();
    const start = screen.getByRole("button", { name: /Start subshell/i });
    expect(start.hasAttribute("disabled")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test src/components/sidebar/__tests__/launch-subshell-dialog.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the dialog**

Create `src/components/sidebar/launch-subshell-dialog.tsx`:

```tsx
import { useNavigate } from "@tanstack/react-router";
import { useState, type JSX } from "react";
import {
  canSubmit,
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/new-subshell-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";

/**
 * The sidebar's quick-launch dialog (spec 2026-09-03 sidebar-quickadd §4a).
 * `/new` and this dialog are two entry points over ONE contract: the shared
 * `NewSubshellForm` owns the fields, `useCreateSubshell` owns the POST, and a
 * success lands on the subshell page — the same thing `/new` does. The page
 * stays (deep links + e2e pin its field ids).
 */
export function LaunchSubshellDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const create = useCreateSubshell();
  const [form, setForm] = useState<NewSubshellFormValue>(emptyNewSubshellForm);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setForm(emptyNewSubshellForm());
    setError(null);
  }

  async function submit() {
    setError(null);
    try {
      const created = await create.mutateAsync(form);
      onOpenChange(false);
      reset();
      void navigate({ to: "/subshells/$id", params: { id: created.id } });
    } catch (err) {
      // Node-aware copy: an offline remote pick answers 409 NODE_OFFLINE and
      // gets the actionable line (same helper as /new and the add-dialog).
      setError(createSubshellErrorMessage(err, "Failed to create subshell"));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New subshell</DialogTitle>
          <DialogDescription>Launch an agent harness in a working directory.</DialogDescription>
        </DialogHeader>
        <NewSubshellForm value={form} onChange={setForm} />
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || !canSubmit(form)}>
            {create.isPending ? "Starting…" : "Start subshell"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test src/components/sidebar/__tests__/launch-subshell-dialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the plus button**

In `src/components/app-sidebar.tsx`:
- Imports: `Plus` from `lucide-react` (add to the existing lucide import block), `import { LaunchSubshellDialog } from "@/components/sidebar/launch-subshell-dialog";`
- State next to `subshellQuery`: `const [launchOpen, setLaunchOpen] = useState(false);`
- Inside the nav map, the per-item wrapper `<div key={item.to}>` becomes `relative`:

```tsx
            <div key={item.to} className="relative">
```

- Immediately after the nav `<Link>` element (still inside the wrapper div), add:

```tsx
              {!collapsed && item.to === "/" && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="New subshell"
                  title="New subshell"
                  className="absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 text-muted-foreground"
                  onClick={() => setLaunchOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              )}
```

- Mount the dialog once per sidebar (e.g. just above the closing `</aside>` content, next to `<UserMenu>`'s wrapper div):

```tsx
      <LaunchSubshellDialog open={launchOpen} onOpenChange={setLaunchOpen} />
```

- [ ] **Step 6: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun test src
git add src/components/sidebar/launch-subshell-dialog.tsx src/components/sidebar/__tests__/launch-subshell-dialog.test.tsx src/components/app-sidebar.tsx
git commit -m "feat(frontend): sidebar plus opens the launch-subshell dialog"
```

---

### Task 7: `ExistingSubshellList` gains multi-select mode

**Files:**
- Modify: `src/components/subshell-picker/existing-subshell-list.tsx`
- Modify: `src/components/__tests__/existing-subshell-list.test.tsx` (append two tests)

**Interfaces:**
- Consumes: nothing new.
- Produces (optional props added to `ExistingSubshellList`): `selected?: Set<string>`, `onToggle?: (id: string) => void`, `onPick` becomes optional (`onPick?: (id: string) => void`). When BOTH `selected` and `onToggle` are present the list is in multi-select (checkbox) mode; otherwise today's single-pick behavior is byte-identical — `AddSubshellDialog` passes no new props and must not change.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/__tests__/existing-subshell-list.test.tsx` (reuse the file's existing `makeSubshell` factory and imports; add `fireEvent` + `screen` to its `@testing-library/react` import if not present):

```tsx
describe("ExistingSubshellList (multi-select mode)", () => {
  it("renders checkbox rows and toggles via onToggle when selected + onToggle are given", () => {
    const toggled: string[] = [];
    const list = [makeSubshell({ id: "s1", name: "One" })];
    render(
      <ExistingSubshellList
        subshells={list}
        query=""
        onQueryChange={() => {}}
        loadFailed={false}
        loading={false}
        busyId={null}
        selected={new Set()}
        onToggle={(id) => toggled.push(id)}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /One/ }));
    expect(toggled).toEqual(["s1"]);
  });

  it("single-pick mode is untouched when no selection props are passed", () => {
    const picked: string[] = [];
    const list = [makeSubshell({ id: "s2", name: "Two" })];
    render(
      <ExistingSubshellList
        subshells={list}
        query=""
        onQueryChange={() => {}}
        loadFailed={false}
        loading={false}
        busyId={null}
        onPick={(id) => picked.push(id)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Two/ }));
    expect(picked).toEqual(["s2"]);
  });
});
```

- [ ] **Step 2: Run them, verify the first fails**

Run: `bun test src/components/__tests__/existing-subshell-list.test.tsx`
Expected: first test FAILS (`selected`/`onToggle` unknown props — no role=checkbox); second PASSES.

- [ ] **Step 3: Implement the mode**

In `src/components/subshell-picker/existing-subshell-list.tsx`:
- Imports: `import { Check } from "lucide-react";` and `import { cn } from "@/lib/utils";`
- Props: make `onPick` optional AND make `busyId` optional (`busyId?: string | null` — the new-workspace dialog passes neither; `disabled={busyId !== null}` keeps working verbatim with `undefined`); add the two optional props with this doc:

```tsx
  /** Adds the picked subshell (single-pick mode). */
  onPick?: (subshellId: string) => void;
  /**
   * Multi-select mode (the new-workspace dialog, spec 2026-09-03
   * sidebar-quickadd §4b): when BOTH this and `onToggle` are present, rows
   * render as checkboxes reflecting `selected` and clicking toggles instead
   * of picking. Absent = today's single-pick rows, byte-identical.
   */
  selected?: Set<string>;
  /** Toggles a row's membership in `selected`. */
  onToggle?: (id: string) => void;
```

- Right after the props destructure (before the first JSX), derive:

```tsx
  const multi = selected !== undefined && onToggle !== undefined;
```

- The row `<button>` (the one with `onPick`) becomes:

```tsx
                <button
                  type="button"
                  disabled={busyId !== null}
                  role={multi ? "checkbox" : undefined}
                  aria-checked={multi ? selected.has(subshell.id) : undefined}
                  onClick={multi ? () => onToggle(subshell.id) : () => onPick?.(subshell.id)}
                  className="flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent disabled:opacity-50"
                >
                  {multi && (
                    <span
                      aria-hidden
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        selected.has(subshell.id) ? "border-primary bg-primary text-primary-foreground" : "border-input",
                      )}
                    >
                      {selected.has(subshell.id) && <Check className="h-3 w-3" />}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
```

(the rest of the row — name/path block, harness, elapsed, `RowStatusBadges`, "Adding…" spinner — unchanged inside the button).

Update the component's JSDoc first paragraph to note the two modes in one sentence.

- [ ] **Step 4: Run the tests**

Run: `bun test src/components/__tests__/existing-subshell-list.test.tsx`
Expected: all PASS (new + pre-existing — the old tests exercise single mode and must not have changed).

- [ ] **Step 5: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun test src
git add src/components/subshell-picker/existing-subshell-list.tsx src/components/__tests__/existing-subshell-list.test.tsx
git commit -m "feat(frontend): existing-subshell list gains a checkbox multi-select mode"
```

---

### Task 8: `NewWorkspaceDialog` + every create-workspace entry point

**Files:**
- Create: `src/lib/workspace-name.ts`
- Create: `src/components/sidebar/new-workspace-dialog.tsx`
- Create: `src/components/sidebar/__tests__/new-workspace-dialog.test.tsx`
- Modify: `src/routes/workspaces.tsx` (delete `defaultWorkspaceName` + `createAndEnter`; both buttons open the dialog)
- Modify: `src/components/app-sidebar.tsx` (Workspaces `+`)

**Interfaces:**
- Consumes: `ExistingSubshellList` multi-select (Task 7), `NewSubshellForm`/`canSubmit`, `useCreateSubshell`, `useSubshellsList`, `useInvalidateWorkspaces`, `apiPost`/`errMessage`, Dialog primitives, `Segmented`.
- Produces:
  - `defaultWorkspaceName(): string` from `@/lib/workspace-name`
  - `NewWorkspaceDialog({ open, onOpenChange })` — self-contained: creates the workspace, seeds `selected` panes, invalidates, navigates.

- [ ] **Step 1: Extract the name helper**

Create `src/lib/workspace-name.ts`:

```ts
/** Placeholder name for a fresh workspace, e.g. `Aug 28, 4:45 PM`. Named in-place inside the workspace afterwards. */
export function defaultWorkspaceName(): string {
  const stamp = new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return stamp;
}
```

- [ ] **Step 2: Write the failing dialog test**

Create `src/components/sidebar/__tests__/new-workspace-dialog.test.tsx`:

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
import { NewWorkspaceDialog } from "@/components/sidebar/new-workspace-dialog";
import type { SubshellView } from "@/types/subshell";

const subshell = (id: string, name: string): SubshellView =>
  ({
    id,
    name,
    workingDir: `/tmp/${id}`,
    harnessId: "claude",
    status: "running",
    alive: true,
    activity: "active",
    nodeOffline: false,
    waitingSince: null,
    notify: false,
    lastOutputAt: null,
    access: "owner",
  }) as SubshellView;

interface Call {
  method: string;
  url: string;
  body?: string;
}

/**
 * `failPaneAdds`: how many POST …/panes calls answer 500 (the partial-pane
 * failure branch). Serves two subshells so checkbox clicks are real.
 */
function mockFetch(opts: { failPaneAdds?: number } = {}) {
  const calls: Call[] = [];
  let paneFailsLeft = opts.failPaneAdds ?? 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (method === "GET" && url.pathname === "/api/subshells") {
      return new Response(JSON.stringify([subshell("s1", "One"), subshell("s2", "Two")]), { status: 200 });
    }
    if (method === "POST" && url.pathname === "/api/workspaces") {
      return new Response(JSON.stringify({ id: "ws-new" }), { status: 200 });
    }
    if (method === "POST" && url.pathname.startsWith("/api/workspaces/") && url.pathname.endsWith("/panes")) {
      if (paneFailsLeft > 0) {
        paneFailsLeft -= 1;
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response(JSON.stringify({ id: `pane-${calls.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderDialog(onOpenChange = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const wsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, wsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router}>
        <NewWorkspaceDialog open onOpenChange={onOpenChange} />
      </RouterProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("NewWorkspaceDialog", () => {
  it("zero selected: creates the workspace alone and closes", async () => {
    const { calls, restore } = mockFetch();
    const closes: boolean[] = [];
    try {
      renderDialog((o: boolean) => closes.push(o));
      fireEvent.click(await screen.findByRole("button", { name: /Create workspace/i }));
      await waitFor(() =>
        expect(calls.some((c) => c.method === "POST" && c.url === "/api/workspaces")).toBe(true),
      );
      expect(calls.some((c) => c.url.endsWith("/panes"))).toBe(false);
      await waitFor(() => expect(closes).toContain(true));
    } finally {
      restore();
    }
  });

  it("selects checkboxes and posts a pane for each", async () => {
    const { calls, restore } = mockFetch();
    try {
      renderDialog();
      fireEvent.click(await screen.findByRole("checkbox", { name: /One/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /Two/ }));
      fireEvent.click(screen.getByRole("button", { name: /Create workspace/i }));
      await waitFor(() =>
        expect(calls.filter((c) => c.url.endsWith("/panes")).length).toBe(2),
      );
      expect(JSON.parse(calls.find((c) => c.url.endsWith("/panes"))?.body ?? "{}")).toEqual({
        subshellId: "s1",
      });
    } finally {
      restore();
    }
  });

  it("partial pane failure: keeps the dialog and offers Enter workspace", async () => {
    const { restore } = mockFetch({ failPaneAdds: 1 });
    try {
      renderDialog();
      fireEvent.click(await screen.findByRole("checkbox", { name: /One/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /Two/ }));
      fireEvent.click(screen.getByRole("button", { name: /Create workspace/i }));
      expect(await screen.findByText(/couldn't add 1 subshell/i)).toBeDefined();
      expect(screen.getByRole("button", { name: /Enter workspace/i })).toBeDefined();
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `bun test src/components/sidebar/__tests__/new-workspace-dialog.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 4: Write the dialog**

Create `src/components/sidebar/new-workspace-dialog.tsx`:

```tsx
import { useNavigate } from "@tanstack/react-router";
import { useState, type JSX } from "react";
import { ExistingSubshellList } from "@/components/subshell-picker/existing-subshell-list";
import {
  canSubmit,
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/new-subshell-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { useSubshellsList } from "@/hooks/use-subshells";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import { apiPost, errMessage } from "@/lib/api";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { defaultWorkspaceName } from "@/lib/workspace-name";

/** Which half of the dialog is showing (same shape as the add-subshell dialog). */
type Mode = "existing" | "new";

/**
 * Creates a workspace WITH subshells already on it (spec 2026-09-03
 * sidebar-quickadd §4b) — what the sidebar's Workspaces `+` and the
 * /workspaces page's button open instead of the old immediate create.
 *
 * Deliberately has no placement control: a fresh workspace has no focused
 * pane to split from, and the dock's reconciliation lays every pane of a
 * workspace with no saved layout out as tabs.
 *
 * Submit order is workspace → panes, sequentially, collecting failures rather
 * than aborting: the workspace existing but a pane missing is recoverable
 * from inside it; a pane posted to a workspace that was never created is not.
 * Zero selected is a valid answer — it means today's old behavior (an empty
 * workspace you name and fill inside).
 */
export function NewWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const invalidate = useInvalidateWorkspaces();
  const { data: subshells, isError: loadFailed, isLoading: loading } = useSubshellsList();
  const create = useCreateSubshell();

  const [mode, setMode] = useState<Mode>("existing");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<NewSubshellFormValue>(emptyNewSubshellForm());
  /** Ordered ids to attach; checkbox toggles and successful launches append here. */
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [creating, setCreating] = useState(false);
  // Set when the workspace exists but at least one pane failed — the footer
  // becomes Enter (the workspace is real; the missing panes are addable there).
  const [createdId, setCreatedId] = useState<string | null>(null);

  function reset() {
    setMode("existing");
    setQuery("");
    setForm(emptyNewSubshellForm());
    setSelected([]);
    setError(null);
    setLaunching(false);
    setCreating(false);
    setCreatedId(null);
  }

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function enter(id: string) {
    onOpenChange(false);
    reset();
    void navigate({ to: "/workspaces/$id", params: { id } });
  }

  /** Launches from the New half and checks the result into the selection. */
  async function launchAndAdd() {
    setError(null);
    setLaunching(true);
    try {
      const created = await create.mutateAsync(form);
      setSelected((prev) => [...prev, created.id]);
      setForm(emptyNewSubshellForm());
      // The launched row is now in the (invalidated) list — show it checked.
      setMode("existing");
    } catch (err) {
      setError(createSubshellErrorMessage(err, "Failed to launch subshell"));
    } finally {
      setLaunching(false);
    }
  }

  async function submit() {
    setError(null);
    setCreating(true);
    let id: string;
    try {
      const created = await apiPost<{ id: string }>("/api/workspaces", { name: defaultWorkspaceName() });
      id = created.id;
    } catch (err) {
      setError(errMessage(err, "Failed to create workspace"));
      setCreating(false);
      return;
    }
    let failed = 0;
    for (const subshellId of selected) {
      try {
        await apiPost(`/api/workspaces/${id}/panes`, { subshellId });
      } catch {
        failed += 1;
      }
    }
    await invalidate();
    setCreating(false);
    if (failed > 0) {
      setCreatedId(id);
      setError(
        `Workspace created — couldn't add ${failed} subshell${failed === 1 ? "" : "s"}. You can add them from inside.`,
      );
      return;
    }
    enter(id);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>Start it with subshells already tiled in — or empty.</DialogDescription>
        </DialogHeader>

        <Segmented
          ariaLabel="What to add"
          options={[
            { value: "existing", label: "Existing subshells" },
            { value: "new", label: "New subshell" },
          ]}
          value={mode}
          onChange={setMode}
        />

        {createdId ? (
          // The workspace exists; the error line above says which adds failed.
          <p className="text-muted-foreground text-sm">The workspace is created — enter it to add the rest.</p>
        ) : mode === "existing" ? (
          <ExistingSubshellList
            subshells={subshells ?? []}
            query={query}
            onQueryChange={setQuery}
            loadFailed={loadFailed}
            loading={loading}
            selected={new Set(selected)}
            onToggle={toggle}
          />
        ) : (
          <NewSubshellForm value={form} onChange={setForm} />
        )}

        {error && <p className="text-destructive text-sm">{error}</p>}
        {!createdId && selected.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {selected.length === 1 ? "1 subshell" : `${selected.length} subshells`} to add
          </p>
        )}

        <DialogFooter>
          {createdId ? (
            <Button onClick={() => enter(createdId)}>Enter workspace</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating || launching}>
                Cancel
              </Button>
              {mode === "new" && (
                <Button onClick={() => void launchAndAdd()} disabled={launching || !canSubmit(form)}>
                  {launching ? "Launching…" : "Launch & add"}
                </Button>
              )}
              <Button onClick={() => void submit()} disabled={creating || launching}>
                {creating ? "Creating…" : "Create workspace"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `bun test src/components/sidebar/__tests__/new-workspace-dialog.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Rewire `/workspaces` and the sidebar**

`src/routes/workspaces.tsx`:
- Delete the local `defaultWorkspaceName` function and the `createAndEnter` function and the `creating` state.
- Imports: `import { NewWorkspaceDialog } from "@/components/sidebar/new-workspace-dialog";`; remove `apiFetch` from the `@/lib/api` import if unused (`errMessage` still used by the card-drop task — leave it); remove `useInvalidateWorkspaces` from the import IF unused elsewhere in the file (Task 10 re-adds it — if the compiler flags it unused NOW, remove it and Task 10 brings it back).
- Add state: `const [dialogOpen, setDialogOpen] = useState(false);`
- PageHeader action:

```tsx
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus /> New workspace
          </Button>
        }
```

- EmptyState: `actionLabel="Create your first workspace"`, `onAction={() => setDialogOpen(true)}`, and drop the `busy`/`busyLabel` props (check `EmptyState`'s props — they're optional; if TypeScript says otherwise, pass `busy={false}`).
- Mount the dialog before `</main>`: `<NewWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />`.
- The `navigate` import may become unused (the card is a Link) — remove per lint.

`src/components/app-sidebar.tsx`:
- State: `const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);` + dialog import.
- Add the Workspaces plus, mirroring the Subshells one INSIDE the nav map (same absolute-button pattern, Task 6):

```tsx
              {!collapsed && item.to === "/workspaces" && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="New workspace"
                  title="New workspace"
                  className="absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 text-muted-foreground"
                  onClick={() => setNewWorkspaceOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              )}
```

- Mount `<NewWorkspaceDialog open={newWorkspaceOpen} onOpenChange={setNewWorkspaceOpen} />` beside the `<LaunchSubshellDialog …/>`.

- [ ] **Step 7: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun test src
git add src/lib/workspace-name.ts src/components/sidebar/new-workspace-dialog.tsx src/components/sidebar/__tests__/new-workspace-dialog.test.tsx src/routes/workspaces.tsx src/components/app-sidebar.tsx
git commit -m "feat(frontend): new-workspace dialog seeds panes before the row exists"
```

---

### Task 9: The dock accepts a dropped session

**Files:**
- Modify: `src/components/workspace-dock.tsx`

**Interfaces:**
- Consumes: `SUBSHELL_DND_TYPE`/`readSubshellDrag` (Task 2), the existing `handleAdd(subshellId, direction)`, `apiRef` (`DockviewApi | null` ref — its existence is asserted by the `onReady` callback), `detail.panes` (`WorkspacePaneRow[]` with `subshellId`), dockview `getPanel(id)?.api.setActive()` (verified present: `dockviewPanelApi.d.ts:95`).
- Produces: nothing new.

- [ ] **Step 1: Add state and the drop wrapper**

In `src/components/workspace-dock.tsx`:
- Imports: `useRef` (already imported — check), `SUBSHELL_DND_TYPE` + `readSubshellDrag` from `@/lib/subshell-dnd`.
- State (next to the `error` state) + depth ref:

```tsx
  // Sidebar-drag affordance (spec 2026-09-03 sidebar-quickadd §5c): true while
  // our payload hovers the dock. The depth counter is what keeps the overlay
  // from flickering: dragenter/dragleave fire as the pointer crosses every
  // child of the wrapper, and only the outermost pair is a real leave.
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);
```

- A gated-check helper above the return:

```tsx
  /** True for OUR drags only — a file-upload drag or dockview's own tab drag never arms the overlay. */
  function isSubshellDrag(e: React.DragEvent): boolean {
    return e.dataTransfer.types.includes(SUBSHELL_DND_TYPE);
  }
```

(Import `type DragEvent as ReactDragEvent` from "react" if the file's style avoids the React namespace — match how other handlers in the file type their events; the repo uses `React.`-free imports, so: `import { type DragEvent as ReactDragEvent, ... } from "react";` and `function isSubshellDrag(e: ReactDragEvent): boolean {`.)

- Attach to the EXISTING tiles wrapper `<div className="relative flex-1 overflow-hidden bg-terminal-canvas">`:

```tsx
      <div
        className="relative flex-1 overflow-hidden bg-terminal-canvas"
        onDragEnter={(e) => {
          if (!isSubshellDrag(e)) return;
          e.preventDefault();
          dragDepthRef.current += 1;
          setDropActive(true);
        }}
        onDragOver={(e) => {
          if (!isSubshellDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDropActive(false);
        }}
        onDrop={(e) => {
          if (!isSubshellDrag(e)) return;
          e.preventDefault();
          dragDepthRef.current = 0;
          setDropActive(false);
          const id = readSubshellDrag(e.dataTransfer);
          if (!id) return;
          // Never a second pane for one subshell (regression #13): the server
          // does not dedupe, so this client checks its own authoritative
          // pane list — if it is already here, just show it.
          const existingPane = detail.panes.find((p) => p.subshellId === id);
          if (existingPane) {
            apiRef.current?.getPanel(existingPane.id)?.api.setActive();
            return;
          }
          // Same shared path as the "Add subshell" dialog: "right" splits from
          // the active panel, exactly what "add it over there" means.
          void handleAdd(id, "right");
        }}
      >
```

- The overlay (sibling after the `{error && …}` block INSIDE that wrapper):

```tsx
        {dropActive && (
          // Same visual language as the terminal's file-drop outline
          // (TerminalDropOverlay) — one dashed-ring idiom for "drop here".
          <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border-2 border-primary/60 border-dashed bg-background/60 backdrop-blur-sm">
            <p className="rounded-md bg-background/95 px-3 py-1.5 text-sm shadow">Drop to add this subshell</p>
          </div>
        )}
```

- [ ] **Step 2: Verify + commit**

No component test here: dockview needs a real DOM layout the happy-dom render doesn't provide, and every piece of logic is either lib-tested (Task 2) or existing (`handleAdd`). Types + lint + suite must pass:

```bash
bun run verify-types && bun run lint:check && bun test src
git add src/components/workspace-dock.tsx
git commit -m "feat(frontend): workspace dock accepts dragged subshells (add or focus, never duplicate)"
```

Manual check (deferred to Task 11's QA pass if no dev server at this point): drag a sidebar row over the dock → ring + label appear, file-dragging a file over the dock shows NOTHING new, drop adds one pane.

---

### Task 10: Workspace cards accept a dropped session

**Files:**
- Modify: `src/components/entity-card.tsx` (optional `className`)
- Modify: `src/routes/workspaces.tsx`

**Interfaces:**
- Consumes: `SUBSHELL_DND_TYPE`/`readSubshellDrag` (Task 2), `apiFetch`/`apiPost`/`errMessage`, `useInvalidateWorkspaces`, `WorkspaceDetail` type (`@/types/workspace`), `cn`.
- Produces: `EntityCard` gains `className?: string` on its root.

- [ ] **Step 1: EntityCard gains className**

In `src/components/entity-card.tsx`: add to the props interface:

```ts
  /** Extra classes for the root wrapper — e.g. a drag-over ring from the workspaces grid (spec 2026-09-03 sidebar-quickadd §5d). */
  className?: string;
```

Destructure `className` and change the root from `<div className="relative h-full">` to:

```tsx
    <div className={cn("relative h-full", className)}>
```

(add `import { cn } from "@/lib/utils";`.)

- [ ] **Step 2: Card drop handlers in the route**

In `src/routes/workspaces.tsx`:
- Imports: `useRef` (alongside `useState`), `useInvalidateWorkspaces` (re-add if Task 8 removed it), `apiFetch`, `apiPost`, `errMessage` from `@/lib/api`, `SUBSHELL_DND_TYPE`/`readSubshellDrag` from `@/lib/subshell-dnd`, `cn` from `@/lib/utils`, `type WorkspaceDetail` from `@/types/workspace`.
- State + note machinery inside `WorkspacesPage`:

```tsx
  // Card drop-target state (spec 2026-09-03 sidebar-quickadd §5d): which card
  // the payload hovers, and a transient result note (the page has no toasts).
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const noteTimerRef = useRef<number | null>(null);
  const invalidate = useInvalidateWorkspaces();

  function note(msg: string) {
    setDropNote(msg);
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = window.setTimeout(() => setDropNote(null), 4000);
  }

  async function handleCardDrop(workspaceId: string, workspaceName: string, subshellId: string) {
    try {
      // The grid only carries a count, so ask: the server happily creates a
      // second pane row for one subshell (regression #13), duplicates here
      // must be refused by the client.
      const detail = await apiFetch<WorkspaceDetail>(`/api/workspaces/${workspaceId}`);
      if (detail.panes.some((p) => p.subshellId === subshellId)) {
        note(`Already on ${workspaceName}`);
        return;
      }
      await apiPost(`/api/workspaces/${workspaceId}/panes`, { subshellId });
      await invalidate();
      note(`Added to ${workspaceName}`);
    } catch (err) {
      setError(errMessage(err, "Failed to add subshell to workspace"));
    }
  }
```

- Below the existing `{error && …}` line: `{dropNote && <p className="text-muted-foreground text-sm">{dropNote}</p>}`
- Wrap each card in the grid (the `key` moves to the wrapper):

```tsx
          {workspaces?.map((w) => (
            <div
              key={w.id}
              className={cn("rounded-lg", dropTargetId === w.id && "ring-2 ring-primary/70")}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(SUBSHELL_DND_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropTargetId(w.id);
              }}
              onDragLeave={() => setDropTargetId((t) => (t === w.id ? null : t))}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes(SUBSHELL_DND_TYPE)) return;
                e.preventDefault();
                setDropTargetId(null);
                const id = readSubshellDrag(e.dataTransfer);
                if (id) void handleCardDrop(w.id, w.name, id);
              }}
            >
              <EntityCard
                to="/workspaces/$id"
                params={{ id: w.id }}
                title={w.name}
                menu={<WorkspaceActionsMenu workspace={w} onError={setError} />}
              >
                <p>{w.subshellCount === 1 ? "1 subshell" : `${w.subshellCount} subshells`}</p>
              </EntityCard>
            </div>
          ))}
```

(A card is small enough that the naive dragLeave — no depth counter — only flickers cosmetically; the dock, which a pointer crosses for seconds, got the counter.)

- [ ] **Step 3: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun test src
git add src/components/entity-card.tsx src/routes/workspaces.tsx
git commit -m "feat(frontend): workspace cards accept dragged subshells"
```

---

### Task 11: Full verification, docs, manual QA

**Files:**
- Modify: `apps/frontend/AGENTS.md` (one paragraph — the frontend's layout doc must know about `components/sidebar/` and the root feed)

- [ ] **Step 1: Append the sidebar note to `apps/frontend/AGENTS.md`**

After the `## Layout` section's closing paragraph (the one about route files), add:

```markdown
**The sidebar (`components/app-sidebar.tsx` + `components/sidebar/`) is more
than nav.** Recent subshell rows carry a status dot and are the drag source of
"drag a session into a workspace" (targets: `workspace-dock.tsx`'s tiles
wrapper and the `/workspaces` cards; the payload contract is
`lib/subshell-dnd.ts` — handlers react ONLY to its MIME, which is what keeps
xterm's file-drop and dockview's tab-drag untouched). Status words/precedence
live once in `lib/subshell-indicator.ts` (home card badges consume it), and
the dot fills beside it. Subshell lists everywhere are kept current by ONE
SSE feed — `hooks/use-live-subshells-feed.tsx`, mounted in `__root.tsx`
signed-in-only — which writes each `/api/events` frame into
`SUBSHELLS_QUERY_KEY`; read via `useSubshellsList`/`useLiveSubshells`, never
by opening another EventSource.
```

- [ ] **Step 2: Run the full verification trio from the repo root AND the app**

```bash
cd /home/theo/projects/subshell && bun run verify-types && bun run lint:check && bun run test
```

Expected: all green. Fix anything this plan broke; re-run until green (do not push past a failure).

- [ ] **Step 3: Manual QA (dev server, rail expanded)**

`bun run dev` (or `bun run start` for backend too) on http://localhost:5174 — checklist from spec §8:
1. Dots: launch/terminate a subshell elsewhere → the dot on the CURRENT page (not home) changes without reload.
2. Filter: typing swaps recents → matches; "No matches." for a nonsense query.
3. `+` (Subshells): dialog opens, Start navigates to the new subshell.
4. `+` (Workspaces): pick 2 existing → Create → land in a workspace with 2 tabs.
5. Drag sidebar row → dock: ring overlay appears ONLY for sidebar drags (a file drag over the dock shows nothing new); drop adds one pane; re-dragging the same session activates its pane (no duplicate).
6. Drag sidebar row → workspace card on /workspaces: ring + "Added to …" note; count increments; re-drop → "Already on …".
7. dockview tab drag/split still works (internal drags unaffected).
8. Terminal file-upload drop still works (Files gate).
9. Collapsed rail: no dots/plus/filter visible.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/AGENTS.md
git commit -m "docs(frontend): sidebar status/drag/feed conventions"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** §1 indicator→T1 · §2 dot/row→T3 · §3 recents 8/filter/plus→T3,T5,T6,T8 · §4a launch dialog→T6 · §4b new-workspace dialog→T7,T8 · §5a payload→T2 · §5b source→T3 · §5c dock→T9 · §5d cards→T10 · §6 feed→T4 · §8 tests distributed, manual QA→T11. EntityCard `className` (spec §5d) →T10. All covered; the two deliberate planning deviations are declared in Global Constraints (dot a11y) and the `enabled` gate (feed).
- **Placeholders:** none — every code step carries full code; two steps ("if lint says unused, remove") are compiler-driven decisions, not content gaps.
- **Type consistency:** `subshellIndicator`/`INDICATOR_LABEL`/`INDICATOR_VARIANT`/`SubshellIndicator` (T1) consumed as written by T3; `SUBSHELL_DND_TYPE`/`encodeSubshellDrag`/`readSubshellDrag` (T2) by T3/T9/T10; `RECENT_LIMIT` (T3) by T3/T5; dialog props (`open`,`onOpenChange`) consistent across T6/T8 and their call sites; `ExistingSubshellList` new props match T8's usage (no `onPick`/`busyId` passed in multi mode — `busyId` must therefore stay optional: T7 makes `onPick` optional; `busyId` already defaults via callers passing null — T7's props change makes both `selected`/`onToggle` optional WITHOUT touching `busyId`'s existing requiredness — the T8 call site passes neither `onPick` nor `busyId`, so T7 must ALSO make `busyId` optional (`busyId?: string | null`) — folded into T7 step 3: make `busyId` optional and keep `disabled={busyId !== null}` working unchanged with undefined.)
- **Ordering:** T1→T3; T2→T3/T9/T10; T7→T8; all serial-safe; T4/T5/T6 independent of T7+.
