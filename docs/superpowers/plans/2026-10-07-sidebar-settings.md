# Sidebar: Settings group + account card in the header — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nodes/Presets/Prompts move into a personal "Settings" nav group, and the footer's user menu moves into the sidebar header (version folded into the menu, browser rail footerless).

**Architecture:** All work is in `apps/server/web` (React 19 + TanStack Router + Tailwind, tests with bun test + @testing-library/react under happy-dom). `sidebar-nav.ts` owns the nav tree (data only); `UserMenu` stays props-only and gains display fields; `AppSidebar` owns queries and now hosts the card in its header; `__root.tsx` stops supplying the browser footer.

**Spec:** `docs/superpowers/specs/2026-10-07-sidebar-settings-design.md` (sections A–D referenced below).

**Tech Stack:** TypeScript, Bun, biome, Tailwind v4 with shadcn tokens.

## Global Constraints

- Work happens in the worktree at `/home/theo/projects/subshell/.claude/worktrees/sidebar-settings` (branch `worktree-sidebar-settings`, base `origin/main` b57a10c7). All paths below are relative to that root.
- UI copy and prose use **no em dashes** (U+2014; `bun run lint:prose` fails on them). Type roles only: `text-detail`, `font-strong`, etc. - no raw sizes, no hex.
- This repo uses bun only. Test scripts spawn bash: **prefix test runs with `env -u SHELLOPTS`** (an exported `SHELLOPTS=onecmd:posix` makes spawned bash scripts exit silently). `bun test` silently skips nonexistent paths - check the file count in the output.
- Run focused tests from `apps/server/web` with `env -u SHELLOPTS bun test <path>`. Do NOT use `bun run test` for single files (the package script runs the whole suite).
- Focused verification while iterating; at the final boundary run `bun run verify-types`, `bun run lint:check`, `bun run lint:prose`, `bun run test` from the repo root (`.claude/rules/verification.md`). No `packages/` or Rust changes, so no `turbo build` / `rust:check` is required.
- No new dependencies. No dynamic imports.

---

### Task 1: Settings nav group

**Files:**
- Modify: `apps/server/web/src/components/sidebar/sidebar-nav.ts` (the `NAV_ENTRIES` array + lucide import)
- Modify: `apps/server/web/src/components/__tests__/sidebar-nav.test.ts`
- Modify: `apps/server/web/src/components/__tests__/app-sidebar-group.test.tsx`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `NAV_ENTRIES` with a `NavGroup` `{ id: "personal-settings", label: "Settings", children: [Nodes, Presets, Prompts] }` before the `server-settings` group. `visibleNavItems()` flattens to the SAME order as today, so its existing assertions keep passing untouched.

- [ ] **Step 1: Update the failing expectations in `sidebar-nav.test.ts`**

In `apps/server/web/src/components/__tests__/sidebar-nav.test.ts`, replace the `describe("visibleNavEntries", ...)` block's first and last `it` blocks with:

```ts
  it("carries two groups; only the admin one is gated", () => {
    const groups = visibleNavEntries(true).filter(isNavGroup);
    expect(groups.map((g) => [g.id, g.label, g.requiresAdmin])).toEqual([
      ["personal-settings", "Settings", undefined],
      ["server-settings", "Server Settings", true],
    ]);
  });
```

```ts
  it("drops the admin group whole while the flag is false or unknown", () => {
    // The personal Settings group is ungated: it holds pages every signed-in
    // person reaches today (spec 2026-10-07 §A).
    for (const flag of [false, undefined]) {
      expect(visibleNavEntries(flag).filter(isNavGroup).map((g) => g.id)).toEqual(["personal-settings"]);
    }
  });
```

Keep the middle `it("puts the gate on the group and nowhere else")` as-is (it loops all groups). The two `visibleNavItems` tests need NO change: the flattened order is identical, and that is part of what this task pins.

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/server/web && env -u SHELLOPTS bun test src/components/__tests__/sidebar-nav.test.ts
```

Expected: FAIL on "carries two groups" (found only `server-settings`), and FAIL on "drops the admin group" (found `[]`). The two `visibleNavItems` tests still pass.

- [ ] **Step 3: Implement the group in `sidebar-nav.ts`**

In `apps/server/web/src/components/sidebar/sidebar-nav.ts`:

Add `UserRoundCog` to the lucide-react import list, alphabetically between `TerminalSquare` and `Users`. Then replace these three entries:

```ts
  { to: "/nodes", label: "Nodes", icon: Server, short: "Nodes" },
  { to: "/presets", label: "Presets", icon: SlidersHorizontal, short: "Preset" },
  // Beside Presets: both are saved launch material, one is settings, one is text.
  { to: "/prompts", label: "Prompts", icon: MessageSquareText, short: "Prompts" },
```

with:

```ts
  // Personal settings (spec 2026-10-07 §A): the pages this viewer always owns,
  // grouped the way the admin's Server Settings group is. No gate: every
  // signed-in person reaches these pages today, and the group is chrome.
  // UserRoundCog (person-gear) keeps it distinct from General's plain gear
  // and the admin group's ServerCog - the icons test pins global uniqueness.
  {
    id: "personal-settings",
    label: "Settings",
    icon: UserRoundCog,
    children: [
      { to: "/nodes", label: "Nodes", icon: Server, short: "Nodes" },
      { to: "/presets", label: "Presets", icon: SlidersHorizontal, short: "Preset" },
      // Beside Presets: both are saved launch material, one is settings, one is text.
      { to: "/prompts", label: "Prompts", icon: MessageSquareText, short: "Prompts" },
    ],
  },
```

- [ ] **Step 4: Run to verify all pass**

```bash
cd apps/server/web && env -u SHELLOPTS bun test src/components/__tests__/sidebar-nav.test.ts src/components/__tests__/app-sidebar.test.ts
```

Expected: all pass. `app-sidebar.test.ts` (the icons test) matters: it asserts no two visible icons repeat across leaves AND group headers - `UserRoundCog` is new to the rail, so it passes.

- [ ] **Step 5: Add the group's wiring tests to `app-sidebar-group.test.tsx`**

In `renderRail`, the `paths` array becomes (so clicking group children navigates and the detail page resolves):

```ts
  const paths = ["/", "/workspaces", "/nodes", "/nodes/local", "/presets", "/prompts", "/settings"];
```

Append a new describe block after the existing one:

```ts
/**
 * The personal Settings group (spec 2026-10-07 §A): ungated, route-opened,
 * same machinery as the admin group - which is the point of reusing the
 * header-by-name and child-by-aria-controls helpers.
 */
describe("the Settings group", () => {
  // `exact` so the admin's "Server Settings" header cannot answer for it.
  const personalHeader = () => screen.getByRole("button", { name: "Settings", exact: true });
  const personalList = () => {
    const id = personalHeader().getAttribute("aria-controls");
    const el = id ? document.getElementById(id) : null;
    if (!el) throw new Error("the Settings header's aria-controls names no element");
    return el;
  };
  const withPersonal = async (path: string, body: () => Promise<void> | void) => {
    const restoreFetch = stubFetch(false); // NOT an admin: the group is ungated
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
      openLaunch: () => {},
      openNewWorkspace: () => {},
    });
    try {
      renderRail(path);
      await waitFor(() => expect(personalHeader()).toBeTruthy());
      await body();
    } finally {
      spy.mockRestore();
      restoreFetch();
    }
  };

  it("shows for a member and is open on a page inside it", async () => {
    await withPersonal("/nodes", async () => {
      expect(personalHeader().getAttribute("aria-expanded")).toBe("true");
      expect(personalList().className).not.toContain("hidden");
      expect(screen.getByRole("link", { name: "Prompts" })).toBeTruthy();
    });
  });

  it("stays open on a detail page like /nodes/local", async () => {
    await withPersonal("/nodes/local", async () => {
      expect(personalHeader().getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("is shut on a page outside it, and a press opens it", async () => {
    await withPersonal("/", async () => {
      expect(personalHeader().getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(personalHeader());
      await waitFor(() => expect(personalHeader().getAttribute("aria-expanded")).toBe("true"));
    });
  });
});
```

- [ ] **Step 6: Run the group tests**

```bash
cd apps/server/web && env -u SHELLOPTS bun test src/components/__tests__/app-sidebar-group.test.tsx
```

Expected: all pass (the six existing admin-group tests included - their `/Server Settings/` name regex cannot match the new "Settings" header, and the links they query still exist, only one level deeper).

- [ ] **Step 7: Commit**

```bash
git add apps/server/web/src/components/sidebar/sidebar-nav.ts \
  apps/server/web/src/components/__tests__/sidebar-nav.test.ts \
  apps/server/web/src/components/__tests__/app-sidebar-group.test.tsx
git commit -m "feat(web): group nodes presets and prompts under Settings"
```

---

### Task 2: UserMenu gains the version line, update row, and avatar dot

**Files:**
- Modify: `apps/server/web/src/components/user-menu.tsx`
- Modify: `apps/server/web/src/components/__tests__/user-menu.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `UserMenuProps` with four new OPTIONAL props - `serverVersion?: string` (default `""`), `instanceName?: string` (default `""`), `updateNotice?: string | null` (default `null`), `onOpenUpdates?: () => void`. The dropdown opens `side="bottom"`. The existing four callbacks are unchanged, so existing callers and tests compile untouched.

- [ ] **Step 1: Write the failing tests (append to `user-menu.test.tsx`)**

```tsx
/**
 * The header-card additions (spec 2026-10-07 §B): the version row the footer
 * used to carry folds into this menu as a detail line, and its amber marker
 * survives OUTSIDE the menu as a dot on the avatar - a status light a person
 * has to open something to see is no light at all.
 */
describe("UserMenu version + update additions", () => {
  const base = {
    name: "Thea",
    email: "thea@example.com",
    collapsed: false,
    onPreferences: () => {},
    onAccountSettings: () => {},
    onAbout: () => {},
    onSignOut: () => {},
  };
  const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /Thea/ }));

  it("carries the server version and instance name as one detail line", async () => {
    render(<UserMenu {...base} serverVersion="0.11.1" instanceName="Test plane" />);
    openMenu();
    expect(await screen.findByText("Subshell Server 0.11.1 · Test plane")).toBeTruthy();
  });

  it("renders no version line while both reads are pending", async () => {
    render(<UserMenu {...base} />);
    openMenu();
    await screen.findByRole("menuitem", { name: "Sign out" });
    expect(screen.queryByText(/Subshell Server/)).toBeNull();
  });

  it("gives the news a dot on the avatar and a row that leads to Updates", async () => {
    const opens: string[] = [];
    const { container } = render(
      <UserMenu {...base} serverVersion="0.11.1" updateNotice="0.12.0" onOpenUpdates={() => opens.push("u")} />,
    );
    // The dot sits on the trigger, visible before anything opens.
    expect(container.querySelector(".bg-warning")).not.toBeNull();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Update available: v0.12.0" }));
    expect(opens).toEqual(["u"]);
  });

  it("renders no dot and no row without a notice", async () => {
    const { container } = render(<UserMenu {...base} serverVersion="0.11.1" />);
    expect(container.querySelector(".bg-warning")).toBeNull();
    openMenu();
    await screen.findByRole("menuitem", { name: "Sign out" });
    expect(screen.queryByRole("menuitem", { name: /Update available/ })).toBeNull();
  });

  it("shows the version line alone when the instance name never arrives", async () => {
    render(<UserMenu {...base} serverVersion="0.11.1" />);
    openMenu();
    expect(await screen.findByText("Subshell Server 0.11.1")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
cd apps/server/web && env -u SHELLOPTS bun test src/components/__tests__/user-menu.test.tsx
```

Expected: the two original tests pass; the new block fails (unknown props are ignored, so no version line, no row, no dot).

- [ ] **Step 3: Implement in `user-menu.tsx`**

a. Imports: change the lucide line to add `ArrowUpCircle`, swap `ChevronUp` for `ChevronDown`:

```ts
import { ArrowUpCircle, ChevronDown, Info, LogOut, MessageSquare, SlidersHorizontal, UserRound } from "lucide-react";
```

b. `UserMenuProps` - add (each with a JSDoc, matching the file's style):

```ts
  /** The server's version from public settings; "" until the read lands, and
   * the version line renders only when something can fill it. */
  serverVersion?: string;
  /** The instance name from public settings; "" while unresolved. It rides
   * the same line as the version - the rail's old instance-name row folded
   * in here (spec 2026-10-07 §B). */
  instanceName?: string;
  /** The newer server version, when one is published AND the server says this
   * viewer is an admin. null renders neither the avatar dot nor the menu row;
   * the gate lives in the caller, which fetches admin data for admins only. */
  updateNotice?: string | null;
  /** Where the update row leads. Absent renders no row even with a notice. */
  onOpenUpdates?: () => void;
```

c. Destructure with defaults:

```ts
export function UserMenu({
  name,
  email,
  collapsed,
  serverVersion = "",
  instanceName = "",
  updateNotice = null,
  onOpenUpdates,
  onPreferences,
  onAccountSettings,
  onAbout,
  onSignOut,
}: UserMenuProps): JSX.Element {
```

d. Before the return, build the line:

```ts
  // The server fact and the plane's name share one detail line. Either can be
  // pending while the other has landed, so empty parts drop and the joined
  // line never carries a stray separator.
  const versionLine = [serverVersion !== "" ? `Subshell Server ${serverVersion}` : "", instanceName]
    .filter((part) => part !== "")
    .join(" · ");
```

e. The avatar gains `relative` and the dot:

```tsx
  const avatar = (
    <span
      aria-hidden
      className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 font-strong text-detail text-primary"
    >
      {initialsOf(name, email)}
      {/* The version row's marker keeps its status-light life (spec
          2026-10-07 §B): on the face of the trigger, no menu to open, no
          off switch - and collapsed rails included, since the dot is part
          of the avatar. `bg-warning`: the same amber the whole app marks
          "newer exists" with. */}
      {updateNotice !== null && (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warning ring-2 ring-card" />
      )}
    </span>
  );
```

f. Trigger chevron: `{!collapsed && ...}` block swaps `<ChevronUp className=...>` for `<ChevronDown className="h-4 w-4 shrink-0 opacity-50" />` (the menu opens down now).

g. Content: `side="top"` becomes `side="bottom"`; inside the identity `<div>` after the email line add:

```tsx
        {versionLine !== "" && <p className="truncate text-detail text-muted-foreground">{versionLine}</p>}
```

and between the identity `<div>` and the first `<DropdownMenuSeparator />` add:

```tsx
      {updateNotice !== null && onOpenUpdates !== undefined && (
        <DropdownMenuItem onSelect={onOpenUpdates}>
          <ArrowUpCircle className="h-4 w-4 text-warning" /> Update available: v{updateNotice}
        </DropdownMenuItem>
      )}
```

h. Update the file's top JSDoc: the sentence "Props-only: the sidebar owns the queries" stays; add one sentence: the card now sits in the rail header (spec 2026-10-07), and the version/instance line folds in what the browser footer's version row used to say.

- [ ] **Step 4: Run to verify pass**

```bash
cd apps/server/web && env -u SHELLOPTS bun test src/components/__tests__/user-menu.test.tsx
```

Expected: all pass (7 originals + 5 new).

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/components/user-menu.tsx apps/server/web/src/components/__tests__/user-menu.test.tsx
git commit -m "feat(web): user menu gains version line, update row, and avatar dot"
```

---

### Task 3: Account card in the header; footerless browser rail

**Files:**
- Modify: `apps/server/web/src/components/app-sidebar.tsx`
- Modify: `apps/server/web/src/routes/__root.tsx`
- Delete: `apps/server/web/src/components/sidebar/server-version-row.tsx`
- Delete: `apps/server/web/src/components/__tests__/server-version-row.test.tsx`
- Create: `apps/server/web/src/components/__tests__/app-sidebar-account.test.tsx`
- Modify: `apps/server/web/docs/sidebar.md`
- Create: `.changeset/sidebar-account-header.md`

**Interfaces:**
- Consumes: Task 2's `UserMenu` props (`serverVersion`, `instanceName`, `updateNotice`, `onOpenUpdates`); Task 1's group (unrelated code path).
- Produces: `AppSidebar` renders `UserMenu` in the header and renders the bordered footer div ONLY when a `footerEnd` prop was passed. `__root.tsx` renders `<AppSidebar />` with no `footerEnd`.

- [ ] **Step 1: Write the failing component test**

Create `apps/server/web/src/components/__tests__/app-sidebar-account.test.tsx`:

```tsx
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import * as quickAdd from "@/components/quick-add";
import { setFetchRouter } from "@/test-setup";

/**
 * The account card where the footer used to be (spec 2026-10-07 §B/§C).
 * What these pin: the card sits in the header and the browser rail carries no
 * footer at all; the version row's audience split survives the move (member
 * never fetches /api/admin/updates, no dot; admin with news gets dot + row +
 * door); desktop shells keep their footer rows. The /Account:/ trigger name is
 * deliberately unchanged - the e2e specs sign out through it.
 */

function stubFetch(opts: { admin: boolean; updateTo?: string }) {
  const calls: string[] = [];
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const path = new URL(url, "http://localhost").pathname;
    calls.push(path);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/api/settings/public") {
      return json({ viewerIsAdmin: opts.admin, instanceName: "Test plane", serverVersion: "0.11.1" });
    }
    if (path === "/api/admin/updates") {
      const to = opts.updateTo ?? null;
      return json({
        server: {
          current: "0.11.1",
          updateAvailable: to !== null,
          latest: to === null ? null : { version: to, tag: `cli-server-v${to}` },
        },
      });
    }
    if (url.includes("get-session")) {
      return json({ user: { id: "u1", name: "Admin", email: "admin@test" } });
    }
    return json([]);
  });
  return calls;
}

function renderRail(initialPath: string, footerEnd?: () => ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => <AppSidebar footerEnd={footerEnd} />,
  });
  const paths = [
    "/",
    "/workspaces",
    "/nodes",
    "/presets",
    "/prompts",
    "/preferences",
    "/account",
    "/settings",
    "/settings/users",
    "/settings/auth",
    "/settings/api-keys",
    "/settings/plugins",
    "/settings/service",
    "/settings/networking",
    "/settings/updates",
    "/settings/backups",
    "/settings/status",
    "/settings/logs",
  ];
  const children = paths.map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const accountTrigger = () => screen.getByRole("button", { name: /Account: Admin/ });

afterEach(() => {
  cleanup();
  localStorage.removeItem("subshell.sidebarCollapsed");
  setFetchRouter(null);
});

describe("the header account card", () => {
  const withRail = async (
    opts: { admin: boolean; updateTo?: string; footer?: boolean },
    body: () => Promise<void> | void,
  ) => {
    const calls = stubFetch(opts);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
      openLaunch: () => {},
      openNewWorkspace: () => {},
    });
    try {
      const router = renderRail("/", opts.footer ? () => <span data-testid="plane-row" /> : undefined);
      await waitFor(() => expect(accountTrigger()).toBeTruthy());
      await body();
      return { calls, router };
    } finally {
      spy.mockRestore();
    }
  };

  it("sits under the wordmark and leaves the browser rail footerless", async () => {
    await withRail({ admin: false }, async () => {
      expect(accountTrigger()).toBeTruthy();
      // The bordered footer div was a direct child of the aside with
      // `border-t`; nothing supplies footerEnd on the web, so none exists.
      expect(container.querySelector("aside > div.border-t")).toBeNull();
      // Sign out still reaches anyone, everywhere.
      fireEvent.click(accountTrigger());
      fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    });
  });

  it("gives a member the version line and never fires the admin updates read", async () => {
    const run = await withRail({ admin: false }, async () => {
      fireEvent.click(accountTrigger());
      expect(await screen.findByText("Subshell Server 0.11.1 · Test plane")).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: /Update available/ })).toBeNull();
    });
    expect(run?.calls).not.toContain("/api/admin/updates");
    expect(accountTrigger().querySelector(".bg-warning")).toBeNull();
  });

  it("gives an admin with news the avatar dot and a row that walks to /settings/updates", async () => {
    const run = await withRail({ admin: true, updateTo: "0.12.0" }, async () => {
      await waitFor(() => expect(accountTrigger().querySelector(".bg-warning")).not.toBeNull());
      fireEvent.click(accountTrigger());
      fireEvent.click(await screen.findByRole("menuitem", { name: "Update available: v0.12.0" }));
    });
    await waitFor(() => expect(run?.router.state.location.pathname).toBe("/settings/updates"));
  });

  it("gives an admin with nothing published neither dot nor row, still no door", async () => {
    const run = await withRail({ admin: true }, async () => {
      // The retired footer was a door even with no news; §B moved that door
      // to the Server Settings group's Updates page, so the card stays quiet.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(accountTrigger().querySelector(".bg-warning")).toBeNull();
      fireEvent.click(accountTrigger());
      await screen.findByRole("menuitem", { name: "Sign out" });
      expect(screen.queryByRole("menuitem", { name: /Update available/ })).toBeNull();
    });
    expect(run?.calls).toContain("/api/admin/updates");
  });

  it("keeps the desktop shell's footer rows", async () => {
    await withRail({ admin: true, footer: true }, async () => {
      expect(screen.getByTestId("plane-row")).toBeTruthy();
      // The card moved up; it is not stacked back into the footer.
      const footer = document.querySelector("aside > div.border-t");
      expect(footer?.querySelector("button")).toBeNull();
    });
  });

  it("collapses to the avatar alone", async () => {
    localStorage.setItem("subshell.sidebarCollapsed", "1");
    await withRail({ admin: false }, async () => {
      expect(accountTrigger()).toBeTruthy();
      // No display-name text on the face of the collapsed rail.
      expect(screen.queryByText("Admin")).toBeNull();
    });
  });
});
```

(The file needs `import type { ReactNode } from "react";` if the `React.ReactNode` reference fails type checking - biome/tsc runs will say; use `ReactNode` then.)

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/server/web && env -u SHELLOPTS bun test src/components/__tests__/app-sidebar-account.test.tsx
```

Expected: FAIL - the trigger currently lives in the footer under a `div.border-t` (first and desktop tests fail their footer assertions; the footerless assertion is the one that cannot pass before the change).

- [ ] **Step 3: Move the card in `app-sidebar.tsx`**

a. Add the import beside the other hooks:

```ts
import { useUpdates } from "@/hooks/use-updates";
```

b. After the `publicSettings` line, add (and update the `user` query comment: "(footer)" becomes "(header)"):

```ts
  // Admin-gated server-update read (spec 2026-10-07 §B): the one the deleted
  // ServerVersionRow held. `=== true`, never truthiness: `undefined` is the
  // read in flight, and counting it as admin fires a doomed 403. The header
  // card is this query's only consumer, so the one-request-per-page-load
  // property survives the row's deletion.
  const isAdmin = publicSettings?.viewerIsAdmin === true;
  const { data: updates } = useUpdates(isAdmin);
  const serverUpdate = updates?.server;
  const updateNotice = serverUpdate?.updateAvailable === true ? (serverUpdate.latest?.version ?? null) : null;
```

c. Replace the instance-name block and collapsed spacer:

```tsx
      {/* Which plane am I looking at? Only when expanded — the collapsed rail
          has no room for text, and the wordmark alone is the brand, not the
          instance. Server-resolved, so it is never blank. */}
      {!collapsed && publicSettings?.instanceName && (
        <p className="truncate px-3 pb-3 text-detail text-muted-foreground" title={publicSettings.instanceName}>
          {publicSettings.instanceName}
        </p>
      )}
      {collapsed && <div className="pb-3" />}
```

with the account card:

```tsx
      {/* The account card (spec 2026-10-07 §B): the footer's user menu moved
          up into the slot the instance-name line used. Which plane this is
          and what it runs now ride the menu's version line; an admin with a
          newer server gets the dot on the avatar. Collapsed: the avatar
          alone, centered under the mark that expands the rail. */}
      <div className={collapsed ? "flex px-2 pb-2 justify-center" : "px-2 pb-2"}>
        <UserMenu
          name={user?.name ?? ""}
          email={user?.email ?? ""}
          collapsed={collapsed}
          serverVersion={publicSettings?.serverVersion ?? ""}
          instanceName={publicSettings?.instanceName ?? ""}
          updateNotice={updateNotice}
          onOpenUpdates={isAdmin ? () => void navigate({ to: "/settings/updates" }) : undefined}
          onPreferences={() => void navigate({ to: "/preferences" })}
          onAccountSettings={() => void navigate({ to: "/account" })}
          onAbout={() => setAboutOpen(true)}
          onSignOut={() => void signOutAndRedirect()}
        />
      </div>
```

d. Replace the footer:

```tsx
      <div className="border-border border-t p-2">
        {footerEnd?.({ collapsed })}
        <UserMenu ... />
        <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
        <MobileInstallDialog open={mobileOpen} onOpenChange={setMobileOpen} />
      </div>
```

with:

```tsx
      {/* The footer exists only for shells that supply rows (spec 2026-10-07
          §C): the desktop server pill and app-update line. A browser passes
          no footerEnd and gets no bordered block at all. */}
      {footerEnd && <div className="border-border border-t p-2">{footerEnd({ collapsed })}</div>}
      {/* Both dialogs mount at the rail root: choosing the menu item closes
          the menu, and a dialog mounted in a closing menu goes with it. */}
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <MobileInstallDialog open={mobileOpen} onOpenChange={setMobileOpen} />
```

e. Update the `footerEnd` prop JSDoc: drop "Rendered above the user menu" - it now reads "Rendered as the footer's whole content (desktop server pill + app-update line); when absent, the footer div does not render. The account card left the footer for the header on spec 2026-10-07; the collapsed-width argument for the render-prop stands unchanged."

- [ ] **Step 4: Unwire the browser footer in `__root.tsx`**

In `apps/server/web/src/routes/__root.tsx`:
- Delete the import `import { ServerVersionRow } from "@/components/sidebar/server-version-row";` (line ~19).
- Delete the `browserFooter` comment block (the "The browser rail's footer carries the SERVER's version..." paragraph) and the `browserFooter` `useCallback` (lines ~113-124).
- `import { useCallback, useMemo } from "react";` becomes `import { useMemo } from "react";` (useCallback has no other use - grep to confirm before removing).
- The mount line: `{hasSidebar && !bare && (desktop ? <DesktopSidebar /> : <AppSidebar footerEnd={browserFooter} />)}` becomes `{hasSidebar && !bare && (desktop ? <DesktopSidebar /> : <AppSidebar />)}` - keep it on ONE line (`root-frame-guards.test.ts` requires the session check on the mounting line).
- The adjacent comment naming `browserFooter` ("so this stays one line and `browserFooter` is hoisted above rather than inlined") becomes "so this stays one line."

- [ ] **Step 5: Delete the retired row and run everything**

```bash
git rm apps/server/web/src/components/sidebar/server-version-row.tsx \
  apps/server/web/src/components/__tests__/server-version-row.test.tsx
cd apps/server/web && env -u SHELLOPTS bun test src/components/__tests__/app-sidebar-account.test.tsx \
  src/components/__tests__/app-sidebar-group.test.tsx src/components/__tests__/user-menu.test.tsx \
  src/components/__tests__/sidebar-nav.test.ts src/components/__tests__/app-sidebar.test.ts \
  src/components/__tests__/app-sidebar-node-groups.test.tsx src/routes/__tests__/root-frame-guards.test.ts
```

Expected: all pass; check the file count is 7. (`VersionRow` itself is KEPT - `desktop-app-update-row.tsx` still renders the desktop line.)

- [ ] **Step 6: Docs + changeset**

Append to `apps/server/web/docs/sidebar.md` (voice: no em dashes, sentences, dated):

```markdown
**Two groups sit under the pages** (spec 2026-10-07): Nodes, Presets and
Prompts live in a personal `Settings` group beside the admin-only `Server
Settings` group. The grouping is chrome; routes and access rules did not
move. The account card that used to sit in the rail's footer moved into the
header, into the slot the instance-name line used: the browser rail renders
no footer at all, and the server version plus instance name ride the menu's
detail line. An admin with a newer server published gets an amber dot on the
avatar and an "Update available" row leading to `/settings/updates`. The
desktop shells keep their footer rows (server pill, app-update line),
because those describe the app bundle rather than an account.
```

Create `.changeset/sidebar-account-header.md`:

```markdown
---
"@internal/server": patch
"@internal/desktop-server": patch
---

Move Nodes, Presets, and Prompts into a Settings navigation group, and move the account menu from the sidebar footer into the header: the browser rail carries no footer card anymore, the server version and instance name ride the account menu's detail line, and an admin with a newer server published gets an amber dot on the avatar plus an Update available row.
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): put the account card in the sidebar header, drop the browser footer"
```

---

### Task 4: Full verification boundary

**Files:** none new - fix whatever the boundary surfaces.

- [ ] **Step 1: Repo-root static checks + full test suite**

```bash
cd /home/theo/projects/subshell/.claude/worktrees/sidebar-settings
env -u SHELLOPTS bun run verify-types
env -u SHELLOPTS bun run lint:check
env -u SHELLOPTS bun run lint:prose
env -u SHELLOPTS bun run test
```

Expected: all green. A failure that names `apps/server/web` gets fixed now (add the test-first for behavior fixes); anything pre-existing is reported, not silently patched.

- [ ] **Step 2: Confirm the retired strings are gone**

```bash
grep -rn "ServerVersionRow\|browserFooter" apps/server/web/src || echo CLEAN
```

Expected: `CLEAN`.

- [ ] **Step 3: Commit any fixes** (only if Step 1 required changes): `git add -A && git commit -m "fix(web): sidebar header account card review fixes"`

## Self-review notes (already checked against the spec)

- Spec §A → Task 1; §B → Task 2 (component) + Task 3 (wiring); §C → Task 3; §Files/Tests/Docs → Tasks 1-3; verification.md boundary → Task 4.
- Admin-with-no-news loses the old always-a-door row: spec §B moves that affordance to the Server Settings group's Updates page; the task test names this so a reviewer can object consciously.
- The `/Account:` accessible name and all menu-item names are unchanged, so the e2e specs (`01-setup-wizard`, `08-mobile-shell`, `10-auth-experience`, `16-server-service`, `19-oidc-signin` - all reach the account through `getByRole("button", { name: /Account:/ })`) keep working without edits; e2e runs in CI, not here.
