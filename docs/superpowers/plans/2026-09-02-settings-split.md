# Settings Split (Account vs Server) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`[ ]`) syntax for tracking.

**Goal:** Split the mixed Settings page into a user `/account` page (profile, notifications, terminal font, passkeys, password) and an admin-only `/settings` "Server" page (registration, system API keys, local launching), and replace the sidebar Logout button with a signed-in user menu (Account settings + Sign out).

**Architecture:** One additive backend field (`viewerIsAdmin` on `GET /api/settings/public`, derived by the existing `isAdmin` helper — the app already fetches this endpoint via `usePublicSettings`); the sidebar filters admin nav items from it. All frontend moves are component-level: cards move routes unchanged; two new small components (`user-menu.tsx`, `profile-card.tsx`) plus one extraction (`change-password-card.tsx`).

**Tech Stack:** Elysia `t` schemas + bun:test (backend); React 19, TanStack Router file routes (tracked `routeTree.gen.ts` — regenerate via `bun run build`), Base UI Menu via the existing `ui/dropdown-menu.tsx` wrapper, better-auth client (`authClient.updateUser`, `authClient.changePassword`), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-09-02-settings-split-design.md`

## Global Constraints

- Bun only; `bun test` (never vitest). No dynamic imports. No new dependencies.
- All Elysia `t` schema properties carry a `description`.
- Bearer tokens must never gain admin visibility: `viewerIsAdmin` is `true` ONLY for `actor === "cookie"` sessions.
- e2e contracts this branch changes deliberately: the sidebar label "Settings" becomes "Server" (spec 08 clicks it by name — update it IN the e2e task, same branch).
- Card components move by import-site only; their internals stay byte-identical except doc-comment wording ("Settings page" → "Account page").
- Final gate (Task 7): `bun run verify-types`, `bun run lint:check`, `bun run test`, `bunx turbo build`, e2e `08-mobile-shell` + `01-setup-wizard` + `12-nodes`.

---

### Task 1: Backend — `viewerIsAdmin` on `GET /api/settings/public`

**Files:**
- Modify: `apps/backend/src/api/settings.route.ts` (PublicSettingsSchema + `/public` handler)
- Test: `apps/backend/src/api/__tests__/settings-route.test.ts`

**Interfaces:**
- Consumes: `isAdmin(user)` from `@/api/user-utils.js` (already imported in this file); the file's existing `adminCookie` / `nonAdminCookie` fixtures.
- Produces: `GET /api/settings/public → { allowRegistrations, emergencyLoginActive, appBaseUrl, viewerIsAdmin: boolean }`; `viewerIsAdmin` true only when `actor === "cookie" && await isAdmin(user)`.

- [ ] **Step 1: Write the failing tests** — append to the existing `describe` (fixtures `adminCookie`, `nonAdminCookie`, `app`, `authedRequest`, `bearerRequest` all exist in the file):

```ts
  /**
   * `viewerIsAdmin` (spec 2026-09-02 settings-split §5): the ONE client-side
   * admin signal for the Server nav entry. Cookie humans get the truth;
   * bearer actors (whose synthetic user is the session OWNER — possibly an
   * admin) must read false: a machine token must not paint admin chrome.
   */
  it("GET /public reports viewerIsAdmin per actor+role", async () => {
    const admin = (await (await app.fetch(authedRequest("/api/settings/public", adminCookie))).json()) as {
      viewerIsAdmin: boolean;
    };
    expect(admin.viewerIsAdmin).toBe(true);

    const user = (await (await app.fetch(authedRequest("/api/settings/public", nonAdminCookie))).json()) as {
      viewerIsAdmin: boolean;
    };
    expect(user.viewerIsAdmin).toBe(false);

    const bearer = await app.fetch(bearerRequest("/api/settings/public", adminSessionKey));
    expect(bearer.status).toBe(200);
    expect(((await bearer.json()) as { viewerIsAdmin: boolean }).viewerIsAdmin).toBe(false);
  });
```

Also read the existing test "public GET stays as-is (no admin/cookie gate added)" (~line 177): if it asserts an exact object shape (`toEqual`), add `viewerIsAdmin: false`/`true` per its fixture — if it checks keys individually, leave it. State which in the report.

- [ ] **Step 2: Run to verify they fail** — `cd apps/backend && bun test src/api/__tests__/settings-route.test.ts` (expect `viewerIsAdmin` undefined).

- [ ] **Step 3: Implement** — extend the schema (property JSDoc-style description required):

```ts
  viewerIsAdmin: t.Boolean({
    description:
      "True when the caller is a signed-in admin via COOKIE session (drives the Server nav entry); bearer actors always read false",
  }),
```

and the handler — change `async () =>` to take the guard's context and compute:

```ts
    async ({ user, actor }) => {
      const repo = new SettingsRepository(db);
      const allow = await repo.get("allow_registrations", true);
      return {
        allowRegistrations: allow,
        emergencyLoginActive: emergencyLoginArmed(),
        appBaseUrl: APP_BASE_URL,
        // Cookie-only on purpose: the guard's bearer `user` is the session
        // OWNER, so isAdmin alone would let an admin-owned token flip admin
        // chrome (same reasoning as GET / below).
        viewerIsAdmin: actor === "cookie" && (await isAdmin(user)),
      } as const;
    },
```

Extend the route's `detail.description` to mention the new field.

- [ ] **Step 4: Run to verify pass** — same command, all green.

- [ ] **Step 5: Commit** — `git commit -m "feat(backend): viewerIsAdmin on public settings — the client's admin-nav signal"`

---

### Task 2: Frontend — public-settings field + admin-filtered nav

**Files:**
- Modify: `apps/frontend/src/hooks/use-public-settings.ts`
- Modify: `apps/frontend/src/components/app-sidebar.tsx` (NAV_ITEMS + filter only — the user menu is Task 3)
- Test: Create `apps/frontend/src/components/__tests__/sidebar-nav.test.ts` (pure-function test)

**Interfaces:**
- Consumes: Task 1's `viewerIsAdmin`.
- Produces: `PublicSettings.viewerIsAdmin: boolean`; exported pure `visibleNavItems(isAdmin: boolean | undefined): readonly NavItem[]`; the `/settings` nav entry is `{ to: "/settings", label: "Server", icon: Settings, requiresAdmin: true }` (no `short` — the tooltip would read "Server (Server)").

- [ ] **Step 1: Failing test** — create `sidebar-nav.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { visibleNavItems } from "@/components/app-sidebar";

/**
 * The admin nav gate (spec 2026-09-02 settings-split §4): "Server" shows for
 * admins only, and UNKNOWN (loading) is hidden — the "unknown ≠ open" posture
 * the registration switch set. Everything else is unconditional.
 */
describe("visibleNavItems", () => {
  it("hides the Server entry while the flag is false or unknown", () => {
    for (const flag of [false, undefined]) {
      const items = visibleNavItems(flag);
      expect(items.some((i) => i.to === "/settings")).toBe(false);
      expect(items.some((i) => i.to === "/users")).toBe(true);
    }
  });
  it("shows the Server entry for admins, labeled Server", () => {
    const items = visibleNavItems(true);
    expect(items.find((i) => i.to === "/settings")?.label).toBe("Server");
  });
});
```

- [ ] **Step 2:** `cd apps/frontend && bun test src/components/__tests__/sidebar-nav.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement.**

`use-public-settings.ts` — add to the interface:

```ts
  /**
   * True for admin COOKIE sessions (spec 2026-09-02 settings-split §5) —
   * gates the Server nav entry and the /settings page body. Bearer actors
   * always read false.
   */
  viewerIsAdmin: boolean;
```

`app-sidebar.tsx` — `NavItem` gains `requiresAdmin?: boolean`; the `/settings` line becomes `{ to: "/settings", label: "Server", icon: Settings, requiresAdmin: true }`; add:

```ts
/**
 * The nav items a viewer may see (spec 2026-09-02 settings-split §4):
 * admin-only entries hide unless the server says so — and while the flag is
 * still unknown (first fetch) they stay hidden (unknown ≠ open). Pure so the
 * rule is testable without a router.
 */
export function visibleNavItems(isAdmin: boolean | undefined): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => !item.requiresAdmin || isAdmin === true);
}
```

In `AppSidebar`: `const { data: publicSettings } = usePublicSettings();` (import the hook) and render `visibleNavItems(publicSettings?.viewerIsAdmin).map(...)`.

- [ ] **Step 4:** focused test GREEN + `bun run verify-types` clean.
- [ ] **Step 5:** `git commit -m "feat(frontend): admin-filtered Server nav entry off public-settings viewerIsAdmin"`

---

### Task 3: Frontend — user menu replaces the Logout button

**Files:**
- Create: `apps/frontend/src/components/user-menu.tsx`
- Create: `apps/frontend/src/components/__tests__/user-menu.test.tsx`
- Modify: `apps/frontend/src/components/app-sidebar.tsx` (footer block only)

**Interfaces:**
- Consumes: `ui/dropdown-menu.tsx` (`DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator` — all exist), `useCurrentUser`, the sidebar's existing `signOut()`.
- Produces: `UserMenu` with a PROPS-ONLY contract (no data fetching inside — the sidebar owns queries): `{ name: string; email: string; collapsed: boolean; onAccountSettings: () => void; onSignOut: () => void }`. Exported pure `initialsOf(name: string, email: string): string`.

- [ ] **Step 1: Failing test** — create `user-menu.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialsOf, UserMenu } from "@/components/user-menu";

/**
 * The signed-in user menu replacing the bare Logout button (spec 2026-09-02
 * settings-split §3). Props-only contract — queries live in the sidebar.
 * Base UI popups render under happy-dom (proven by combobox.test.tsx).
 */
afterEach(cleanup);

describe("initialsOf", () => {
  it("takes the name's first letter, falling back to the email, uppercased", () => {
    expect(initialsOf("Thea", "t@example.com")).toBe("T");
    expect(initialsOf("  ", "theo@x.io")).toBe("T");
    expect(initialsOf("", "")).toBe("?");
  });
});

describe("UserMenu", () => {
  it("shows the user and offers Account settings + Sign out", async () => {
    const account: string[] = [];
    const signed: string[] = [];
    render(
      <UserMenu name="Thea" email="thea@example.com" collapsed={false} onAccountSettings={() => account.push("a")} onSignOut={() => signed.push("s")} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Thea|thea@example.com/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Account settings" }));
    expect(account).toEqual(["a"]);
    // Choosing an item closes the menu; reopen for the second action.
    fireEvent.click(screen.getByRole("button", { name: /Thea|thea@example.com/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(signed).toEqual(["s"]);
  });
});
```

(If Base UI Menu items expose `role="menuitem"` differently under happy-dom, inspect the rendered DOM in a scratch run and adapt the role — do NOT delete the assertions.)

- [ ] **Step 2:** focused run → FAIL (module missing).

- [ ] **Step 3: Implement `user-menu.tsx`:**

```tsx
import { ChevronUp, LogOut, UserRound } from "lucide-react";
import type { JSX } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The signed-in user menu (spec 2026-09-02 settings-split §3) — replaces the
 * bare Logout button: identity on the trigger, Account settings + Sign out in
 * the menu. Props-only: the sidebar owns the queries and what the actions
 * mean. Collapsed rails get an initials avatar; expanded rails get the full
 * identity row.
 */

/** One-letter avatar: name initial, else email initial, "?" while neither. */
export function initialsOf(name: string, email: string): string {
  const c = name.trim()[0] ?? email.trim()[0];
  return c ? c.toUpperCase() : "?";
}

export interface UserMenuProps {
  name: string;
  email: string;
  /** Icon-only trigger for the collapsed rail */
  collapsed: boolean;
  onAccountSettings: () => void;
  onSignOut: () => void;
}

export function UserMenu({ name, email, collapsed, onAccountSettings, onSignOut }: UserMenuProps): JSX.Element {
  const display = name.trim() || email;
  const avatar = (
    <span
      aria-hidden
      className="bg-primary/15 text-primary flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
    >
      {initialsOf(name, email)}
    </span>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Account — ${display}`}
            title={collapsed ? `Account — ${display}` : undefined}
            className={cn(
              "text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center rounded-md text-sm transition-colors",
              collapsed ? "justify-center p-2" : "w-full gap-2 justify-start p-2",
            )}
          />
        }
      >
        {avatar}
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-left">{display}</span>
            <ChevronUp className="h-4 w-4 shrink-0 opacity-50" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium">{name.trim() || "(no name)"}</p>
          <p className="text-muted-foreground truncate text-xs">{email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onAccountSettings}>
          <UserRound className="mr-2 h-4 w-4" /> Account settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Adapt to the actual wrapper exports if `render`/`variant`/`side` props differ (read `ui/dropdown-menu.tsx` first; the Base UI Menu root/part semantics are the authority).

- [ ] **Step 4: Wire into the sidebar** — replace the footer `<div className="border-border border-t p-2">…Logout…</div>` block with:

```tsx
      <div className="border-border border-t p-2">
        <UserMenu
          name={user?.name ?? ""}
          email={user?.email ?? "Signed in"}
          collapsed={collapsed}
          onAccountSettings={() => void navigate({ to: "/account" })}
          onSignOut={() => void signOut()}
        />
      </div>
```

with `const { data: user } = useCurrentUser();`, `const navigate = useNavigate();` (import `useNavigate` from `@tanstack/react-router`), the `UserMenu` import, and the `LogOut` icon import dropped from the sidebar (it now lives in user-menu). Note `/account` does not exist until Task 4 — if `verify-types` rejects the `to: "/account"` literal BEFORE Task 4 lands, keep this wiring step and run it AFTER Task 4 instead (Task 4 regenerates `routeTree.gen.ts`); do not cast.

- [ ] **Step 5:** focused test GREEN, `bun test src` 0 failures (other files may not import what you moved — grep first), `bun run verify-types` clean.
- [ ] **Step 6:** `git commit -m "feat(frontend): sidebar user menu (identity + Account settings + Sign out) replaces the Logout button"`

---

### Task 4: Frontend — `/account` route + profile card + change-password extraction

**Files:**
- Create: `apps/frontend/src/routes/account.tsx`
- Create: `apps/frontend/src/components/change-password-card.tsx`
- Create: `apps/frontend/src/components/profile-card.tsx`
- Create: `apps/frontend/src/components/__tests__/profile-card.test.tsx`
- Modify: `apps/frontend/src/routeTree.gen.ts` (generated — regenerate, commit)

**Interfaces:**
- Consumes: `NotificationsMasterCard`, `TerminalFontCard`, `NotificationsCard`, `PasskeysCard` (existing), `authClient.updateUser({ name })`, `useCurrentUser`.
- Produces: route `/account` (title "Account"); `ChangePasswordCard` (no props — the inline block moves); `ProfileCard` (no props).

- [ ] **Step 1: Failing test for the card logic** — `profile-card.test.tsx`:

```tsx
import { describe, expect, it } from "bun:test";
import { nameIsUsable } from "@/components/profile-card";

/** The Profile card's only rule (spec 2026-09-02 settings-split §1.1): the
 * display name saves trimmed and must not be blank; email is read-only.
 * The better-auth call itself is the client's — mocked in the component test
 * tradition of this suite, so only the rule is pinned here. */
describe("nameIsUsable", () => {
  it("accepts anything non-blank and saves it trimmed", () => {
    expect(nameIsUsable("Thea")).toBe("Thea");
    expect(nameIsUsable("  Thea G  ")).toBe("Thea G");
    expect(nameIsUsable("   ")).toBeNull();
    expect(nameIsUsable("")).toBeNull();
  });
});
```

- [ ] **Step 2:** focused run → FAIL (module missing).
- [ ] **Step 3: Implement `profile-card.tsx`:** `export function nameIsUsable(raw: string): string | null { const t = raw.trim(); return t === "" ? null : t; }` plus a Card titled "Profile": rows for Name (editable input prefilled from `useCurrentUser`, Save button disabled while blank or pending) and Email (read-only, muted); Save calls `authClient.updateUser({ name })`, on success invalidates the `["current-user"]` query (via `useQueryClient`) and shows "saved"; on error shows the message in the file-idiom (`text-destructive text-sm`). Follow the Registration card's unknown≠open comment posture for the prefill (show fields only once the user query resolves).

- [ ] **Step 4: Implement `change-password-card.tsx`:** move the ENTIRE inline block from `settings.tsx` — the six `useState`s, `changePassword()`, and the `<Card>…Change password…</Card>` JSX — verbatim into a `export function ChangePasswordCard(): JSX.Element` (delete nothing but formatting; keep every comment). Do NOT remove it from settings.tsx yet (Task 5 does the page surgery atomically).

- [ ] **Step 5: Create `routes/account.tsx`:**

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { ChangePasswordCard } from "@/components/change-password-card";
import { NotificationsCard } from "@/components/notifications-card";
import { NotificationsMasterCard } from "@/components/notifications-master-card";
import { PageHeader } from "@/components/page-header";
import { PasskeysCard } from "@/components/passkeys-card";
import { ProfileCard } from "@/components/profile-card";
import { TerminalFontCard } from "@/components/terminal-font-card";

export const Route = createFileRoute("/account")({ component: AccountPage });

/**
 * Everything that configures THIS user and their devices (spec 2026-09-02
 * settings-split §1) — reached from the sidebar user menu, not the nav rail.
 * Instance-wide concerns live on /settings ("Server").
 */
function AccountPage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="Account" subtitle="Your profile, devices and credentials" />
      <ProfileCard />
      {/* Account-wide switch first: it gates every device, so it reads as the
          parent of the per-device opt-in below it. */}
      <NotificationsMasterCard />
      <TerminalFontCard />
      <NotificationsCard />
      {/* Self-service for ANY signed-in user (own passkeys only via the session). */}
      <PasskeysCard />
      <ChangePasswordCard />
    </main>
  );
}
```

- [ ] **Step 6: Regenerate the route tree** — `cd apps/frontend && bun run build` (the router plugin rewrites `routeTree.gen.ts`; commit it). Then focused tests GREEN + `bun test src` 0 failures + `bun run verify-types` clean.

- [ ] **Step 7:** `git commit -m "feat(frontend): /account page — profile card, moved notifications/font/passkeys/password surface"` (includes routeTree.gen.ts).

---

### Task 5: Frontend — `/settings` becomes Server-only

**Files:**
- Modify: `apps/frontend/src/routes/settings.tsx`

**Interfaces:**
- Consumes: `usePublicSettings().data?.viewerIsAdmin`, `Link` from `@tanstack/react-router`, the route `/account` (Task 4).
- Produces: the page renders admin cards ONLY when `viewerIsAdmin === true`; a guidance notice otherwise.

- [ ] **Step 1: Page surgery** — settings.tsx becomes: keep the Registration card (query + toggle + JSX), `SystemApiKeysCard`, `LocalLaunchCard`; DELETE: the change-password state/handler/JSX (now `ChangePasswordCard`, moved out entirely), the `NotificationsMasterCard`/`TerminalFontCard`/`NotificationsCard`/`PasskeysCard` imports+usage, and their now-orphaned imports (`Input` etc. only if unused — verify-types proves it). Header: `<PageHeader title="Server" subtitle="Instance-wide configuration (admins)" />`.

- [ ] **Step 2: Non-admin body** — wrap the admin content on the flag:

```tsx
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="Server" subtitle="Instance-wide configuration (admins)" />
      {viewerIsAdmin === undefined ? null : viewerIsAdmin ? (
        <>
          {/* …Registration card, SystemApiKeysCard, LocalLaunchCard… */}
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Server settings are for instance admins — your settings live under{" "}
          <Link to="/account" className="underline">
            Account settings
          </Link>
          .
        </p>
      )}
    </main>
  );
```

The gating here mirrors the nav rule: cards fetch admin-cookie endpoints, so rendering them for a non-admin only produces error banners — and server-side gates stay the actual enforcement regardless.

- [ ] **Step 3: Verify** — `cd apps/frontend && bun run verify-types && bun test src` (0 failures; e2e files not run here). Update any stale doc-comment in settings.tsx that described the old mixed page.
- [ ] **Step 4:** `git commit -m "feat(frontend)!: /settings becomes the admin-only Server page — account cards moved to /account"`

---

### Task 6: Frontend — copy retargeting

**Files:**
- Modify: `apps/frontend/src/components/emergency-login-banner.tsx`
- Modify: `apps/frontend/src/components/notifications-master-card.tsx`, `notifications-card.tsx`, `terminal-font-card.tsx`, `passkeys-card.tsx` (doc comments only, if they name the Settings page)

- [ ] **Step 1:** banner message: "(Settings → Change password)" → "(Account → Change password)".
- [ ] **Step 2:** `grep -n 'Settings page\|settings page' apps/frontend/src/components/*.tsx` — rewrite doc-comment occurrences that now point at `/account` (keep genuine references to `/settings` semantics, e.g. LocalLaunchCard's).
- [ ] **Step 3:** `bunx biome check` on touched files; `bun test src/components/__tests__/` 0 failures (banner test, if any, asserts message text — update it in the same commit if so).
- [ ] **Step 4:** `git commit -m "docs(frontend): retarget Settings references to Account after the split"`

---

### Task 7: e2e updates + full verification

**Files:**
- Modify: `e2e/tests/08-mobile-shell.spec.ts`

- [ ] **Step 1:** In the shell-chrome test (~line 28): `page.getByRole("link", { name: "Settings" })` → `{ name: "Server" }`; the URL assertion `/\/settings$/` stays (admin drawer, admin label now reads Server). Add after it (phone branch):

```ts
    // The user menu (spec 2026-09-02 settings-split §3) replaces Logout in
    // the drawer: Account settings must reach /account.
    await page.getByRole("button", { name: /Account —/ }).click();
    await page.getByRole("menuitem", { name: "Account settings" }).click();
    await expect(page).toHaveURL(/\/account$/);
```

(The drawer may dismiss on the previous navigation — reopen via the burger if needed; mirror the existing drawer flow's shape.)
- [ ] **Step 2:** Run: `cd e2e && bunx playwright test 08-mobile-shell 01-setup-wizard 12-nodes` → PASS (01/12 re-check the public-settings consumers; 12 asserts specific `/api/settings/public` keys — additive field, should pass unchanged; if it strict-equals the whole body, update it and say so).
- [ ] **Step 3:** Repo root: `bun run verify-types`, `bun run lint:check`, `bun run test`, `bunx turbo build` — all four clean.
- [ ] **Step 4:** `git commit -m "test(e2e): mobile shell follows the split — Server nav label and the user-menu Account path"`

---

## Self-review notes (author)

- Spec coverage: §1→T4, §2→T5, §3→T3, §4→T2, §5→T1, §6→T6, §7→T1/T2/T3/T4 tests + T7, §9→T7.
- Task 3 Step 4 flags the one real sequencing trap (`/account` must exist in the route tree before the typed `navigate({ to: "/account" })` compiles) with a concrete resolution path.
- Task 5 depends on Task 4 (route + extracted card) — run in order.
