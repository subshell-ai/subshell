# Mobile Support Implementation Plan (iPhone 15 Pro · iPad Pro 11")

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mote fully usable on an iPhone 15 Pro (393×852) and iPad Pro 11" (834×1194 / 1194×834): drawer shell below 1024px, dvh/safe-area viewport handling, a terminal accessory key bar, touch-polished dock, scrollable dialogs, and an Add-to-Home-Screen install path.

**Architecture:** One component tree; a single responsive rule (≥1024px desktop shell, <1024px mobile shell) driven by the existing `useIsWide()`/`WORKSPACE_TILING_MIN_WIDTH`. The sidebar becomes the existing `AppSidebar` inside a new Base UI `Sheet` behind a slim top bar. The terminal keeps its raw-byte WS input path — the key bar writes through the already-published `sendInput(data)` handle. PWA support is a static manifest + icons (no service worker); the backend static plugin gains dist-root file serving to deliver them in prod.

**Tech Stack:** React 19, TanStack Router/Query, Tailwind v4, @base-ui/react 1.7.0, xterm 6 + FitAddon, dockview-react 8.2, Elysia backend, bun test + happy-dom + @testing-library/react, Playwright (e2e/), sharp (dev, icon rasterizing).

**Spec:** `docs/superpowers/specs/2026-08-30-mobile-support-design.md` (the Radix→Base UI migration it queued is DONE — the tree is Base UI; see `apps/frontend/.migration/`).

## Global Constraints

- Package manager: **Bun only** (`bun add`, `bunx`); every dependency version **pinned exact** (pre-commit syncpack fails otherwise). After `bun add`: `bunx syncpack fix && bun install`.
- Verification after every task: `bun run verify-types && bun run lint:check && bun run test` from the repo root (same trio as pre-push). `bun run lint` fixes, `lint:check` verifies.
- No dynamic imports anywhere (breaks `bun build --compile`).
- Breakpoint constant: `WORKSPACE_TILING_MIN_WIDTH = 1024` (`apps/frontend/src/lib/breakpoints.ts`) — never hardcode 1024 elsewhere.
- **Never write `layout_json` from the narrow tab mode** (`workspace-tabs.tsx` must not import `useDebouncedSave` / PUT layout) — spec invariant.
- Touch targets ≥ 44px (`min-h-11`) on mobile-critical controls.
- **No Tailwind double-negative translate classes**: `-translate-x-[-50%]` compiles to `+50%` (caught by e2e during the Base UI migration). Arbitrary negative values go inside the brackets only.
- PWA: manifest + icons + meta only. **No service worker, no offline behavior.**
- E2E rules (`e2e/AGENTS.md`): xterm paints to WebGL — never assert canvas text; prove with server truth (`/api/auth/ws-token`, `/ws` upgrade events, `GET /api/sessions/:id/log`). Specs run `workers: 1` in file order against one DB; `01` writes `.auth/admin.json`, later specs load `ADMIN_STATE`.
- Target viewports: full screens 393×852, 834×1194, 1194×834; Playwright descriptors `iPhone 15 Pro` = **393×659** (Safari chrome included) and `iPad Pro 11 landscape` = 1194×834 (both touch).
- Desktop rendering at ≥1024px must not change.
- Commits: conventional style as used on this branch (`feat(ui): …`, `fix(backend): …`); commit per task.

---

### Task 1: Viewport foundation (dvh, viewport-fit, touch CSS)

**Files:**
- Modify: `apps/frontend/index.html:5`
- Modify: `apps/frontend/src/routes/__root.tsx:15`
- Modify: `apps/frontend/src/routes/sessions_.$id.tsx:159`
- Modify: `apps/frontend/src/routes/workspaces_.$id.tsx:67`
- Modify: `apps/frontend/src/routes/login.tsx` (the `min-h-screen` on the main)
- Modify: `apps/frontend/src/routes/setup.tsx` (the `min-h-screen` on the main)
- Modify: `apps/frontend/src/styles.css` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: every full-height surface is dvh-based; `viewport-fit=cover` makes `env(safe-area-inset-*)` non-zero; `.xterm` scrolls by touch. Later tasks rely on the `h-dvh` roots and on `styles.css` holding the mobile touch rules.

- [ ] **Step 1: index.html viewport meta**

Replace line 5:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

with:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

- [ ] **Step 2: dvh replacements**

In `__root.tsx` (`"flex h-screen overflow-hidden"`), `sessions_.$id.tsx` (`"flex h-screen flex-col"`), `workspaces_.$id.tsx` (`"flex h-screen flex-col overflow-hidden"`): replace `h-screen` → `h-dvh`. In `login.tsx` and `setup.tsx`: `min-h-screen` → `min-h-dvh`. Then verify none remain:

Run: `grep -rn "h-screen" apps/frontend/src` — Expected: no output.

- [ ] **Step 3: touch CSS**

Append to `apps/frontend/src/styles.css`:

```css
/* Mobile touch ergonomics (spec §4): one-finger swipe scrolls the xterm
   buffer, not the page; no double-tap zoom on controls. Coarse-pointer only
   so desktop behavior is byte-identical. */
@media (pointer: coarse) {
  .xterm,
  .xterm .xterm-viewport {
    touch-action: pan-y;
  }
  .xterm .xterm-viewport {
    overscroll-behavior: contain;
  }
  button,
  a,
  [role="button"],
  [role="tab"] {
    touch-action: manipulation;
  }
}
```

- [ ] **Step 4: Gates**

Run: `bun run verify-types && bun run lint:check && bun run test` — Expected: all green (unit tests don't cover CSS; the e2e mobile specs in Tasks 8–9 are the real check).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend
git commit -m "feat(ui): dvh heights, viewport-fit=cover, and coarse-pointer touch CSS"
```

---

### Task 2: Coarse-pointer + visual-viewport hooks

**Files:**
- Create: `apps/frontend/src/hooks/use-is-coarse-pointer.ts`
- Create: `apps/frontend/src/hooks/use-visual-viewport-insets.ts`
- Test: `apps/frontend/src/hooks/__tests__/use-is-coarse-pointer.test.ts`
- Test: `apps/frontend/src/hooks/__tests__/use-visual-viewport-insets.test.ts`

**Interfaces:**
- Consumes: existing `use-is-wide.ts` hook shape as the template; `src/test-setup.ts` already stubs `matchMedia` (matches:false) and lacks `visualViewport` — tests override both.
- Produces:
  - `useIsCoarsePointer(): boolean` — true on touch-primary pointers.
  - `computeInsets(vv: { height: number; offsetTop: number }): { heightPx: number; offsetYpx: number }` — exported pure math.
  - `useVisualViewportInsets(): { heightPx: number; offsetYpx: number } | null` — null unless (coarse pointer AND `window.visualViewport` exists).

- [ ] **Step 1: Failing hook tests**

`apps/frontend/src/hooks/__tests__/use-is-coarse-pointer.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";

/** Replace the global test-setup matchMedia stub with a fixed answer. */
function stubMatches(matches: boolean) {
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches,
    media: "(pointer: coarse)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

describe("useIsCoarsePointer", () => {
  const original = window.matchMedia;
  afterEach(() => {
    cleanup();
    (window as unknown as { matchMedia: unknown }).matchMedia = original;
  });

  it("reports coarse when the media query matches", () => {
    stubMatches(true);
    expect(renderHook(() => useIsCoarsePointer()).result.current).toBe(true);
  });

  it("reports fine otherwise (the test-setup default)", () => {
    expect(renderHook(() => useIsCoarsePointer()).result.current).toBe(false);
  });
});
```

`apps/frontend/src/hooks/__tests__/use-visual-viewport-insets.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { computeInsets, useVisualViewportInsets } from "@/hooks/use-visual-viewport-insets";

describe("computeInsets", () => {
  it("rounds the visible height and clamps the pan offset at zero", () => {
    expect(computeInsets({ height: 852, offsetTop: 0 })).toEqual({ heightPx: 852, offsetYpx: 0 });
    expect(computeInsets({ height: 419.6, offsetTop: 32 })).toEqual({ heightPx: 420, offsetYpx: 32 });
    expect(computeInsets({ height: -4, offsetTop: -10 })).toEqual({ heightPx: 0, offsetYpx: 0 });
  });
});

describe("useVisualViewportInsets", () => {
  const w = window as unknown as Record<string, unknown>;
  const originals: Record<string, unknown> = { visualViewport: w.visualViewport, matchMedia: w.matchMedia };
  afterEach(() => {
    cleanup();
    w.visualViewport = originals.visualViewport;
    w.matchMedia = originals.matchMedia;
  });

  it("is null without a visualViewport (happy-dom default)", () => {
    expect(renderHook(() => useVisualViewportInsets()).result.current).toBeNull();
  });

  it("is null on a fine pointer even with a visualViewport", () => {
    w.visualViewport = { height: 500, offsetTop: 0, addEventListener: () => {}, removeEventListener: () => {} };
    expect(renderHook(() => useVisualViewportInsets()).result.current).toBeNull();
  });

  it("tracks a coarse-pointer visualViewport, resize included", () => {
    w.matchMedia = (q: string) => ({
      matches: q === "(pointer: coarse)",
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    let onResize: (() => void) | null = null;
    const vv = {
      height: 420,
      offsetTop: 40,
      addEventListener: (ev: string, fn: () => void) => {
        if (ev === "resize") onResize = fn;
      },
      removeEventListener: () => {},
    };
    w.visualViewport = vv;
    const { result } = renderHook(() => useVisualViewportInsets());
    expect(result.current).toEqual({ heightPx: 420, offsetYpx: 40 });
    vv.height = 300;
    onResize?.();
    expect(result.current).toEqual({ heightPx: 300, offsetYpx: 40 });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/frontend && bun test src/hooks` — Expected: FAIL "Cannot find module … use-is-coarse-pointer".

- [ ] **Step 3: Implement hooks**

`apps/frontend/src/hooks/use-is-coarse-pointer.ts`:

```ts
import { useEffect, useState } from "react";

/**
 * True on touch-primary pointers (phones, tablets with a finger). Mirrors
 * `useIsWide()`'s matchMedia plumbing. A desktop with a touchscreen reports
 * `fine` (pointer: fine reflects the PRIMARY pointer), which is what we want:
 * the mouse-driven chrome stays.
 */
export function useIsCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
    mql.addEventListener("change", onChange);
    setCoarse(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return coarse;
}
```

`apps/frontend/src/hooks/use-visual-viewport-insets.ts`:

```ts
import { useEffect, useState } from "react";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";

/** What a full-height mobile surface must size/shift to stay above the soft
 * keyboard: the visible viewport never changes the layout viewport on iOS,
 * only `visualViewport` does. */
export interface VisualViewportInsets {
  /** Visible height in px (soft keyboard subtracted). */
  heightPx: number;
  /** Downward pan (px) iOS applies to the layout viewport when an input is
   * focused; a full-height shell translates by it to stay glued to the top
   * of the visible viewport. */
  offsetYpx: number;
}

/** Pure math, exported for unit tests. */
export function computeInsets(vv: { height: number; offsetTop: number }): VisualViewportInsets {
  return { heightPx: Math.max(0, Math.round(vv.height)), offsetYpx: Math.max(0, vv.offsetTop) };
}

/**
 * Tracks `window.visualViewport` on coarse-pointer devices and returns the
 * insets a full-height page should apply; null everywhere else (desktop,
 * browsers without the API) so callers fall back to their CSS `h-dvh`.
 */
export function useVisualViewportInsets(): VisualViewportInsets | null {
  const coarse = useIsCoarsePointer();
  const [insets, setInsets] = useState<VisualViewportInsets | null>(null);

  useEffect(() => {
    const vv = coarse ? window.visualViewport : null;
    if (!vv) {
      setInsets(null);
      return;
    }
    const update = () => setInsets(computeInsets(vv));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [coarse]);

  return insets;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/frontend && bun test src/hooks` — Expected: all pass.

- [ ] **Step 5: Gates + commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/src/hooks
git commit -m "feat(ui): coarse-pointer and visual-viewport inset hooks"
```

---

### Task 3: Sheet + mobile top bar + root shell swap

**Files:**
- Create: `apps/frontend/src/components/ui/sheet.tsx`
- Create: `apps/frontend/src/components/mobile-top-bar.tsx`
- Modify: `apps/frontend/src/routes/__root.tsx` (full rewrite, 25 lines)
- Modify: `apps/frontend/src/components/app-sidebar.tsx` (add `forceExpanded` + `className` props)
- Test: `apps/frontend/src/components/__tests__/sheet.test.tsx`

**Interfaces:**
- Consumes: `useIsWide()` (`@/hooks/use-is-wide`); `@base-ui/react/dialog` (installed); `AppSidebar` (now `({ forceExpanded?: boolean; className?: string }) => JSX.Element`).
- Produces: `Sheet` (alias of Base UI `Dialog.Root`), `SheetTrigger`, `SheetContent({ side?: "left" | "right" })`, `SheetTitle`, `SheetClose`; `MobileTopBar()` renders the hamburger + drawer. `__root.tsx` renders `<MobileTopBar/>` below the breakpoint and the sidebar above it.

- [ ] **Step 1: Failing sheet test**

`apps/frontend/src/components/__tests__/sheet.test.tsx`:

```tsx
import { describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

describe("Sheet", () => {
  it("opens from the trigger and closes from the built-in close button", () => {
    render(
      <Sheet>
        <SheetTrigger aria-label="Open navigation">☰</SheetTrigger>
        <SheetContent side="left">
          <SheetTitle>Navigation</SheetTitle>
          <nav aria-label="Main">links</nav>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // Base UI keeps the popup mounted through the exit animation — it must
    // end up unmounted, matching the Radix behavior consumers rely on.
    setTimeout(() => {
      cleanup();
    }, 0);
  });
});
```

Run: `cd apps/frontend && bun test src/components/__tests__/sheet.test.tsx` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement `sheet.tsx`**

```tsx
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { JSX } from "react";
import { cn } from "@/lib/utils";

/**
 * Side sheet: a dialog panel sliding in from a screen edge, built on Base
 * UI's Dialog (positioning + animation only — swipe-to-close is not wired;
 * the nav drawer uses tap-outside, Escape, or the X).
 *
 * NOTE (post-migration lesson, see .migration/dialog.md): never combine the
 * Tailwind NEGATIVE prefix with a negative arbitrary value —
 * `-translate-x-[-100%]` compiles to +100%. Use bare values
 * (`-translate-x-full`) as below.
 */
export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

export interface SheetContentProps extends Dialog.Popup.Props {
  /** Edge the panel slides in from (default left). */
  side?: "left" | "right";
}

export function SheetContent({ className, side = "left", children, ...props }: SheetContentProps): JSX.Element {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/70 opacity-100 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <Dialog.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 z-50 flex w-64 max-w-[85vw] flex-col bg-card shadow-lg transition-transform duration-200",
          "pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]",
          side === "left"
            ? "left-0 border-r border-border data-ending-style:-translate-x-full data-starting-style:-translate-x-full"
            : "right-0 border-l border-border data-ending-style:translate-x-full data-starting-style:translate-x-full",
          className,
        )}
        {...props}
      >
        {children}
        <Dialog.Close aria-label="Close" className="absolute top-3 right-3 rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2">
          <X className="h-4 w-4" />
        </Dialog.Close>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

export function SheetTitle({ className, ...props }: Dialog.Title.Props): JSX.Element {
  return <Dialog.Title className={cn("font-semibold text-lg", className)} {...props} />;
}
```

- [ ] **Step 3: Sheet test passes**

Run: `cd apps/frontend && bun test src/components/__tests__/sheet.test.tsx` — Expected: PASS.

- [ ] **Step 4: AppSidebar props**

Change the signature and root classes in `app-sidebar.tsx`:

```tsx
export function AppSidebar({ forceExpanded = false, className }: { forceExpanded?: boolean; className?: string }) {
```

Compute the effective collapsed value right below the existing `useState`:

```tsx
  // Inside the mobile drawer the rail is always expanded and the collapse
  // control is meaningless (the sheet IS the expander).
  const collapsed = forceExpanded ? false : collapsedState;
```

(rename the existing `const [collapsed, setCollapsed]` state to `const [collapsedState, setCollapsed]`; `toggle()` keeps using `setCollapsed` unchanged.) In the brand block, hide the collapse chevron `Button` when `forceExpanded` (wrap it in `{!forceExpanded && ( … )}`), and merge `className` into the `<aside>` `cn(...)` call so the drawer can pass `w-full`:

```tsx
    <aside
      className={cn(
        "relative flex shrink-0 flex-col border-border border-r bg-card transition-[width] duration-200",
        collapsed ? "w-14" : "w-56",
        className,
      )}
    >
```

- [ ] **Step 5: MobileTopBar**

Create `apps/frontend/src/components/mobile-top-bar.tsx`:

```tsx
import { useLocation } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * Slim chrome replacing the persistent sidebar below the tiling breakpoint:
 * a hamburger that opens the sidebar inside a side sheet. Any route change
 * closes the drawer (a tap that navigates also dismisses the menu, like a
 * native drawer).
 */
export function MobileTopBar() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          aria-label="Open navigation"
          className="flex h-9 w-9 touch-manipulation items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          <Menu className="h-5 w-5" />
        </SheetTrigger>
        <SheetContent side="left" className="p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <AppSidebar forceExpanded className="w-full border-r-0" />
        </SheetContent>
      </Sheet>
      <span className="font-bold text-base">◆ Mote</span>
    </header>
  );
}
```

(`onOpenChange` receives Base UI's event-details second argument; `setOpen` ignores it — arity-compatible.)

- [ ] **Step 6: Root shell**

Rewrite `__root.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { MobileTopBar } from "@/components/mobile-top-bar";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { useIsWide } from "@/hooks/use-is-wide";
import { queryClient } from "@/lib/query-client";

export const Route = createRootRoute({
  component: RootComponent,
});

/**
 * The responsive shell (spec §3): at/above the tiling breakpoint the classic
 * sidebar layout; below it a top bar whose drawer holds the SAME AppSidebar
 * — one nav implementation, two containers. Safe-area padding lives here so
 * no page has to know about the notch.
 */
function RootComponent() {
  const wide = useIsWide();
  return (
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <div className="flex h-dvh flex-col overflow-hidden">
          {!wide && <MobileTopBar />}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {wide && <AppSidebar />}
            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
              <Outlet />
            </div>
          </div>
        </div>
      </ConfirmProvider>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 7: Gates + existing tests + commit**

Run: `bun run verify-types && bun run lint:check && bun run test` — Expected: green (e2e still desktop-only; `wide` is true for Desktop Chrome, so shell rendering in jsdom/e2e is unchanged).

```bash
git add apps/frontend/src/components apps/frontend/src/routes/__root.tsx
git commit -m "feat(ui): responsive shell — drawer + top bar below 1024px, Sheet on Base UI"
```

---

### Task 4: Terminal accessory key bar + session-page viewport pinning

**Files:**
- Create: `apps/frontend/src/components/terminal-key-bar.tsx`
- Modify: `apps/frontend/src/routes/sessions_.$id.tsx`
- Modify: `apps/frontend/src/routes/workspaces_.$id.tsx` (inset on the h-dvh main)
- Test: `apps/frontend/src/components/__tests__/terminal-key-bar.test.tsx`

**Interfaces:**
- Consumes: `sendInputRef` (the page's `SessionTerminalHandles.sendInput`), `setCommandMode` (page-local), `useIsCoarsePointer` / `useVisualViewportInsets` (Task 2).
- Produces: `KEY_BAR_BUTTONS: KeyBarButton[]` (exported byte table) and `<TerminalKeyBar disabled onBytes onSlash />` (role `toolbar`, accessible name "Terminal special keys"); session page passes `onBytes` for `^C`/`^[` (proven against the pane log in Task 9).

- [ ] **Step 1: Failing key-bar test**

Create `apps/frontend/src/components/__tests__/terminal-key-bar.test.tsx` (the byte table is asserted from `KEY_BAR_BUTTONS` itself so the test can never silently drift from the component):

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KEY_BAR_BUTTONS, TerminalKeyBar } from "@/components/terminal-key-bar";

describe("TerminalKeyBar", () => {
  afterEach(cleanup);

  it("maps every button to its exact bytes", () => {
    const table = Object.fromEntries(KEY_BAR_BUTTONS.filter((b) => b.bytes).map((b) => [b.aria, b.bytes]));
    expect(table).toEqual({
      "Send Escape": "\x1b",
      "Send Ctrl-C": "\x03",
      "Send Shift-Tab": "\x1b[Z",
      "Send Tab": "\t",
      "Send arrow left": "\x1b[D",
      "Send arrow up": "\x1b[A",
      "Send arrow down": "\x1b[B",
      "Send arrow right": "\x1b[C",
    });
  });

  it("clicking a byte button sends exactly that sequence", () => {
    const sent: string[] = [];
    render(<TerminalKeyBar disabled={false} onBytes={(b) => sent.push(b)} onSlash={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Send Ctrl-C" }));
    fireEvent.click(screen.getByRole("button", { name: "Send arrow up" }));
    expect(sent).toEqual(["\x03", "\x1b[A"]);
  });

  it("the / button opens the palette and sends nothing", () => {
    const sent: string[] = [];
    let slashes = 0;
    render(<TerminalKeyBar disabled={false} onBytes={(b) => sent.push(b)} onSlash={() => slashes++} />);
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    expect(slashes).toBe(1);
    expect(sent).toEqual([]);
  });

  it("is inert while disabled", () => {
    let clicks = 0;
    render(<TerminalKeyBar disabled onBytes={() => clicks++} onSlash={() => clicks++} />);
    for (const btn of screen.getAllByRole("button")) fireEvent.click(btn);
    expect(clicks).toBe(0);
  });
});
```

Run: `cd apps/frontend && bun test src/components/__tests__/terminal-key-bar.test.tsx` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement the key bar**

`apps/frontend/src/components/terminal-key-bar.tsx`:

```tsx
import { cn } from "@/lib/utils";

/** One key-bar button. `/` has no bytes — it opens the "/" command palette
 * through `onSlash` (the same handler the physical `/` key reaches). */
export interface KeyBarButton {
  /** Glyph printed on the button */
  label: string;
  /** Accessible name; also the test/e2e locator */
  aria: string;
  /** Raw bytes written to the pane, or undefined for the palette trigger.
   * Plain CSI arrows (not SS3): tmux translates them for whatever cursor
   * mode the inner app set — the same encoding a desktop xterm sends. */
  bytes?: string;
}

export const KEY_BAR_BUTTONS: KeyBarButton[] = [
  { label: "Esc", aria: "Send Escape", bytes: "\x1b" },
  { label: "^C", aria: "Send Ctrl-C", bytes: "\x03" },
  { label: "⇧Tab", aria: "Send Shift-Tab", bytes: "\x1b[Z" },
  { label: "Tab", aria: "Send Tab", bytes: "\t" },
  { label: "/", aria: "Open command palette" },
  { label: "←", aria: "Send arrow left", bytes: "\x1b[D" },
  { label: "↑", aria: "Send arrow up", bytes: "\x1b[A" },
  { label: "↓", aria: "Send arrow down", bytes: "\x1b[B" },
  { label: "→", aria: "Send arrow right", bytes: "\x1b[C" },
];

export interface TerminalKeyBarProps {
  /** Grayed until the session WS is attached */
  disabled: boolean;
  /** Write raw bytes to the pane */
  onBytes: (bytes: string) => void;
  /** Open the "/" palette */
  onSlash: () => void;
}

/** Accessory special-key row for touch devices (spec §5). Buttons are
 * min-h-11 (44px) and touch-manipulation (no double-tap zoom). */
export function TerminalKeyBar({ disabled, onBytes, onSlash }: TerminalKeyBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Terminal special keys"
      className="flex shrink-0 items-stretch gap-px overflow-x-auto border-t border-border bg-card pb-[env(safe-area-inset-bottom)]"
    >
      {KEY_BAR_BUTTONS.map((b) => (
        <button
          key={b.label}
          type="button"
          disabled={disabled}
          aria-label={b.aria}
          onClick={() => (b.bytes ? onBytes(b.bytes) : onSlash())}
          className={cn(
            "min-h-11 flex-1 basis-11 touch-manipulation select-none bg-transparent font-mono text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-40",
          )}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Run the key-bar test**

Run: `cd apps/frontend && bun test src/components/__tests__/terminal-key-bar.test.tsx` — Expected: PASS.

- [ ] **Step 4: Wire the session page**

In `sessions_.$id.tsx`:

Add imports:

```ts
import { TerminalKeyBar } from "@/components/terminal-key-bar";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";
import { useVisualViewportInsets } from "@/hooks/use-visual-viewport-insets";
```

In `SessionPage()`, near the other hook calls:

```ts
  // Touch UX (spec §5): the accessory key bar appears on coarse pointers,
  // and on iOS the visible viewport (not 100dvh) shrinks under the soft
  // keyboard — pin the page column to it so the prompt line stays visible.
  const coarse = useIsCoarsePointer();
  const insets = useVisualViewportInsets();
```

Add the byte sink (Esc while the palette is open mirrors the physical-key
path in `handleTerminalKey`, so the two input routes behave identically):

```ts
  /** Key-bar byte sink: Esc cancels an open palette (matching the physical
   * key); every other byte goes to the pane as an input frame. */
  function handleKeyBarBytes(bytes: string) {
    if (bytes === "\x1b" && commandMode) {
      setCommandMode(false);
      return;
    }
    sendInputRef.current?.(bytes);
  }
```

Replace the `<main …>` opening tag (line ~159):

```tsx
    <main
      className="flex h-dvh flex-col"
      style={insets ? { height: `${insets.heightPx}px`, transform: `translateY(${insets.offsetYpx}px)` } : undefined}
    >
```

Hide the working-dir text below `sm` — change its span:

```tsx
          <span className="ml-2 truncate text-muted-foreground text-xs hidden sm:inline">{session?.workingDir}</span>
```

Render the key bar as the last child of `<main>`, after the terminal block's
closing `</div>` (before `</main>`):

```tsx
      {coarse && <TerminalKeyBar disabled={!connected} onBytes={handleKeyBarBytes} onSlash={() => setCommandMode(true)} />}
```

- [ ] **Step 5: Workspace page pinning**

In `workspaces_.$id.tsx`, same pattern: import `useVisualViewportInsets`, call it in the component, and give the `<main className="flex h-dvh flex-col overflow-hidden">` the same conditional `style={{ height, transform }}`. (Panes' xterm textareas open the keyboard too.)

- [ ] **Step 6: Gates + commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/src/components/terminal-key-bar.tsx apps/frontend/src/components/__tests__/terminal-key-bar.test.tsx apps/frontend/src/routes
git commit -m "feat(ui): terminal accessory key bar + visual-viewport keyboard pinning"
```

---

### Task 5: Dialog scroll/width fix + users form stacking

**Files:**
- Modify: `apps/frontend/src/components/ui/dialog.tsx:38` (the Popup class string)
- Modify: `apps/frontend/src/routes/users.tsx` (create-user grid)

**Interfaces:**
- Consumes: nothing new.
- Produces: dialogs capped at 85dvh with internal scroll and a 12px viewport margin on phones (spec §7; e2e 08 asserts the box fits the viewport); `/users` stacks one column below `sm`.

- [ ] **Step 1: Dialog classes**

In `dialog.tsx`, replace `w-full max-w-lg` inside the Popup class string with:

```
w-[calc(100vw-1.5rem)] max-w-lg sm:w-full
```

and insert `max-h-[85dvh] overflow-y-auto` after `grid` (keep everything else, incl. the `translate-x-[-50%] translate-y-[-50%]` centering — do NOT touch the translate signs). Result:

```
"fixed top-[50%] left-[50%] z-50 grid max-h-[85dvh] w-[calc(100vw-1.5rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto border bg-card p-6 opacity-100 shadow-lg transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0 sm:w-full sm:rounded-lg",
```

- [ ] **Step 2: Users form**

`users.tsx`: `<form onSubmit={createUser} className="grid grid-cols-12 items-start gap-3">` → `"grid grid-cols-1 items-start gap-3 sm:grid-cols-12"`. Change the four field wrappers `col-span-4`/`col-span-2` → `sm:col-span-4`/`sm:col-span-2` (bare under `sm`, spans on top).

- [ ] **Step 3: Gates + commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/src/components/ui/dialog.tsx apps/frontend/src/routes/users.tsx
git commit -m "fix(ui): dialogs cap at 85dvh with scroll and viewport margin on phones; /users form stacks"
```

---

### Task 6: PWA assets + static-plugin dist-root serving

**Files:**
- Create: `apps/frontend/public/manifest.webmanifest`
- Create: `apps/frontend/public/icons/mote-source.svg`, `apps/frontend/public/icons/mote-maskable.svg`
- Create: `apps/frontend/scripts/gen-icons.ts` (+ package.json script `"gen:icons"`)
- Create (generated, committed): `apps/frontend/public/icons/icon-192.png`, `icon-512.png`, `apple-touch-icon.png`
- Modify: `apps/frontend/index.html` (head block)
- Modify: `apps/backend/src/plugins/static.plugin.ts` (SPA fallback serves dist-root files)
- Test: `apps/backend/src/plugins/__tests__/static.plugin.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /manifest.webmanifest` + `/icons/*.png` served in prod; head tags present (e2e 08 asserts both); `.webmanifest` content type.

- [ ] **Step 1: Failing backend tests**

Add to `static.plugin.test.ts` fixtures (near the other writeFileSync calls) and cases:

```ts
mkdirSync(join(root, "icons"), { recursive: true });
writeFileSync(join(root, "manifest.webmanifest"), '{"name":"Mote","display":"standalone"}');
writeFileSync(join(root, "icons/icon-192.png"), "PNGBYTES");
```

```ts
  it("serves dist-root files (PWA manifest, icons) with their content type", async () => {
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    expect(await manifest.text()).toContain("standalone");
    const icon = await get("/icons/icon-192.png");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/png");
  });

  it("404s dotted paths that do not exist — even for HTML-seeking browsers", async () => {
    const res = await get("/missing.webmanifest", { accept: "text/html" });
    expect(res.status).toBe(404);
  });

  it("blocks traversal through dotted root paths", async () => {
    writeFileSync(join(root, "..", "outside.txt"), "secret");
    const res = await get("/%2e%2e/outside.txt");
    expect(res.status).toBe(404);
  });
```

Run: `cd apps/backend && bun test src/plugins/__tests__/static.plugin.test.ts` — Expected: the first new case FAILs (manifest currently 404s — `pathname.includes(".")` short-circuits to 404).

- [ ] **Step 2: Implement the fallback change**

In `static.plugin.ts`: add `".webmanifest": "application/manifest+json",` to `CONTENT_TYPES`. Replace the `get("*")` handler body with:

```ts
    // SPA fallback: any other top-level GET route → index.html — EXCEPT
    // dotted paths, which are files: serve them when they actually exist
    // inside dist/ (manifest.webmanifest, favicon.ico, icons/*), otherwise
    // 404. Same traversal guard as /assets/*.
    .get("*", ({ request }) => {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
      if (pathname.includes(".")) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(pathname);
        } catch {
          return new Response("not found", { status: 404 });
        }
        const filePath = join(root, normalize(decoded.replace(/^\//, "")));
        if (!filePath.startsWith(root + sep)) return new Response("not found", { status: 404 });
        const ext = filePath.match(/\.[a-z0-9]+$/i)?.[0] ?? "";
        let body: Uint8Array;
        try {
          body = readFileSync(filePath);
        } catch {
          return new Response("not found", { status: 404 });
        }
        return new Response(body, {
          headers: {
            "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
            // Root files are unhashed; a rebuild may replace them in place.
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
      if (!acceptsHtml) {
        return new Response("not found", { status: 404 });
      }
      return new Response(currentIndexHtml(), { headers: htmlHeaders });
    });
```

Run: `cd apps/backend && bun test src/plugins/__tests__/static.plugin.test.ts` — Expected: PASS (old cases included; note the old "JSON APIs are never HTML" case still holds — unregistered dotted /api paths 404 either way).

- [ ] **Step 3: Icon sources + generator**

`apps/frontend/public/icons/mote-source.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0a0a0a"/>
  <path d="M256 120l136 136-136 136-136-136z" fill="#67c3ec"/>
</svg>
```

(`#67c3ec` ≈ the app's `--primary` oklch(0.78 0.12 250); `#0a0a0a` = `--background` oklch(0.145 0 0).)

`apps/frontend/public/icons/mote-maskable.svg`: same but the diamond at 60% centered (safe zone): `<path d="M256 182l74 74-74 74-74-74z" …/>` inside the full-bleed rect.

`apps/frontend/scripts/gen-icons.ts`:

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

/** Rasterizes the committed SVG sources to the PWA icon set. Run manually
 * after changing the art: `bun run gen:icons` (apps/frontend). The PNGs are
 * committed so builds never need sharp. */
const out = new URL("../public/icons/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

await sharp(join(out, "mote-source.svg")).resize(192, 192).png().toFile(join(out, "icon-192.png"));
await sharp(join(out, "mote-maskable.svg")).resize(512, 512).png().toFile(join(out, "icon-512.png"));
await sharp(join(out, "mote-source.svg")).resize(180, 180).png().toFile(join(out, "apple-touch-icon.png"));
console.log("icons written to", out);
```

Add devDependency + script (repo rule: pinned):

```bash
cd apps/frontend && bun add -d sharp && bunx syncpack fix && bun install
```

Then add to `apps/frontend/package.json` scripts: `"gen:icons": "bun scripts/gen-icons.ts"` and run it (`bun run gen:icons`) — Expected: three PNGs appear in `public/icons/`.

- [ ] **Step 4: Manifest + head tags**

`apps/frontend/public/manifest.webmanifest`:

```json
{
  "name": "Mote",
  "short_name": "Mote",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#0a0a0a",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`index.html` head (after the viewport meta; also fix the stale title):

```html
    <title>Mote</title>
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" content="#0a0a0a" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
```

- [ ] **Step 5: Build + serve check**

```bash
bunx turbo build --filter=@internal/frontend
ls apps/frontend/dist/manifest.webmanifest apps/frontend/dist/icons/icon-512.png
```

Expected: both listed (Vite copies `public/` verbatim).

- [ ] **Step 6: Gates + commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/public apps/frontend/scripts apps/frontend/index.html apps/frontend/package.json apps/backend/src/plugins bun.lock
git commit -m "feat: PWA home-screen assets + dist-root file serving in the static plugin"
```

---

### Task 7: Dockview touch polish (iPad landscape)

**Files:**
- Modify: `apps/frontend/src/styles/dockview-theme.css` (append)

**Interfaces:**
- Consumes: installed dockview 8.2 selectors — verified against the bundle: `.dockview-theme-abyss` (root class on `<DockviewReact className>`), `.dv-tabs-and-actions-container`, `.dv-sash`, `.dv-default-tab-action`; the local theme already sets `--dv-tabs-and-actions-container-height: 36px`.
- Produces: on coarse pointers the tab strip is 44px and every sash carries a ~24px invisible hit band (spec §6). Menu-driven split/close remains the documented finger path.

- [ ] **Step 1: Append CSS**

```css
/* Touch ergonomics for iPad landscape (spec §6): fingers need more than a
   36px strip and a hairline sash. Coarse-pointer only; the visual divider
   stays slim — ::before widens only the hit area. Splitting/closing panes by
   finger remains the pane menus' job (dockview drag on touch is best-effort,
   verified manually, not asserted by tests). */
@media (pointer: coarse) {
  .dockview-theme-abyss.dockview-theme-abyss {
    --dv-tabs-and-actions-container-height: 44px;
  }
  .dockview-theme-abyss .dv-default-tab-action {
    padding: 6px;
  }
  .dockview-theme-abyss .dv-sash::before {
    content: "";
    position: absolute;
    inset: -11px;
  }
}
```

- [ ] **Step 2: Verify the sash is positioned (guard for the ::before trick)**

Run: `grep -o "\.dv-sash{[^}]*}" node_modules/dockview*/dist/styles/dockview.css node_modules/.bun/dockview@8.2.0/node_modules/dockview/dist/styles/dockview.css | grep -m1 position` — Expected: a rule containing `position: absolute`. If it instead shows the position lives only on `.dv-sash-container`, add `position: absolute;` to the `.dv-sash::before` rule's parent rule:

```css
  .dockview-theme-abyss .dv-sash {
    position: absolute;
  }
```

(match dockview's own positioning — it sets left/top inline, so this only
defaults `static`→`absolute` where dockview hasn't already.)

- [ ] **Step 3: Gates + commit**

```bash
bun run lint:check && bun run test
git add apps/frontend/src/styles/dockview-theme.css
git commit -m "feat(ui): coarse-pointer dock sizing — 44px tab strip, widened sash hit areas"
```

---

### Task 8: e2e projects + 08-mobile-shell spec

**Files:**
- Modify: `e2e/playwright.config.ts` (projects)
- Create: `e2e/tests/08-mobile-shell.spec.ts`

**Interfaces:**
- Consumes: all earlier tasks; `ADMIN_STATE` from `./helpers`; `test.use({ storageState })` idiom.
- Produces: Playwright projects `mobile` (iPhone 15 Pro 393×659, touch) and `ipad-landscape` (1194×834, touch) that Task 9's spec also runs under; desktop specs unchanged.

- [ ] **Step 1: Projects**

Replace the `projects:` array:

```ts
  projects: [
    // Desktop specs run everywhere EXCEPT the mobile projects, which only
    // pick up the 08/09 mobile suite (specs 00-07 assume desktop chrome).
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: [/0\d-mobile/] },
    { name: "mobile", use: { ...devices["iPhone 15 Pro"] }, testMatch: [/0\d-mobile/] },
    { name: "ipad-landscape", use: { ...devices["iPad Pro 11 landscape"] }, testMatch: [/08-mobile/] },
  ],
```

- [ ] **Step 2: The spec**

Create `e2e/tests/08-mobile-shell.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/** Same admin the desktop specs created (spec 01); projects decide the
 * viewport. `mobile` = iPhone 15 Pro (393x659, touch, drawer shell);
 * `ipad-landscape` = 1194x834, touch (desktop shell + dock). */
const isPhone = () => test.info().project.name === "mobile";

test("no horizontal overflow on the main routes", async ({ page }) => {
  for (const path of ["/", "/workspaces", "/settings", "/users"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});

test("shell chrome follows the 1024px rule", async ({ page }) => {
  await page.goto("/");
  if (isPhone()) {
    const burger = page.getByRole("button", { name: "Open navigation" });
    await expect(burger).toBeVisible();
    await expect(page.locator("aside")).toHaveCount(0);
    await burger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    // Navigating dismisses the drawer (route-change effect).
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } else {
    await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
    await expect(page.locator("aside")).toBeVisible();
  }
});

test("add-session dialog fits and scrolls on small screens", async ({ page }, testInfo) => {
  await page.goto("/workspaces");
  await page.getByRole("button", { name: "New workspace" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/, { timeout: 15_000 });

  // Shell rule on the workspace page itself: tabs below 1024px, dock above.
  if (isPhone()) {
    await expect(page.locator(".dockview-theme-abyss")).toHaveCount(0);
  } else {
    await expect(page.locator(".dockview-theme-abyss")).toHaveCount(1);
    const tabStripHeight = await page
      .locator(".dockview-theme-abyss")
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--dv-tabs-and-actions-container-height").trim());
    expect(tabStripHeight).toBe("44px"); // coarse-pointer bump (Task 7)
  }

  await page.getByRole("button", { name: "Add a session to this workspace" }).click();
  await expect(page.getByRole("heading", { name: "Add a session" })).toBeVisible();
  const dialog = page.getByRole("dialog");
  const box = await dialog.boundingBox();
  const vp = page.viewportSize();
  expect(box, "dialog box").toBeTruthy();
  expect(box!.height, `dialog ${box!.height}px vs viewport ${vp?.height}px`).toBeLessThanOrEqual((vp?.height ?? 0) + 1);
  // The bottom of the form (Start session) must be reachable — scroll inside
  // the dialog, the whole point of the max-h/overflow change.
  const start = page.getByRole("button", { name: "New session" });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeInViewport();
  await page.keyboard.press("Escape");
  void testInfo;
});

test("home-screen install assets are served", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  const json = await manifest.json();
  expect(json.display).toBe("standalone");
  for (const href of ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"]) {
    const res = await page.request.get(href);
    expect(res.ok(), href).toBe(true);
  }
});
```

- [ ] **Step 3: Run the suite**

Run: `bun run test:e2e` — Expected: specs 00–07 pass on chromium, 08 passes on mobile AND ipad-landscape. If `08`'s dialog box is too tall on the phone project, the cap/scroll from Task 5 didn't land — fix that, not the assertion.

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): iPhone 15 Pro + iPad landscape projects with the mobile shell spec"
```

---

### Task 9: Stub input echo + 09-mobile-terminal spec

**Files:**
- Modify: `e2e/stub/pi` (echo pane stdin visibly)
- Create: `e2e/tests/09-mobile-terminal.spec.ts`

**Interfaces:**
- Consumes: key bar (Task 4: button aria names, toolbar role), `GET /api/sessions/:id/log` → `{ lines: string[]; truncated }` (ANSI-stripped), `POST /api/sessions/:id/terminate`, `DELETE /api/sessions/:id`; the spec-06 create flow verbatim.
- Produces: proof that key-bar clicks deliver exact bytes into a real tmux pane — the headline mobile assertion.

- [ ] **Step 1: Stub echoes input**

In `e2e/stub/pi`, immediately after the `echo "mote-e2e stub harness ready"` line, add:

```bash
# Echo pane input back visibly so specs can prove keystrokes reached the PTY
# (mobile key bar, spec 09). Raw mode makes control bytes arrive as BYTES
# (no signals); cat -v renders them visibly (^C, ^[, ^I). Its output has no
# trailing newline — lines land glued to whichever tick follows; assertions
# join the tail before matching.
stty raw -echo 2>/dev/null || true
cat -v &
```

- [ ] **Step 2: The spec**

Create `e2e/tests/09-mobile-terminal.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

const SPAWN_TIMEOUT = 30_000;

/**
 * The headline mobile assertion (spec §5): key-bar buttons must deliver the
 * exact bytes to a REAL tmux pane. xterm paints to WebGL, so truth is the
 * server-side pane log — the stub harness now echoes stdin via `cat -v`
 * (^C, ^[ appear literally).
 */
test("accessory key bar sends real bytes into the pane", async ({ page }) => {
  test.setTimeout(120_000);
  const name = `e2e-keybar-${test.info().retry}`;

  await page.goto("/new");
  await page.getByText("Choose a profile").click();
  await page.getByRole("option", { name: "Default (pi)" }).click();
  await page.fill("#working-dir", "/tmp");
  await page.fill("#name", name);

  const tokenRes = page.waitForResponse((r) => r.url().includes("/api/auth/ws-token") && r.status() === 200, {
    timeout: SPAWN_TIMEOUT,
  });
  const socket = page.waitForEvent("websocket", {
    predicate: (w) => w.url().includes("/ws?session="),
    timeout: SPAWN_TIMEOUT,
  });
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(/\/sessions\/.+/, { timeout: SPAWN_TIMEOUT });
  await tokenRes;
  await socket;
  await expect(page.getByText("reconnecting…")).toHaveCount(0, { timeout: SPAWN_TIMEOUT });

  const bar = page.getByRole("toolbar", { name: "Terminal special keys" });
  await expect(bar).toBeVisible(); // coarse pointer under device emulation

  await bar.getByRole("button", { name: "Send Ctrl-C" }).click();
  await bar.getByRole("button", { name: "Send Escape" }).click();

  const id = new URL(page.url()).pathname.split("/").pop()!;
  const logText = async () => {
    const res = await page.request.get(`/api/sessions/${id}/log`);
    if (!res.ok()) return "";
    const body = (await res.json()) as { lines: string[] };
    return body.lines.join("\n");
  };
  await expect
    .poll(async () => (await logText()).includes("^C"), { timeout: SPAWN_TIMEOUT })
    .toBe(true);
  await expect
    .poll(async () => (await logText()).includes("^["), { timeout: 10_000 })
    .toBe(true);

  // The "/" button opens the palette instead of typing into the pane.
  await bar.getByRole("button", { name: "Open command palette" }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  // Esc (via the key bar) cancels the palette — not a stray byte to the pane.
  await bar.getByRole("button", { name: "Send Escape" }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);

  // Clean up after itself (shared-DB ordering contract).
  expect((await page.request.post(`/api/sessions/${id}/terminate`)).ok()).toBe(true);
  expect((await page.request.delete(`/api/sessions/${id}`)).ok()).toBe(true);
});
```

- [ ] **Step 3: Run + commit**

Run: `bun run test:e2e` — Expected: full suite green (08 on both mobile projects, 09 on mobile).

```bash
git add e2e
git commit -m "test(e2e): key-bar bytes reach a real pane, proven through the server-side log"
```

---

### Task 10: Docs, mobile manual-QA checklist, final gate

**Files:**
- Modify: `README.md` (feature bullets + remote section)
- Modify: `docs/overview.md` (Workspaces row, new Mobile row in Key decisions, status line)
- Modify: `docs/architecture.md` (a §-short mention where terminal/WS attach is described — one sentence pointing at the spec)

**Interfaces:**
- Consumes: everything above.
- Produces: documented behavior + the checklist Theo runs on a real iPhone/iPad before merge.

- [ ] **Step 1: README**

Add to the feature bullets (after the Workspaces bullet):

```markdown
- **Mobile-ready** — iPhone and iPad shells built in: drawer nav, a terminal
  key bar (Esc/Ctrl-C/arrows), finger-sized workspace panes, and Add to Home
  Screen for a standalone app. No service worker — it always talks to your
  server.
```

In "Remote / trusted-network operation", append:

```markdown
- Phones/tablets: open the same URL in Safari and use **Add to Home Screen**
  for a standalone install (no browser chrome).
```

- [ ] **Step 2: Overview + architecture**

`docs/overview.md`: in the Key decisions table add a row
`| Mobile | <1024px = drawer shell + tab workspaces (useIsWide, WORKSPACE_TILING_MIN_WIDTH); ≥1024px = today's desktop shell; accessory terminal key bar over the raw WS input path; PWA manifest, no service worker — spec 2026-08-30 |` and bump the Status date/paragraph with one clause: mobile support landed. `docs/architecture.md` §1 "Key properties" or the §5 create flow paragraph: one sentence that the mobile terminal input uses the identical `input` WS frame path (no new transport).

- [ ] **Step 3: Full gate**

Run: `bun run verify-types && bun run lint:check && bun run test && bun run test:e2e` — Expected: all green, tmux sockets clean after teardown (`tmux ls` on default server untouched; per-session sockets gone).

- [ ] **Step 4: Manual QA checklist (real devices — cannot be automated)**

Execute and paste results into the PR/commit notes:

iPhone 15 Pro (Safari + home-screen install):
- [ ] Add to Home Screen → standalone, no browser chrome, notch safe areas respected (top bar text not under the island, key bar not under the home indicator)
- [ ] Session page: one-finger swipe scrolls xterm buffer; page itself doesn't rubber-band
- [ ] Soft keyboard: prompt line + key bar stay visible above it; cursor position after close is correct
- [ ] Esc interrupts a running Claude session; ^C works; ⇧Tab cycles permission mode; `/` opens the palette; arrows move history in a shell
- [ ] Confirm dialogs (terminate/delete) reachable and scrollable
- [ ] Reconnect after app backgrounding (reconnecting pill clears)

iPad Pro 11:
- [ ] Landscape: dock visible, tab strip 44px, sash grabbable by thumb (best-effort), pane-menu split/close works one-handed
- [ ] Portrait: drawer + tab workspaces, `layout_json` untouched (desktop layout unchanged after tablet visits)

- [ ] **Step 5: Commit**

```bash
git add README.md docs
git commit -m "docs: mobile support — README bullets, overview decision row, manual QA checklist"
```
