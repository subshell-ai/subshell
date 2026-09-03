# "Not found" experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare TanStack `Not Found` with a styled, actionable 404 screen, redirect legacy `/sessions/*` URLs to their post-rename equivalents, and show an honest "Subshell not found" card when the detail route's record is a 404.

**Architecture:** Three independent frontend-only layers: (1) a shared card component wired as the router's `defaultNotFoundComponent`; (2) two component-less redirect routes for the old `/sessions` paths; (3) a pure 404 predicate surfaced through `useSubshellData` so `subshells_.$id.tsx` can render the card instead of mounting a terminal whose attach can never succeed. Spec: `docs/superpowers/specs/2026-09-03-not-found-experience-design.md`.

**Tech Stack:** React 19, `@tanstack/react-router` 1.170.30 (file-based routes via `TanStackRouterVite`, route tree regenerated on `vite build`/`vite dev`), Base UI buttons with the `render={<Link/>}` composition, shadcn-style `Card`, tests under `bun test` + `@testing-library/react` (happy-dom preloaded via `bunfig.toml`).

## Global Constraints

- Bun only (`bun test`, `bun run`, `bunx`) — never npm/pnpm/npx (`.claude/rules/package-manager.md`).
- All dependency versions pinned exactly (`.claude/rules/dependencies.md`) — this plan adds none.
- No dynamic imports anywhere (`.claude/rules/code-style.md`).
- Copy style: sentence-case titles, plain declarative body, em-dash allowed (matches "Workspace not found" / "The workspace may have been deleted." in `routes/workspaces_.$id.tsx`).
- Verification trio from repo root before considering anything done: `bun run verify-types && bun run lint:check && bun run test` (`.claude/rules/verification.md`). `bun run lint` may be used to auto-fix formatting before re-checking.
- Work from `apps/frontend/` for scoped test runs (`bun test src/...`), from repo root for the trio.

---

### Task 1: Pure 404 predicate (`isNotFoundSubshellError`)

**Files:**
- Create: `apps/frontend/src/lib/subshell-not-found.ts`
- Test: `apps/frontend/src/lib/__tests__/subshell-not-found.test.ts`

**Interfaces:**
- Consumes: `ApiError` (exported class from `src/lib/api.ts`, field `status: number`, constructor `(status: number, body: string, meta?)`).
- Produces: `isNotFoundSubshellError(error: unknown): boolean` — imported by `use-subshell-data.ts` in Task 3.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/lib/__tests__/subshell-not-found.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { ApiError } from "@/lib/api";
import { isNotFoundSubshellError } from "@/lib/subshell-not-found";

describe("isNotFoundSubshellError", () => {
  it("is true only for a 404 — the backend's single answer for gone AND unshared", () => {
    expect(isNotFoundSubshellError(new ApiError(404, "Not Found"))).toBe(true);
  });

  it("is false for every other failure (transient errors must stay on the reconnect path)", () => {
    expect(isNotFoundSubshellError(new ApiError(403, "no"))).toBe(false);
    expect(isNotFoundSubshellError(new ApiError(500, "boom"))).toBe(false);
    expect(isNotFoundSubshellError(new TypeError("fetch failed"))).toBe(false);
    expect(isNotFoundSubshellError(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test src/lib/__tests__/subshell-not-found.test.ts`
Expected: FAIL — cannot resolve `@/lib/subshell-not-found`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/frontend/src/lib/subshell-not-found.ts`:

```ts
import { ApiError } from "@/lib/api";

/**
 * True when a subshell fetch was answered with 404. The backend answers 404 —
 * never 403 — for BOTH a deleted and a not-shared-with-me subshell (spec
 * 2026-08-31 sharing), so one flag honestly covers both readings. Anything
 * else (5xx, network) is transient and must stay on the reconnect path.
 * Extracted as a pure predicate so `bun test` covers the branch without a
 * DOM (the lib/shell-gate.ts precedent).
 */
export function isNotFoundSubshellError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/frontend && bun test src/lib/__tests__/subshell-not-found.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/subshell-not-found.ts apps/frontend/src/lib/__tests__/subshell-not-found.test.ts
git commit -m "feat(frontend): pure isNotFoundSubshellError predicate for the detail-404 card"
```

---

### Task 2: The two cards + router wiring

**Files:**
- Create: `apps/frontend/src/components/not-found-page.tsx`
- Test: `apps/frontend/src/components/__tests__/not-found-page.test.tsx`
- Modify: `apps/frontend/src/main.tsx:7` (`createRouter` call)

**Interfaces:**
- Consumes: `Card, CardContent, CardDescription, CardHeader, CardTitle` from `@/components/ui/card`; `Button` from `@/components/ui/button`; `Link` from `@tanstack/react-router` (Base UI `render` composition — see `routes/profiles_.$id.tsx:41` for the exact pattern).
- Produces: `NotFoundPage(): JSX` and `SubshellNotFoundCard(): JSX`, both named exports from `@/components/not-found-page` — `NotFoundPage` is used in `main.tsx` (this task), `SubshellNotFoundCard` in `routes/subshells_.$id.tsx` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/__tests__/not-found-page.test.tsx`:

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
import { NotFoundPage, SubshellNotFoundCard } from "@/components/not-found-page";

/** Renders inside a throwaway router — both cards contain a Link, which
 *  needs router context (the throwaway-router pattern from
 *  clone-subshell-dialog.test.tsx). */
function renderWithRouter(component: () => React.ReactElement) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

describe("NotFoundPage", () => {
  afterEach(cleanup);

  it("says the page doesn't exist and offers the way back to the list", async () => {
    renderWithRouter(NotFoundPage);
    expect(await screen.findByText("Page not found")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Go to subshells" });
    expect(link.getAttribute("href")).toBe("/");
  });
});

describe("SubshellNotFoundCard", () => {
  afterEach(cleanup);

  it("names the two honest reasons and links back", async () => {
    renderWithRouter(SubshellNotFoundCard);
    expect(await screen.findByText("Subshell not found")).toBeTruthy();
    expect(screen.getByText(/deleted/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Back to subshells" });
    expect(link.getAttribute("href")).toBe("/");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && bun test src/components/__tests__/not-found-page.test.tsx`
Expected: FAIL — cannot resolve `@/components/not-found-page`.

- [ ] **Step 3: Write the components**

Create `apps/frontend/src/components/not-found-page.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The shared frame for both not-found states: the same centered card the
 * workspace/profile detail routes use (routes/workspaces_.$id.tsx). */
function NotFoundCard({ title, body, action }: { title: string; body: string; action: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
        <CardContent>{action}</CardContent>
      </Card>
    </main>
  );
}

/**
 * The router's `defaultNotFoundComponent` (wired in main.tsx): any unmatched
 * URL renders this inside the app shell — sidebar and banners intact, one
 * obvious way back. TanStack passes `{ error, router }` props; neither is
 * useful to the user, so both are ignored.
 */
export function NotFoundPage() {
  return (
    <NotFoundCard
      title="Page not found"
      body="This page doesn't exist — the link may be old or mistyped."
      action={<Button render={<Link to="/">Go to subshells</Link>} />}
    />
  );
}

/**
 * The `/subshells/$id` card for a record the server will never return: the
 * backend answers 404 (never 403) for deleted AND not-shared-with-me (spec
 * 2026-08-31 sharing), so the copy covers both without leaking which one.
 */
export function SubshellNotFoundCard() {
  return (
    <NotFoundCard
      title="Subshell not found"
      body="It may have been deleted, or its owner hasn't shared it with you."
      action={<Button variant="outline" render={<Link to="/">Back to subshells</Link>} />}
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/frontend && bun test src/components/__tests__/not-found-page.test.tsx`
Expected: PASS (2 tests). If the heading assertion fails because `CardTitle` is not a heading role, assert via `findByText` as written above — do not change the component to satisfy the test.

- [ ] **Step 5: Wire the router**

Modify `apps/frontend/src/main.tsx` — add the import (with the other top-level imports) and the option:

```tsx
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NotFoundPage } from "@/components/not-found-page";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

const router = createRouter({ routeTree, defaultNotFoundComponent: NotFoundPage });
```

- [ ] **Step 6: Typecheck the wiring**

Run: `cd apps/frontend && bun run verify-types`
Expected: exit 0. (`defaultNotFoundComponent` accepts a zero-prop component.)

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/components/not-found-page.tsx apps/frontend/src/components/__tests__/not-found-page.test.tsx apps/frontend/src/main.tsx
git commit -m "feat(frontend): styled not-found cards, wired as defaultNotFoundComponent"
```

---

### Task 3: Detail route renders the card for a 404 record

**Files:**
- Modify: `apps/frontend/src/hooks/use-subshell-data.ts` (add `error` capture + `isNotFound`)
- Modify: `apps/frontend/src/routes/subshells_.$id.tsx` (early return before the page)

**Interfaces:**
- Consumes: `isNotFoundSubshellError` (Task 1), `SubshellNotFoundCard` (Task 2).
- Produces: `SubshellData.isNotFound: boolean` (new field on the hook's return interface).

- [ ] **Step 1: Extend the hook**

In `apps/frontend/src/hooks/use-subshell-data.ts`:

Add the import (top-level, with the others):

```ts
import { isNotFoundSubshellError } from "@/lib/subshell-not-found";
```

Add to the `SubshellData` interface, after `isError`:

```ts
  /** True when the record's fetch was answered 404: gone or never shared —
   * it will never arrive, so the page shows the not-found card instead of
   * mounting a terminal whose attach is doomed (spec 2026-09-03 §3). */
  isNotFound: boolean;
```

Destructure `error` from the query and derive the flag:

```ts
  const {
    data: subshell,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: [...SUBSHELL_QUERY_KEY, id],
    queryFn: () => apiFetch<SubshellView>(`/api/subshells/${id}`),
  });

  const isNotFound = isNotFoundSubshellError(error);
```

Add `isNotFound` to the returned object (`return { subshell, isLoading, isError, isNotFound, exited, dead };`).

- [ ] **Step 2: Render the card in the route**

In `apps/frontend/src/routes/subshells_.$id.tsx`:

Add the import:

```ts
import { SubshellNotFoundCard } from "@/components/not-found-page";
```

Destructure the new flag (line ~47): `const { subshell, isLoading, isError, isNotFound, exited, dead } = useSubshellData(id);`

Insert the early return directly before `const showPill = ...` (after all hooks — the return must stay below every hook call in the component):

```tsx
  // Gone is gone: 404 means the record will never arrive (deleted, or never
  // shared with this viewer — the backend answers 404 for both), so do NOT
  // mount the terminal: its token POST and WS attach are both doomed and the
  // panel would offer Restart/Delete on a row that doesn't exist. Only while
  // NO record is cached — one deleted mid-view keeps the live pane + dead-
  // panel path below (spec 2026-09-03 §3).
  if (isNotFound && !subshell) return <SubshellNotFoundCard />;
```

- [ ] **Step 3: Verify nothing else consumed the hook's shape**

Run: `cd apps/frontend && grep -rn "useSubshellData" src`
Expected: only `routes/subshells_.$id.tsx` (and the hook file) — the added field is additive, so no other call site can break.

- [ ] **Step 4: Typecheck + test the touched packages**

Run: `cd apps/frontend && bun run verify-types && bun test`
Expected: verify-types exit 0; all frontend tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/hooks/use-subshell-data.ts apps/frontend/src/routes/subshells_\$id.tsx
git commit -m "feat(frontend): show the not-found card for a 404 subshell record"
```

---

### Task 4: Legacy `/sessions/*` redirect routes

**Files:**
- Create: `apps/frontend/src/routes/sessions.tsx`
- Create: `apps/frontend/src/routes/sessions_.$id.tsx`
- Modified by the vite plugin (not by hand): `apps/frontend/src/routeTree.gen.ts`

**Interfaces:**
- Consumes: `redirect` from `@tanstack/react-router`; the existing `/` and `/subshells/$id` routes (their route IDs use the flat-file underscore form only in `createFileRoute`, never in `to:`).
- Produces: registered paths `/sessions` and `/sessions/$id` that always redirect.

- [ ] **Step 1: Create `/sessions` → `/`**

Create `apps/frontend/src/routes/sessions.tsx`:

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy URL (spec 2026-09-02 rename): the subshell list has always lived at
 * "/", so an old bookmark of the old collection path just goes home.
 */
export const Route = createFileRoute("/sessions")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
```

- [ ] **Step 2: Create `/sessions/$id` → `/subshells/$id`**

Create `apps/frontend/src/routes/sessions_.$id.tsx`:

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy deep link (spec 2026-09-02 rename): the UUID survived the rename
 * unchanged, so the same id resolves to the same subshell under its new
 * route. A gone id lands on that route's not-found card — no loop.
 */
export const Route = createFileRoute("/sessions_/$id")({
  beforeLoad: ({ params }: { params: { id: string } }) => {
    throw redirect({ to: "/subshells/$id", params: { id: params.id } });
  },
});
```

Note: the `params` type annotation may be unnecessary if the generated route tree types `beforeLoad` context; if `verify-types` flags it as an error (annotation conflicts with inferred type), drop the annotation and let it infer.

- [ ] **Step 3: Regenerate the route tree**

Run: `cd apps/frontend && bun run build`
Expected: build succeeds; then confirm the tree picked up both routes:
`grep -c "sessions" src/routeTree.gen.ts` → non-zero, with `/sessions` and `/sessions_/$id` appearing.

- [ ] **Step 4: Typecheck + full frontend tests**

Run: `cd apps/frontend && bun run verify-types && bun test`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/routes/sessions.tsx "apps/frontend/src/routes/sessions_.\$id.tsx" apps/frontend/src/routeTree.gen.ts
git commit -m "feat(frontend): redirect legacy /sessions URLs to their post-rename routes"
```

---

### Task 5: Full verification + live check

**Files:** none (verification only; fix-forward if anything fails).

- [ ] **Step 1: Repo-wide trio (from repo root)**

```bash
bun run verify-types
bun run lint:check
bun run test
```

Expected: all three exit 0. On a lint formatting complaint: `bun run lint` then re-check and amend/commit the touched files.

- [ ] **Step 2: Best-effort live check against the dev server**

Start `cd apps/frontend && bun run dev` (backend expected on 127.0.0.1:3080; if it is not running, `systemctl --user status subshell-server.service` — checks that need a signed-in backend may be skipped if unavailable). In a browser (or chrome-devtools MCP):
- `/sessions/<live-subshell-id>` lands on that subshell's page;
- `/nope` renders the "Page not found" card inside the shell;
- `/subshells/00000000-0000-0000-0000-000000000000` renders the "Subshell not found" card.

If the environment can't run the browser check, say so explicitly in the final report — do not claim it passed.

- [ ] **Step 3: Deploy note (host was live when requested)**

The request came from the LIVE host (mote.ein.disaresta.com). Deploying this fix to it is the existing rollout flow (`turbo build` + restart the service, per memory/backend AGENTS) — mention in the final report but treat as optional; the user is away.
