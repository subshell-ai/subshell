# Auth Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chrome-free sign-in/setup pages with a signed-out guard (`?redirect=` return path), and an instance-wide read-only user roster while user management stays admin-only.

**Architecture:** Spec `docs/superpowers/specs/2026-08-30-auth-experience-design.md` (Approach A). `GET /api/users` becomes available to any authenticated principal and returns `{viewerIsAdmin, users}` — `viewerIsAdmin` mirrors `requireAdmin`'s exact gate (cookie actor + `user_meta` role `admin`) so the admin UI appears for exactly who can POST. `__root.tsx` gains the guard + chrome suppression for `/login` and `/setup`; `/users` branches on the flag.

**Tech Stack:** Elysia + Kysely (backend), React 19 + TanStack Router/Query (frontend), `bun test` unit, Playwright e2e (`e2e/`).

## Global Constraints

- Pinned exact dependency versions; **no new dependencies** in this feature.
- No dynamic `import()` anywhere (`.claude/rules/code-style.md`).
- Admin surfaces remain **cookie-only**: bearer keys may read the roster but `viewerIsAdmin` is false for them, and POST `/api/users` keeps 403 for bearer + non-admin (the `requireAdmin` semantics: 401 anonymous / 403 non-cookie / 403 non-admin).
- `requireAdmin`'s rule lives in ONE place (`auth-guard.ts`) — reuse the plugin, do not copy the check into handlers.
- Every Elysia `t` schema property carries a `description` (`.claude/rules/code-style.md`).
- Verification loop after each code task: `bun run verify-types && bun run lint:check && bun run test` from the repo root (same trio as pre-push).
- E2E contract: specs run alphabetical on ONE shared DB (`workers: 1`); the e2e stack is a fresh temp DB per run, so users created in specs need no cleanup; never assert xterm canvas text.
- Mobile shell invariants (mobile spec §10): `MobileTopBar`/drawer and `useIsWide` behavior must not change on app routes; the guard must not break `/setup` (pre-auth) or the Playwright wizard spec (`01` starts unauthenticated at `/` → `/setup`).

---

### Task 1: Backend — roster envelope + per-route admin gate

**Files:**
- Modify: `apps/backend/src/api/users.route.ts` (whole file; current shape: prefix `.use(requireAdmin)` with GET + POST)
- Modify: `apps/backend/src/api/__tests__/users-admin.test.ts`

**Interfaces:**
- Consumes: `authGuard`, `requireAdmin` (`@/api/auth-guard.ts`), `UsersRepository.listWithRoles()` (unchanged), `UserMetaRepository.getRole(userId): Promise<string | null>` (`@/db/repositories/user-meta.repository.js`).
- Produces: `GET /api/users` → `{ viewerIsAdmin: boolean, users: UserRow[] }` (UserRow = `{id, email, role, createdAt}` unchanged); `POST /api/users` request/response unchanged; both still under the `/api/users` prefix exported as `usersRoutes`.

- [ ] **Step 1: Update the existing tests to the envelope, add the new cases (they must fail first)**

In `apps/backend/src/api/__tests__/users-admin.test.ts`:

a) Replace the body of `it("admin can list users (GET /api/users)")` — parse the envelope:

```ts
  it("admin can list users (GET /api/users)", async () => {
    const token = await signIn(adminEmail, adminPassword);
    const res = await usersRoutes.fetch(authedRequest("/api/users", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      viewerIsAdmin: boolean;
      users: Array<{ id: string; email: string; role: string | null; createdAt: string | null }>;
    };
    expect(body.viewerIsAdmin).toBe(true);
    const adminRow = body.users.find((u) => u.email === adminEmail);
    expect(adminRow?.id).toBe(adminId);
    expect(adminRow?.role).toBe("admin");
    expect(adminRow?.createdAt).toBeTruthy();
  });
```

b) Replace `it("non-admin gets 403 from GET /api/users")` wholesale:

```ts
  it("non-admin lists users read-only (200, viewerIsAdmin false)", async () => {
    const token = await signIn(nonAdminEmail, nonAdminPassword);
    const res = await usersRoutes.fetch(authedRequest("/api/users", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewerIsAdmin: boolean; users: unknown[] };
    expect(body.viewerIsAdmin).toBe(false);
    expect(Array.isArray(body.users)).toBe(true);
  });

  it("non-admin cannot create users (POST 403)", async () => {
    const token = await signIn(nonAdminEmail, nonAdminPassword);
    const res = await usersRoutes.fetch(
      authedRequest("/api/users", token, {
        method: "POST",
        body: JSON.stringify({
          email: `member-post-${crypto.randomUUID()}@mote.local`,
          password: "member-pass-123",
          role: "user",
        }),
      }),
    );
    expect(res.status).toBe(403);
  });
```

c) Add the bearer case (needs two new imports at the top of the file — `auth` from `@/auth.js`, `ensureSystemUser` from `@/auth/system-user.js`, `authDatabase` from `@/auth/database.js` — and a `createdKeyIds` array cleaned in `afterAll` exactly like `auth-guard-bearer.test.ts` does):

```ts
  it("system key bearer may read the roster but is never an admin viewer", async () => {
    const systemUserId = await ensureSystemUser();
    const created = (await auth.api.createApiKey({
      body: { name: "roster-test", userId: systemUserId, metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    const res = await usersRoutes.fetch(
      new Request("http://localhost:3080/api/users", { headers: { authorization: `Bearer ${created.key}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewerIsAdmin: boolean };
    expect(body.viewerIsAdmin).toBe(false);
  });
```

And in `afterAll`, alongside the existing deletions:

```ts
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
```

(declare `const createdKeyIds: string[] = [];` next to the other fixture lets).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/backend && DATABASE_PATH=/tmp/mote-task1.db bun test src/api/__tests__/users-admin.test.ts
```

(Per the boot-DB recipe: boot `apps/backend` once against that fresh `DATABASE_PATH` first if the schema is missing — e.g. `DATABASE_PATH=/tmp/mote-task1.db timeout 5 bun src/index.ts` — then kill it.)
Expected: FAIL — GET still returns a bare array / 403s for non-admins.

- [ ] **Step 3: Implement**

Rewrite `apps/backend/src/api/users.route.ts` bottom section (schemas above stay byte-identical except the new envelope schema). Full new route composition:

```ts
/** GET /api/users response: roster + one flag describing the VIEWER. */
const ListUsersResponseSchema = t.Object({
  viewerIsAdmin: t.Boolean({
    description:
      "True only for a cookie-session admin — mirrors the POST gate, so machine credentials never see the admin UI",
  }),
  users: t.Array(UserRowSchema, { description: "All users with roles, newest first" }),
});

// POST stays admin-only via the shared requireAdmin derive (401 anonymous /
// 403 bearer-or-non-admin); GET is instance-wide per the roster spec, so the
// plugins are mounted per-route: authGuard for the whole prefix, then a
// route-bearing sub-instance composed with requireAdmin for POST.
const adminOnly = new Elysia()
  .use(requireAdmin)
  .post(
    "/",
    async ({ body, user }) => {
      /* …existing POST handler body UNCHANGED (repo.createUser, audit, response)… */
    },
    {
      body: CreateUserBodySchema,
      response: CreateUserResponseSchema,
      detail: {
        operationId: "createUser",
        tags: ["users"],
        description: "Creates a credential user with a role (admin only, cookie session)",
      },
    },
  )
  .as("scoped");

export const usersRoutes = new Elysia({ prefix: "/api/users" })
  .use(authGuard)
  .get(
    "/",
    async ({ user, actor }) => {
      const users = await new UsersRepository(db).listWithRoles();
      // Same semantics as requireAdmin: cookie actor AND user_meta role
      // "admin". Anyone else (member cookie, any bearer) sees the roster
      // read-only.
      const viewerIsAdmin =
        actor === "cookie" && !!user && (await new UserMetaRepository(db).getRole(user.id)) === "admin";
      return { viewerIsAdmin, users };
    },
    {
      response: ListUsersResponseSchema,
      detail: {
        operationId: "listUsers",
        tags: ["users"],
        description: "Lists all users with their roles (instance-wide read; viewerIsAdmin marks management rights)",
      },
    },
  )
  .use(adminOnly);
```

Imports to add: `authGuard` (keep `requireAdmin`), `UserMetaRepository` from `@/db/repositories/user-meta.repository.js`. The existing `user` in the POST handler comes from `requireAdmin` (unchanged handler body). Update the file's top JSDoc: "Instance-wide read-only roster; management (create, audit) stays admin-cookie-only."

If `.as("scoped")` on a route-bearing instance misbehaves in this Elysia version (POST never matches), fall back to keeping POST on `usersRoutes` and starting its handler with the two verbatim `requireAdmin` checks using the EXPORTED `ForbiddenError` — but run the tests either way; the member-POST-403 case is the arbiter.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/backend && DATABASE_PATH=/tmp/mote-task1.db bun test src/api/__tests__/users-admin.test.ts
```

Expected: PASS (all existing cases + 3 changed/new).

- [ ] **Step 5: Full gates + commit**

```bash
cd /home/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test
git add apps/backend/src/api/users.route.ts apps/backend/src/api/__tests__/users-admin.test.ts
git commit -m "feat(api): instance-wide read-only user roster; POST stays admin-cookie-only"
```

---

### Task 2: Frontend — safeRedirect helper + login honors the return path

**Files:**
- Create: `apps/frontend/src/lib/redirect.ts`
- Create: `apps/frontend/src/lib/__tests__/redirect.test.ts`
- Modify: `apps/frontend/src/routes/login.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `safeRedirect(raw: string | undefined | null): string | null` (pure, exported); `/login` route whose `validateSearch` accepts `?redirect=` (pre-validated) and whose post-sign-in navigation honors it. Task 3's guard supplies the param.

- [ ] **Step 1: Write the failing test**

`apps/frontend/src/lib/__tests__/redirect.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { safeRedirect } from "@/lib/redirect";

describe("safeRedirect", () => {
  it("accepts same-origin absolute paths", () => {
    expect(safeRedirect("/workspaces")).toBe("/workspaces");
    expect(safeRedirect("/sessions/abc?tab=logs")).toBe("/sessions/abc?tab=logs");
  });
  it("rejects anything that could leave the app", () => {
    expect(safeRedirect("//evil.com")).toBeNull();
    expect(safeRedirect("///evil.com")).toBeNull();
    expect(safeRedirect("/\\evil.com")).toBeNull();
    // WHATWG URL parsing strips tab/LF/CR before resolving, so
    // `?redirect=/%09/evil.com` decodes to "/\t/evil.com" and would become
    // //evil.com — control chars (and space) are vetoed outright.
    expect(safeRedirect("/\t/evil.com")).toBeNull();
    expect(safeRedirect("/\n/evil.com")).toBeNull();
    expect(safeRedirect("/\r/evil.com")).toBeNull();
    expect(safeRedirect("https://evil.com")).toBeNull();
    expect(safeRedirect("workspaces")).toBeNull();
    expect(safeRedirect("")).toBeNull();
    expect(safeRedirect(undefined)).toBeNull();
    expect(safeRedirect(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify failure**

```bash
cd apps/frontend && bun test src/lib/__tests__/redirect.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

`apps/frontend/src/lib/redirect.ts`:

```ts
/**
 * Validates a post-sign-in `?redirect=` target. The value arrives from a URL,
 * so it must never be able to leave the app: only single-slash absolute paths
 * pass — protocol-relative (`//host`), backslash (`/\host`), control-char
 * smuggles (`/%09/evil.com`, which WHATWG strips into `//evil.com`), and
 * scheme-ful or relative forms all collapse to null; callers fall back to "/".
 */
export function safeRedirect(raw: string | undefined | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // WHATWG URL parsing (window.location.href included) removes tab/LF/CR
  // BEFORE resolving, so "/\t/evil.com" is `//evil.com` in disguise. Space is
  // folded in the same veto: a legitimately space-bearing path (none exist
  // here — route paths are ids and word-paths) collapses to "/" instead.
  if (/[\x00-\x20]/.test(raw)) return null;
  return raw;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/frontend && bun test src/lib/__tests__/redirect.test.ts
```

- [ ] **Step 5: Wire the login route**

In `apps/frontend/src/routes/login.tsx`:

```ts
export const Route = createFileRoute("/login")({
  // The signed-out guard (__root) sends visitors here with the path they
  // wanted; safeRedirect has already vetoed anything non-same-site.
  // (search.redirect is `unknown` until narrowed — apiFetch-style care.)
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const r = typeof search.redirect === "string" ? safeRedirect(search.redirect) : null;
    return r ? { redirect: r } : {};
  },
  component: LoginPage,
});
```

Inside `LoginPage`: add `const { redirect } = Route.useSearch();`; change the already-signed-in bail to `return <Navigate to={redirect ?? "/"} />;` and the success line to `window.location.href = redirect ?? "/";` (full reload stays — it resets the query cache, same reason it was a hard navigation before). Import `safeRedirect` from `@/lib/redirect`.

- [ ] **Step 6: Gates + commit**

```bash
cd /home/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/src/lib/redirect.ts apps/frontend/src/lib/__tests__/redirect.test.ts apps/frontend/src/routes/login.tsx
git commit -m "feat(login): accept a validated ?redirect= return path"
```

---

### Task 3: Shell — signed-out guard + chrome suppression on /login and /setup

**Files:**
- Modify: `apps/frontend/src/routes/__root.tsx`

**Interfaces:**
- Consumes: `useCurrentUser` (`@/lib/auth`), `apiFetch` (`@/lib/api`), `/api/setup/status` (public — `{"needsSetup": boolean, "hasUsers": boolean}`), `/login`'s typed `search.redirect` (Task 2 — import order matters for the `Navigate` types).
- Produces: signed-out → `/setup` while `needsSetup` (first-run keeps its wizard-first boot — this also protects e2e spec 01), else `/login?redirect=…` for every non-bare route; `AppSidebar`/`MobileTopBar` never mount on `/login` or `/setup`. The inset/`dvh` shell wrapper and safe-area padding stay exactly where they are.

- [ ] **Step 1: Implement**

The guard hooks CANNOT live in `RootComponent` itself — it renders `QueryClientProvider`, so hooks there sit outside the provider and `useQuery` would throw "No QueryClient set". Split: `RootComponent` keeps the providers and gains one inner component (`Shell`) that owns the guard + frame:

```tsx
function RootComponent() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <Shell />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

/** The guarded app frame: everything below the providers. */
function Shell() {
  const wide = useIsWide();
  const insets = useVisualViewportInsets();
  const { data: user, isLoading } = useCurrentUser();
  const location = useLocation();
  // Pre-auth pages own the whole frame: no sidebar, no drawer bar.
  const bare = location.pathname === "/login" || location.pathname === "/setup";
  // First-run precedence: with no users yet, signed-out visitors go to the
  // wizard (the boot experience), never to a sign-in form that cannot work.
  // Cached hard — needsSetup is true exactly once in an instance's life.
  const { data: needsSetup, isLoading: setupLoading } = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => apiFetch<{ needsSetup: boolean }>("/api/setup/status").then((d) => d.needsSetup),
    enabled: !isLoading && !user,
    staleTime: Infinity,
  });

  // Hold first paint until the session (and, when signed out, the setup
  // state) is known — chrome must not flash and the guard must not race.
  if (isLoading) return null;
  if (!user) {
    if (setupLoading && !bare) return null;
    if (needsSetup && location.pathname !== "/setup") return <Navigate to="/setup" />;
    if (needsSetup === false && !bare) {
      return <Navigate to="/login" search={{ redirect: location.pathname }} />;
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden pt-[env(safe-area-inset-top)]" style={/* existing insets style */}>
      {!wide && !bare && <MobileTopBar />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {wide && !bare && <AppSidebar />}
        <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
```

(`needsSetup` is `boolean | undefined`. When a failed status query leaves it `undefined`, neither Navigate branch fires and the page renders signed-out with chrome — the OLD behavior, acceptable as the error fallback; a subsequent navigation retries the query.)

Imports to add in `__root.tsx`: `Navigate`, `useLocation` from `@tanstack/react-router`; `useQuery` from `@tanstack/react-query`; `useCurrentUser` from `@/lib/auth`; `apiFetch` from `@/lib/api`. Update the RootComponent JSDoc: mention the guard (setup-precedence included) + bare frames.

- [ ] **Step 2: Manual sanity (optional — Task 5's e2e re-proves all of it)**

With a dev stack up: signed-out `/workspaces` → `/login?redirect=…`, no sidebar; the sign-in lands back on `/workspaces`. On a fresh-DB instance (`/api/setup/status` → needsSetup) any path → `/setup`, chrome-free.

- [ ] **Step 3: Gates + commit**

```bash
cd /home/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/src/routes/__root.tsx
git commit -m "feat(shell): guard signed-out visitors to /login; /login and /setup render bare"
```

---

### Task 4: Users page — envelope + role-branched sections

**Files:**
- Modify: `apps/frontend/src/routes/users.tsx`

**Interfaces:**
- Consumes: Task 1's `{viewerIsAdmin, users}` response shape.
- Produces: nothing further (terminal UI change).

- [ ] **Step 1: Implement**

In `users.tsx`:

a) Replace the `UserRow[]` query with the envelope:

```ts
interface UsersEnvelope {
  viewerIsAdmin: boolean;
  users: UserRow[];
}

const {
  data: envelope,
  isLoading,
  error,
} = useQuery({
  queryKey: ["users"],
  queryFn: () => apiFetch<UsersEnvelope>("/api/users"),
  retry: false,
});
```

b) Gate the audit query — members must never fire a doomed request:

```ts
const { data: auditEvents } = useQuery({
  queryKey: ["audit"],
  queryFn: () => apiFetch<AuditEvent[]>("/api/audit?limit=50"),
  enabled: envelope?.viewerIsAdmin === true,
});
```

c) Replace the old 403-card branch (GET no longer 403s) with an honest failure card — title "Users", description "Couldn't load the roster — check your connection or sign in again." (same Card layout as today's error branch).

d) Branch the sections on `envelope?.viewerIsAdmin`:
   - Header description: admin → today's `"Admin user management and audit trail"`; member → `"The people on this instance"`.
   - The Add-user `<Card>` and the Audit-trail `<Card>` render ONLY for admins.
   - The roster card renders for everyone; table body maps `envelope?.users` (columns unchanged); the count line reads `{envelope?.users.length ?? 0} accounts on this instance`.

e) Update the invalidation after create (admin-only path): `queryClient.invalidateQueries({ queryKey: ["users"] })` stays; audit invalidation stays (admins only reach the form).

- [ ] **Step 2: Gates + commit**

```bash
cd /home/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test
git add apps/frontend/src/routes/users.tsx
git commit -m "feat(users): instance-wide read-only roster; management cards admin-only"
```

---

### Task 5: E2E — spec 10 (guard, bare login, member read-only)

**Files:**
- Create: `e2e/tests/10-auth-experience.spec.ts`

**Interfaces:**
- Consumes: `ADMIN`/`ADMIN_STATE` (`./helpers`), the spec-01 admin (file order: 10 runs last), `POST /api/users` (admin cookie context).
- Produces: permanent suite coverage for spec sections §3–§5. Fresh temp DB per run ⇒ the member user needs no cleanup.

- [ ] **Step 1: Write the spec**

```ts
import { expect, test } from "@playwright/test";
import { ADMIN, ADMIN_STATE } from "./helpers";

/**
 * Auth-experience spec (spec 2026-08-30): the signed-out guard + bare login
 * frame, and the instance-wide read-only roster. Uses fresh browser contexts
 * rather than test.use storageState because ONE test needs admin, member and
 * anonymous principals side by side.
 */

test("signed-out deep-link round-trips through /login?redirect", async ({ page }) => {
  await page.goto("/workspaces");
  // Only "on /login" is asserted here — TanStack owns the exact search-param
  // encoding, so the param's SHAPE is not the contract; the successful
  // landing on /workspaces below proves the param round-tripped.
  await expect(page).toHaveURL(/\/login/);
  expect(new URL(page.url()).searchParams.has("redirect")).toBe(true);
  // The login frame is bare: no sidebar (desktop), no drawer bar (mobile),
  // and no Logout affordance anywhere.
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
  await expect(page.getByText("Logout")).toHaveCount(0);

  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
});

test("members see the roster but no management UI", async ({ browser }) => {
  // Admin mints the member through the API (admin context closes right after).
  const adminCtx = await browser.newContext({ storageState: ADMIN_STATE });
  const member = {
    email: `member-${Date.now()}@mote.test`,
    password: "member-pass-123",
    role: "user",
  } as const;
  const created = await adminCtx.request.post("/api/users", { data: member });
  expect(created.ok(), await created.text()).toBe(true);
  // Positive control: the SAME selectors the member test asserts absent MUST
  // match for an admin. CardTitle renders a plain <div>, so heading-role
  // selectors would be structurally vacuous (review lesson from the first
  // draft) — use the gated submit button and the audit description text.
  const adminPage = await adminCtx.newPage();
  await adminPage.goto("/users");
  await expect(adminPage.getByRole("button", { name: "Add user" })).toBeVisible();
  await expect(adminPage.getByText("Latest session lifecycle")).toBeVisible();
  await adminCtx.close();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", member.email);
  await page.fill("#password", member.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  // The roster is real: the member's own row is there.
  await expect(page.getByRole("cell", { name: member.email })).toBeVisible();
  // Management is invisible, not just disabled — selectors mirrored from the
  // admin positive control above (non-vacuous by construction).
  await expect(page.getByRole("button", { name: "Add user" })).toHaveCount(0);
  await expect(page.getByText("Latest session lifecycle")).toHaveCount(0);

  // And unreachable: the API keeps enforcing, not just the UI hiding.
  const post = await ctx.request.post("/api/users", {
    data: { email: `sneaky-${Date.now()}@mote.test`, password: "sneaky-pass-123", role: "user" },
  });
  expect(post.status()).toBe(403);
  await ctx.close();
});
```

- [ ] **Step 2: Run the suite**

```bash
cd /home/theo/projects/mote && bun run test:e2e
```

Expected: all green, including pre-existing specs (01 must still get its chrome-free wizard, 08's drawer tests still find the burger on `/`).

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/10-auth-experience.spec.ts
git commit -m "test(e2e): guard round-trip, bare login frame, member read-only roster"
```

---

### Task 6: Docs + final gate

**Files:**
- Modify: `docs/overview.md`

- [ ] **Step 1: Update the docs lines**

In `docs/overview.md`, find the Auth key-decisions row and adjust to include: first user becomes admin; registration gate; **instance-wide read-only roster (management cookie-admin only)**; signed-out visitors are redirected to a chrome-free `/login` with a return path. Keep the table cell terse (it is a summary — the spec file is authoritative).

- [ ] **Step 2: Full verification**

```bash
cd /home/theo/projects/mote && bun run verify-types && bun run lint:check && bun run test && bun run test:e2e
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add docs/overview.md
git commit -m "docs: auth experience — bare sign-in guard + instance-wide roster"
```

---

## Spec coverage self-check

| Spec section | Task |
|---|---|
| §3 shell guard + chrome suppression + redirect param | 2, 3 |
| §4 backend envelope + POST gate + bearer rule | 1 |
| §5 login redirect use + users page branching + degraded error copy | 2, 3, 4 |
| §6 backend/unit/e2e tests + docs | 1, 2, 5, 6 |
| §7 invariants (cookie-only admin, requireAdmin untouched, no mechanics change) | 1 (reuses requireAdmin), 5 (403 assertion) |
