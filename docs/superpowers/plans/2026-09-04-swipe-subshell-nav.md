# Swipe prev/next between subshells — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/subshells/$id`, a horizontal touch swipe navigates to the previous/next subshell in the sidebar's status-sorted order.

**Architecture:** `@use-gesture/react`'s `useDrag` bound to the page's terminal wrapper (capture phase — xterm owns its subtree). Decision logic is two pure modules (gesture intent, list neighbors) that are unit-tested directly; the hook is a thin adapter between them and the router. Spec: `docs/superpowers/specs/2026-09-04-swipe-subshell-nav-design.md`.

**Tech Stack:** React 19, TanStack Router/Query, `@use-gesture/react@10.3.1` (verified API: config `target`/`eventOptions`/`pointer.touch`/`filterTaps`/`enabled`; state `first`/`last`/`movement`/`initial`), `bun test` + happy-dom.

## Global Constraints

- Dependency versions pinned exact (`.claude/rules/dependencies.md`); Bun only (`bun add`, never npm).
- All work in `apps/frontend`; run its commands from that directory.
- Test run: `bun test` in `apps/frontend` (happy-dom via `bunfig.toml` preload; `matchMedia` is stubbed in `src/test-setup.ts`).
- Route hooks: `subshells_.$id.tsx` has a late early-return (`isNotFound && !subshell`) deliberately placed after the LAST hook — any new hook call must go ABOVE it.
- Final verification trio from repo root: `bun run verify-types && bun run lint:check && bun run test`.
- No changeset needed (frontend-only; changesets cover `apps/server`/`apps/client`).
- Branch: `feat/swipe-subshell-nav` (already checked out).

---

### Task 1: Dependency + spec correction

**Files:**
- Modify: `apps/frontend/package.json` (dependency, already staged in working tree)
- Modify: `docs/superpowers/specs/2026-09-04-swipe-subshell-nav-design.md`

- [ ] **Step 1: Verify the install is pinned and locked**

Already run: `bun add @use-gesture/react@10.3.1` in `apps/frontend`. Confirm:

Run: `grep '"@use-gesture/react"' apps/frontend/package.json`
Expected: `"@use-gesture/react": "10.3.1",` (no caret). If unpinned: `bunx syncpack fix apps/frontend/package.json && bun install`.

- [ ] **Step 2: Correct the spec's exclusion-zone bullet**

The gesture attaches to the terminal wrapper only; header and key bar are siblings outside it, so the `data-no-swipe` attribute is unnecessary. Replace the bullet

```
- **Exclusion zones**: gestures starting inside the `TerminalKeyBar` or anything marked
  `data-no-swipe` are ignored (the key bar keeps terminal focus via its own
  `pointerdown` preventDefaults; a drag from a key button must never navigate).
```

with

```
- **Exclusion zones**: the gesture lives on the terminal wrapper only — the header and
  the `TerminalKeyBar` are siblings outside it, so drags starting there never reach it.
```

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/package.json bun.lock* docs/superpowers/specs/2026-09-04-swipe-subshell-nav-design.md
git commit -m "feat(frontend),docs: add @use-gesture/react; spec note on swipe zone scoping"
```

---

### Task 2: Pure decision modules — `swipeIntent` + `findNeighbors`

**Files:**
- Create: `apps/frontend/src/lib/swipe-nav.ts`
- Create: `apps/frontend/src/lib/__tests__/swipe-nav.test.ts`
- Create: `apps/frontend/src/lib/subshell-neighbors.ts`
- Create: `apps/frontend/src/lib/__tests__/subshell-neighbors.test.ts`

**Interfaces:**
- Produces: `swipeIntent(input: SwipeIntentInput): SwipeIntent | null` where
  `SwipeIntent = "prev" | "next"` and `SwipeIntentInput = { dx, dy, startX, viewportWidth }`
  (numbers, px); constants `SWIPE_MIN_DX = 70`, `SWIPE_AXIS_RATIO = 1.3`,
  `SWIPE_EDGE_GUARD = 24`.
- Produces: `findNeighbors<T extends { id: string }>(ordered: readonly T[], id: string): { prev: string | null; next: string | null }`.
- Consumed by: Tasks 3–5.

- [ ] **Step 1: Write the failing tests**

`apps/frontend/src/lib/__tests__/swipe-nav.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { swipeIntent } from "@/lib/swipe-nav";

const W = 390;

/** Convenience: swipe `dx` px from x=`startX` (default screen centre). */
function intent(dx: number, dy = 0, startX = W / 2) {
  return swipeIntent({ dx, dy, startX, viewportWidth: W });
}

describe("swipeIntent", () => {
  it("a left swipe past the threshold asks for the next entry", () => {
    expect(intent(-120)).toBe("next");
    expect(intent(-70)).toBe("next"); // threshold is inclusive
  });

  it("a right swipe past the threshold asks for the previous entry", () => {
    expect(intent(120)).toBe("prev");
  });

  it("short drags do nothing", () => {
    expect(intent(-69)).toBeNull();
    expect(intent(0)).toBeNull();
  });

  it("vertical-dominant drags do nothing — terminal scrollback owns them", () => {
    expect(intent(-100, -90)).toBeNull(); // 100 <= 90 * 1.3
    expect(intent(-100, -70)).toBe("next"); // 100 > 70 * 1.3
  });

  it("gestures starting inside the edge guard belong to the browser back", () => {
    expect(intent(-120, 0, 12)).toBeNull();
    expect(intent(120, 0, W - 12)).toBeNull();
  });
});
```

`apps/frontend/src/lib/__tests__/subshell-neighbors.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { findNeighbors } from "@/lib/subshell-neighbors";

const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("findNeighbors", () => {
  it("returns the id-list neighbours around the current entry", () => {
    expect(findNeighbors(list, "b")).toEqual({ prev: "a", next: "c" });
  });

  it("ends have one neighbour only — no wrap-around", () => {
    expect(findNeighbors(list, "a")).toEqual({ prev: null, next: "b" });
    expect(findNeighbors(list, "c")).toEqual({ prev: "b", next: null });
  });

  it("an unknown or not-yet-listed id has no neighbours (swipe stays inert)", () => {
    expect(findNeighbors(list, "zz")).toEqual({ prev: null, next: null });
    expect(findNeighbors([], "a")).toEqual({ prev: null, next: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/frontend && bun test src/lib/__tests__/swipe-nav.test.ts src/lib/__tests__/subshell-neighbors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/frontend/src/lib/swipe-nav.ts`:

```ts
/**
 * The pure half of prev/next swipe navigation (spec 2026-09-04): given a
 * finished drag's geometry, which neighbour does the user want — if any.
 * Lives on its own so the decision is unit-testable; the pointer plumbing
 * around it is `hooks/use-swipe-nav.ts`.
 */

/** `prev` = swipe right, `next` = swipe left (walking DOWN the sidebar list). */
export type SwipeIntent = "prev" | "next";

export interface SwipeIntentInput {
  /** Horizontal travel since gesture start, px (negative = finger moved left). */
  dx: number;
  /** Vertical travel since gesture start, px. */
  dy: number;
  /** Where the gesture started, viewport x px. */
  startX: number;
  /** Viewport width px at evaluation time. */
  viewportWidth: number;
}

/** Minimum horizontal travel (px) before a drag counts as a swipe. */
export const SWIPE_MIN_DX = 70;
/** How much more horizontal than vertical a drag must be (terminal scrollback is vertical). */
export const SWIPE_AXIS_RATIO = 1.3;
/** Strip at each viewport edge reserved for the browser/OS back gesture. */
export const SWIPE_EDGE_GUARD = 24;

/**
 * Decide the navigation intent of a finished horizontal drag.
 * @returns `next` for a committed left swipe, `prev` for a committed right
 * swipe, `null` for anything shorter, more vertical, or started in the edge guard.
 */
export function swipeIntent({ dx, dy, startX, viewportWidth }: SwipeIntentInput): SwipeIntent | null {
  if (startX < SWIPE_EDGE_GUARD || viewportWidth - startX < SWIPE_EDGE_GUARD) return null;
  if (Math.abs(dx) < SWIPE_MIN_DX) return null;
  if (Math.abs(dx) <= Math.abs(dy) * SWIPE_AXIS_RATIO) return null;
  return dx < 0 ? "next" : "prev";
}
```

`apps/frontend/src/lib/subshell-neighbors.ts`:

```ts
/** The ordered-list half of prev/next swipe navigation (spec 2026-09-04). */

/** The id-list neighbours of `id` in an already-ordered list. Ends never wrap;
 * an id not in the list (just created, SSE lag) has no neighbours. */
export function findNeighbors<T extends { id: string }>(
  ordered: readonly T[],
  id: string,
): { prev: string | null; next: string | null } {
  const i = ordered.findIndex((s) => s.id === id);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? ordered[i - 1].id : null,
    next: i < ordered.length - 1 ? ordered[i + 1].id : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/frontend && bun test src/lib/__tests__/swipe-nav.test.ts src/lib/__tests__/subshell-neighbors.test.ts`
Expected: PASS (5 + 3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/swipe-nav.ts apps/frontend/src/lib/subshell-neighbors.ts "apps/frontend/src/lib/__tests__/swipe-nav.test.ts" "apps/frontend/src/lib/__tests__/subshell-neighbors.test.ts"
git commit -m "feat(frontend): pure swipe intent + subshell neighbours"
```

---

### Task 3: `useOrderedSubshells` — the sidebar order, shared

**Files:**
- Create: `apps/frontend/src/hooks/use-ordered-subshells.ts`
- Create: `apps/frontend/src/hooks/__tests__/use-ordered-subshells.test.ts`
- Modify: `apps/frontend/src/components/app-sidebar.tsx:21,27,124,136`

**Interfaces:**
- Consumes: `useSubshellsList` (`hooks/use-subshells.ts`), `sortByStatus` (`lib/subshell-indicator.ts`).
- Produces: `useOrderedSubshells(): SubshellView[]` — full list, sidebar order.
- Consumed by: Task 5 (swipe source of truth) and the sidebar.

- [ ] **Step 1: Write the failing test**

`apps/frontend/src/hooks/__tests__/use-ordered-subshells.test.ts` (pattern: `hooks/__tests__/use-is-coarse-pointer.test.ts` for `renderHook`):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "bun:test";
import { useOrderedSubshells } from "@/hooks/use-ordered-subshells";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/** The fields sortByStatus reads; cast up to SubshellView for the cache shape. */
function entry(id: string, patch: Partial<SubshellView>): SubshellView {
  return { id, status: "running", alive: true, activity: "idle", ...patch } as SubshellView;
}

function seed(list: SubshellView[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(SUBSHELLS_QUERY_KEY, list);
  return () => renderHook(() => useOrderedSubshells(), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
}

describe("useOrderedSubshells", () => {
  it("orders the full cached list by status band, cache order as tie-break", async () => {
    // createdAt-DESC cache: exited first in input, waiting must float to the top.
    const { result } = await seed([entry("gone", { status: "terminated" }), entry("wait", { waitingSince: "2026-09-04T00:00:00Z" }), entry("run", { activity: "active" })])();
    expect(result.current.map((s) => s.id)).toEqual(["wait", "run", "gone"]);
  });

  it("is empty while the list query has no data", async () => {
    const { result } = await seed(undefined as never)();
    // no fetch succeeds in happy-dom, but the seeded (absent) cache reads as []
    expect(result.current).toEqual([]);
  });
});
```

Note: if `waitingSince` alone doesn't flip the waiting band (check `isWaiting` in `lib/subshell-order.ts`), set whatever fields it needs — the test asserts the ORDER, so make the fixture genuinely waiting (run the existing `subshell-indicator` tests' fixtures as reference).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test src/hooks/__tests__/use-ordered-subshells.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

`apps/frontend/src/hooks/use-ordered-subshells.ts`:

```ts
import { useMemo } from "react";
import { useSubshellsList } from "@/hooks/use-subshells";
import { sortByStatus } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/**
 * The FULL subshell list in sidebar order: status band (waiting → working →
 * idle → node-offline → exited → ended), cache order (newest first) as the
 * tie-break. The sidebar slices/filters this; the prev/next swipe walks it
 * whole (spec 2026-09-04). ONE definition so both surfaces can't drift.
 */
export function useOrderedSubshells(): SubshellView[] {
  const { data } = useSubshellsList();
  return useMemo(() => sortByStatus(data ?? []), [data]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/frontend && bun test src/hooks/__tests__/use-ordered-subshells.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor the sidebar onto it**

In `apps/frontend/src/components/app-sidebar.tsx`:
- Delete line 124 (`const { data: subshells } = useSubshellsList();`) and import (line 21).
- Delete the `sortByStatus` import (line 27) — `subshells` and `sortByStatus` appear nowhere else in the file (verified).
- Change line 136 to:

```ts
  const byStatus = useOrderedSubshells();
```

- Add the import: `import { useOrderedSubshells } from "@/hooks/use-ordered-subshells";`
- Keep the surrounding comment block (132–135) — it documents the band order — trim its first line to not duplicate the hook's doc.

- [ ] **Step 6: Run the full frontend suite**

Run: `cd apps/frontend && bun test`
Expected: all green (especially any `app-sidebar` test).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/hooks/use-ordered-subshells.ts apps/frontend/src/hooks/__tests__/use-ordered-subshells.test.ts apps/frontend/src/components/app-sidebar.tsx
git commit -m "refactor(frontend): one definition of the sidebar subshell order"
```

---

### Task 4: `useSwipeNav` — the gesture adapter

**Files:**
- Create: `apps/frontend/src/hooks/use-swipe-nav.ts`

**Interfaces:**
- Consumes: `useDrag` from `@use-gesture/react`; `swipeIntent`, `SWIPE_AXIS_RATIO` from `lib/swipe-nav.ts`.
- Produces: `useSwipeNav(ref: RefObject<HTMLElement | null>, opts: { onPrev(): void; onNext(): void; enabled?: boolean }): void`.
- Consumed by: Task 5.

No unit test: happy-dom cannot drive PointerEvent through use-gesture's state machine (same stance as `directory-picker-input.test.tsx`; the decision logic inside is already tested in Task 2). Verification here is `verify-types` + the Task 5 manual check.

- [ ] **Step 1: Implement**

`apps/frontend/src/hooks/use-swipe-nav.ts`:

```ts
import { useDrag } from "@use-gesture/react";
import { useRef, useState, type RefObject } from "react";
import { SWIPE_AXIS_RATIO, swipeIntent } from "@/lib/swipe-nav";

/** Follow-finger damping: px of translateX per px of drag, capped. */
const FOLLOW_DAMPING = 0.25;
const FOLLOW_MAX_PX = 48;

export interface SwipeNavOptions {
  /** Called when a committed right swipe asks for the previous entry. */
  onPrev: () => void;
  /** Called when a committed left swipe asks for the next entry. */
  onNext: () => void;
  /** Bind only while there is somewhere to go (default `true`). */
  enabled?: boolean;
}

/**
 * Attaches a touch-only prev/next swipe to `ref` (spec 2026-09-04): left →
 * next, right → previous, decided by `swipeIntent` at gesture end. While the
 * finger is down and the drag is horizontal-dominant, the element follows it
 * damped (skipped under `prefers-reduced-motion`); it snaps back on cancel.
 *
 * The listener binds in the CAPTURE phase — xterm owns its subtree's bubble
 * phase (preventDefault on touchmove, selection handlers), and a capture
 * sibling survives all of it (same reasoning as `gateTouchKeyboard`). We never
 * preventDefault: the browser's vertical pan and xterm's own gestures stay
 * untouched, and `pointer: { touch: true }` keeps mouse/touchpad out.
 */
export function useSwipeNav(ref: RefObject<HTMLElement | null>, { onPrev, onNext, enabled = true }: SwipeNavOptions): void {
  // Latest handlers without re-creating the gesture controller on every render
  // (the drag may outlive the render that armed its callbacks).
  const live = useRef({ onPrev, onNext });
  live.current = { onPrev, onNext };
  const [reduceMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)"));

  useDrag(
    ({ first, last, movement: [mx, my], initial: [startX] }) => {
      const el = ref.current;
      if (!el) return;
      if (first) el.style.transform = "";
      if (!last) {
        if (!reduceMotion.matches && Math.abs(mx) > Math.abs(my) * SWIPE_AXIS_RATIO) {
          const clamped = Math.max(-FOLLOW_MAX_PX, Math.min(FOLLOW_MAX_PX, mx * FOLLOW_DAMPING));
          el.style.transform = `translateX(${clamped}px)`;
        }
        return;
      }
      el.style.transform = "";
      const intent = swipeIntent({ dx: mx, dy: my, startX, viewportWidth: window.innerWidth });
      if (intent === "prev") live.current.onPrev();
      else if (intent === "next") live.current.onNext();
    },
    {
      target: ref,
      eventOptions: { capture: true },
      pointer: { touch: true },
      filterTaps: true,
      enabled,
    },
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd apps/frontend && bun run verify-types`
Expected: clean. If `target: ref` fights the types, the core `Target` is `EventTarget | { current: EventTarget | null }` (verified in `@use-gesture/core/dist/declarations/src/types/utils.d.ts`) — adjust the ref's generic, don't cast.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/hooks/use-swipe-nav.ts
git commit -m "feat(frontend): useSwipeNav — touch-only prev/next gesture adapter"
```

---

### Task 5: Wire it into the subshell page + verify

**Files:**
- Modify: `apps/frontend/src/routes/subshells_.$id.tsx`

**Interfaces:**
- Consumes: `useOrderedSubshells` (Task 3), `findNeighbors` (Task 2), `useSwipeNav` (Task 4), the page's existing `navigate`.

- [ ] **Step 1: Add the imports and hook calls**

In `SubshellPage`, ABOVE the `if (isNotFound && !subshell) return …` early-return (that line must stay the last thing before the JSX — the file's own comment says so). Add imports:

```ts
import { useMemo, useRef, useState } from "react"; // extend the existing react import
import { useOrderedSubshells } from "@/hooks/use-ordered-subshells";
import { useSwipeNav } from "@/hooks/use-swipe-nav";
import { findNeighbors } from "@/lib/subshell-neighbors";
```

After the `coarse`/`stacked` hook block (~line 81), add:

```ts
  // Swipe prev/next (spec 2026-09-04): walk the sidebar order with the thumb.
  // Neighbours are recomputed per render — SSE reshuffles the list live, so
  // the gesture must never hold a stale neighbour id.
  const ordered = useOrderedSubshells();
  const { prev, next } = useMemo(() => findNeighbors(ordered, id), [ordered, id]);
  const swipeZoneRef = useRef<HTMLDivElement>(null);
  useSwipeNav(swipeZoneRef, {
    enabled: Boolean(prev ?? next),
    onPrev: () => {
      if (prev) void navigate({ to: "/subshells/$id", params: { id: prev } });
    },
    onNext: () => {
      if (next) void navigate({ to: "/subshells/$id", params: { id: next } });
    },
  });
```

- [ ] **Step 2: Attach the ref to the swipe zone**

The terminal wrapper div (line ~213):

```tsx
      <div ref={swipeZoneRef} className="relative flex-1 overflow-hidden bg-terminal-strip p-0">
```

Nothing else changes — header and `TerminalKeyBar` are siblings, outside the zone by construction.

- [ ] **Step 3: Full verification**

From repo root:

```bash
bun run verify-types && bun run lint:check && bun run test
```

Expected: all three green. Fix and re-run until they are.

- [ ] **Step 4: Manual check (dev server, touch emulation)**

`bun run dev` (or reuse a running vite on :5174), DevTools device toolbar → open `/subshells/<id>` for a subshell that has neighbours in the sidebar order → drag left ≥70px over the terminal → route moves to the next row; drag right → previous; first row's right-swipe and last row's left-swipe spring back. Vertical swipe still scrolls the terminal. NEVER test against :3080.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/routes/subshells_.\$id.tsx
git commit -m "feat(frontend): swipe left/right walks the sidebar order on /subshells/\$id"
```
