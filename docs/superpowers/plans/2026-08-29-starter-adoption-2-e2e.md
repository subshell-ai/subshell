# Increment 2 — e2e Playwright Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax to track.

**Goal:** Add a repo-root `e2e/` Playwright workspace that boots the real backend (single origin, temp SQLite + temp session dir + stub `pi` harness) and runs 7 ordered specs: setup wizard, auth behavior, bookmarks/profiles/workspaces CRUD, session lifecycle against real tmux, and an API-level channel round-trip — plus a CI job.

**Architecture:** `globalSetup` spawns `bun src/index.ts` with scratch env; the backend serves the built SPA, so tests hit ONE origin. Browser specs (`workers: 1`, alphabetical) share state: `01` creates the admin via the wizard and saves a storage state the later specs load. Terminal output is NOT DOM-readable (xterm WebGL canvas — verified), so pane assertions use server-side truth: status chips, state panels, the `/api/auth/ws-token` + `/ws` network events.

**Tech Stack:** `@playwright/test` 1.62.1 (chromium), `jose` 6.2.10 (channel spec only), bun workspaces + turbo.

**Spec:** `docs/superpowers/specs/2026-08-29-starter-structure-adoption-design.md`, Increment 2 — plus the spec corrections in Task 7 (the design doc assumed a login redirect and a bash-launchable profile; the code shows neither — this plan implements the corrected behavior).

**UI source of truth:** `/home/theo/projects/mote/.sdd/e2e-ui-map.md` — every visible label, input id, and aria-quote below comes from it. Persist it there (this plan's Task 1 Step 0) if missing.

## Global Constraints

- Bun only; all dependency versions pinned EXACT (no `^`/`~`), matching root versions where shared (`typescript 7.0.2`, `@types/node 26.2.0`); after `bun add` run `bunx syncpack fix` then `bun install`.
- No `data-testid` attributes may be added to the frontend by this increment (selectors come from visible text/aria per the UI map).
- Playwright specs never use the fixed e2e port 3199 except via `e2e/ports.ts`.
- No session bearer token is retrievable from REST — channel tests authenticate with a system key (`POST /api/system-keys`, admin-cookie-gated) or user cookies.
- GitHub Actions stays SHA-pinned; the new CI job must pin every action by commit SHA with a trailing version comment, matching `.github/workflows/test.yml`'s existing jobs.
- Verification gate each task: `bun run test:e2e` green (specs written so far) + at Task 7: `bun run verify-types && bun run lint:check && bun run test`.
- e2e must never touch `apps/backend/data/` or port 3080.

---

### Task 1: Workspace scaffold + stack + smoke spec

**Files:**
- Create: `e2e/package.json`, `e2e/tsconfig.json`, `e2e/turbo.json`, `e2e/ports.ts`, `e2e/stack.ts`, `e2e/global-setup.ts`, `e2e/global-teardown.ts`, `e2e/playwright.config.ts`, `e2e/stub/pi`, `e2e/tests/00-smoke.spec.ts`
- Modify: `package.json` (workspaces + scripts), `turbo.json` (tasks), `.gitignore`

**Interfaces:**
- Produces: `startStack()/stopStack()` (used by global setup/teardown), `BASE_URL` (all specs/config), the admin storage-state convention `.auth/admin.json` (Task 2+ specs), the `pi` stub harness (Tasks 2/6 specs).

- [ ] **Step 0: Ensure the UI map exists at `.sdd/e2e-ui-map.md`.** If missing, reconstruct from the plan's quoted strings only (do not block on re-exploration).

- [ ] **Step 1: Create `e2e/ports.ts`:**

```ts
/**
 * Fixed host ports for the end-to-end stack.
 *
 * Deliberately not random and deliberately far from the development defaults
 * (3080) so an e2e run cannot collide with a running `turbo watch dev`. The
 * backend serves the built SPA, so this single origin IS the whole app.
 */
export const PORTS = { backend: 3199 } as const;

export const BASE_URL = `http://127.0.0.1:${PORTS.backend}`;
```

- [ ] **Step 2: Create `e2e/package.json`:**

```json
{
  "name": "@internal/e2e",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "install-browsers": "playwright install chromium",
    "clean": "rm -rf .turbo node_modules test-results playwright-report .auth",
    "lint": "biome check --no-errors-on-unmatched --write --unsafe .",
    "lint:check": "biome check --no-errors-on-unmatched .",
    "lint:staged": "biome check --no-errors-on-unmatched --write --unsafe --staged .",
    "verify-types": "tsc --noEmit"
  },
  "devDependencies": {
    "@internal/backend": "workspace:*",
    "@internal/frontend": "workspace:*",
    "@internal/tsconfig": "workspace:*",
    "@playwright/test": "1.62.1",
    "@types/node": "26.2.0",
    "jose": "6.2.9",
    "typescript": "7.0.2"
  }
}
```

(`@internal/backend`/`@internal/frontend` exist to create the turbo `^build` edge so the SPA dist is fresh before tests. `jose` is used by the channel spec.)

- [ ] **Step 3: Create `e2e/tsconfig.json`:**

```json
{
  "extends": "@internal/tsconfig/tsconfig.json",
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "test-results", "playwright-report"],
  "compilerOptions": {
    "types": ["node"],
    "noEmit": true
  }
}
```

- [ ] **Step 4: Create `e2e/turbo.json`:**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "extends": ["//"],
  "tasks": {
    "clean": {},
    "lint": { "inputs": ["**/*.ts", "*.json"] },
    "verify-types": { "inputs": ["**/*.ts", "*.json"] },
    "test:e2e": { "dependsOn": ["^build"], "cache": false }
  }
}
```

- [ ] **Step 5: Create `e2e/stub/pi` (the dummy harness) and make it executable (`chmod +x`):**

```bash
#!/usr/bin/env bash
# Stub "pi" harness for e2e runs. Real sessions launch `env -i PATH=... <argv>`
# with no shell, so the stub must be an executable that ignores every argument,
# prints something observable (pane-log capture proves the pipe works), then
# stays alive like a real interactive harness.
echo "mote-e2e stub harness ready"
i=0
while :; do
  i=$((i + 1))
  echo "tick ${i}"
  sleep 5
done
```

Verify the override env var name is `PI_PATH` by reading `packages/harnesses/src/pi.ts` (`findBinary(this.binaryName, "<ENV_NAME>", ...)`); if it differs, use the real name in stack.ts.

- [ ] **Step 6: Create `e2e/stack.ts`:**

```ts
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BASE_URL, PORTS } from "./ports";

const ROOT = path.join(import.meta.dirname, "..");
const BACKEND_DIR = path.join(ROOT, "apps", "backend");
const STUB_PI = path.join(ROOT, "e2e", "stub", "pi");

interface Stack {
  dir: string;
  child?: ReturnType<typeof spawn>;
}

declare global {
  var e2eStack: Stack | undefined;
}

/** Polls the unauthenticated setup-status endpoint until it answers. */
async function waitForReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/setup/status`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`[e2e] backend did not become ready at ${BASE_URL} within ${timeoutMs}ms`);
}

/**
 * Boots the real backend against scratch state: temp file DB, temp session
 * dir, and the `pi` stub as the only harness binary. `detached` puts it in its
 * own process group so teardown can kill the whole tree (bun forks; killing
 * only the parent leaves the server holding the port).
 */
export async function startStack(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "mote-e2e-"));
  chmodSync(STUB_PI, 0o755);

  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore",
    env: {
      ...process.env,
      // IS_TEST keys off NODE_ENV/MOTE_TEST_MODE and would force the shared
      // in-memory DB; the stack must run like production instead.
      NODE_ENV: "development",
      SERVER_PORT: String(PORTS.backend),
      HOST: "127.0.0.1",
      DATABASE_PATH: path.join(dir, "mote.db"),
      SESSION_DATA_DIR: path.join(dir, "sessions"),
      APP_BASE_URL: BASE_URL,
      BETTER_AUTH_SECRET: "e2e-secret-not-used-outside-tests-0000000000",
      // Detection re-probes per request, so the stub appears as installed.
      PI_PATH: STUB_PI,
    },
  });
  child.unref();

  globalThis.e2eStack = { dir, child };
  await waitForReady();
}

export async function stopStack(): Promise<void> {
  const stack = globalThis.e2eStack;
  if (stack?.child?.pid) {
    try {
      process.kill(-stack.child.pid, "SIGTERM");
    } catch {
      // Already dead.
    }
  }
  if (stack?.dir) rmSync(stack.dir, { recursive: true, force: true });
  globalThis.e2eStack = undefined;
}
```

- [ ] **Step 7: Create `e2e/global-setup.ts` and `e2e/global-teardown.ts`:**

```ts
// global-setup.ts
import { mkdirSync, rmSync } from "node:fs";
import { startStack } from "./stack";

/** Boots the scratch stack, resets auth state, runs once before all workers. */
export default async function globalSetup(): Promise<void> {
  rmSync(new URL(".auth/", import.meta.url), { recursive: true, force: true });
  mkdirSync(new URL(".auth/", import.meta.url), { recursive: true });
  await startStack();
}
```

```ts
// global-teardown.ts
import { stopStack } from "./stack";

export default async function globalTeardown(): Promise<void> {
  await stopStack();
}
```

- [ ] **Step 8: Create `e2e/playwright.config.ts`:**

```ts
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./ports";

/**
 * End-to-end tests: a real browser against the real backend serving the built
 * SPA, a real temp-file SQLite DB, and real tmux sessions (stub `pi` harness).
 * globalSetup owns the stack — Playwright's own webServer starts before
 * globalSetup and would race the build. Not part of `turbo test`.
 *
 * `workers: 1` on purpose: specs share one database and run in file order —
 * 01 creates the admin every later spec logs in as.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

- [ ] **Step 9: Create `e2e/tests/00-smoke.spec.ts`:**

```ts
import { expect, test } from "@playwright/test";

test("the stack is up and reports a pristine database", async ({ request }) => {
  const res = await request.get("/api/setup/status");
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { needsSetup: boolean; hasUsers: boolean };
  expect(body.needsSetup).toBe(true);
  expect(body.hasUsers).toBe(false);
});
```

- [ ] **Step 10: Wire the workspace.** In root `package.json`: add `"e2e"` to `workspaces`; add scripts `"test:e2e": "turbo run test:e2e"` and `"test:e2e:install": "turbo run install-browsers"`. In root `turbo.json` tasks add `"test:e2e": {"cache": false}` and `"install-browsers": {"cache": false}`. Append to `.gitignore`:

```
# e2e scratch (Playwright)
e2e/.auth/
e2e/test-results/
e2e/playwright-report/
```

- [ ] **Step 11: Install + run the smoke spec.**

```bash
bun install
bunx playwright install chromium
bun run build   # ensures apps/frontend/dist exists (backend boot throws without it)
bun run test:e2e
```

Expected: 1 passed. If the backend fails to boot, read `apps/backend/src/index.ts` boot order (migrations, static plugin) and check env names in `src/constants.ts` before adjusting stack.ts.

- [ ] **Step 12: Commit**

```bash
git add e2e package.json bun.lock turbo.json .gitignore
git commit -m "test(e2e): scaffold Playwright workspace with temp-dir backend stack"
```

---

### Task 2: Auth specs (setup wizard + guard behavior) + shared login helper

**Files:**
- Create: `e2e/tests/helpers.ts`, `e2e/tests/01-setup-wizard.spec.ts`, `e2e/tests/02-auth-guard.spec.ts`

**Interfaces:**
- Consumes: Task 1's stack (pristine DB, stub pi), `workers: 1` ordering.
- Produces: `.auth/admin.json` storage state; `helpers.ts` exports `ADMIN` (`{email,password,name}`), `ADMIN_STATE`, `login(page)` — every later UI spec uses these.

- [ ] **Step 1: Create `e2e/tests/helpers.ts`:**

```ts
import { expect, type Page } from "@playwright/test";

/** The single admin account the wizard creates; later specs reuse its session. */
export const ADMIN = {
  name: "E2E Admin",
  email: "admin@mote.e2e",
  password: "e2e-admin-pass-1",
} as const;

export const ADMIN_STATE = ".auth/admin.json";

/** Real cookie login through the UI form. */
export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Success is a FULL page load (window.location.href), not a client nav.
  await page.waitForURL("**/");
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
}
```

- [ ] **Step 2: Write `e2e/tests/01-setup-wizard.spec.ts` (RED first — it must run green only after real behavior):**

```ts
import { expect, test } from "@playwright/test";
import { ADMIN } from "./helpers";

test("first-run wizard creates the admin; login and logout work", async ({ page, context }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/); // "/" redirects while needsSetup
  await expect(page.getByText("Welcome to Mote")).toBeVisible();

  // Step 1/3 — Account
  await page.fill("#name", ADMIN.name);
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.getByRole("button", { name: "Create admin account" }).click();

  // Step 2/3 — Harness: the stub `pi` must read "installed" and be selectable.
  await expect(page.getByText("Step 2 of 3")).toBeVisible();
  const piCard = page.getByRole("button").filter({ hasText: "pi" });
  await expect(piCard.first()).toContainText("installed");
  await piCard.first().click();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3/3 — Profile (name pre-filled "Default")
  await expect(page.getByText("Step 3 of 3")).toBeVisible();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

  // The wizard must never show again on a DB with users.
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/$/);

  // Logout, then real login through the form.
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/");

  // Hand the session to the specs that run after this one (workers: 1).
  await context.storageState({ path: ".auth/admin.json" });
});
```

If the harness card is not `role=button`, inspect `routes/setup.tsx` Step-1 card markup and adjust the locator (visible-text based; no new attributes).

- [ ] **Step 3: Write `e2e/tests/02-auth-guard.spec.ts`:**

```ts
import { expect, test } from "@playwright/test";

/**
 * The frontend has NO route guard — protection is API-side. This spec pins
 * that actual behavior (and would catch a future "oops, data leaks when
 * logged out" regression). Design-doc note: the original spec assumed a
 * login redirect; the app deliberately does not redirect.
 */
test("protected APIs reject anonymous callers", async ({ request }) => {
  for (const path of ["/api/sessions", "/api/bookmarks", "/api/profiles", "/api/workspaces"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(401);
  }
});

test("login page renders with its form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("Sign in to Mote")).toBeVisible();
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
});
```

- [ ] **Step 4: Run** `bun run test:e2e` — expected: 4 passed (smoke + 3). Debug selector misses per spec before proceeding. If 01 fails because the wizard shows for a non-pristine DB, the stack didn't get a fresh temp dir — check `DATABASE_PATH` in the spawned env (`E2E_VERBOSE=1 bun run test:e2e`).

- [ ] **Step 5: Commit** `git add e2e/tests && git commit -m "test(e2e): setup wizard, auth behavior, and shared login helper specs"`

---

### Task 3: CRUD specs — bookmarks, profiles, workspaces

**Files:**
- Create: `e2e/tests/03-bookmarks.spec.ts`, `e2e/tests/04-profiles.spec.ts`, `e2e/tests/05-workspaces.spec.ts`

**Interfaces:**
- Consumes: `.auth/admin.json`, `helpers.ts`.
- Produces: the workspace-with-added-pane that Task 4's session spec assumes exists (05 runs first).

- [ ] **Step 1: `e2e/tests/03-bookmarks.spec.ts`:**

```ts
import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

test("create, edit, and delete a bookmark", async ({ page }) => {
  await page.goto("/bookmarks");
  await page.getByRole("button", { name: "New bookmark" }).click();
  await page.fill("#bookmark-name", "E2E tmp");
  await page.fill("#bookmark-path", "/tmp");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("E2E tmp")).toBeVisible();

  // Edit through the card's actions menu.
  await page.getByRole("button", { name: "Actions for E2E tmp" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.getByText("Edit bookmark")).toBeVisible();
  await page.fill("#bookmark-description", "created by e2e");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("created by e2e")).toBeVisible();

  // Delete needs a confirm dialog.
  await page.getByRole("button", { name: "Actions for E2E tmp" }).click();
  await page.getByRole("menuitem", { name: "Delete bookmark" }).click();
  await expect(page.getByText("Delete this bookmark?")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No bookmarks yet")).toBeVisible();
});

test("the API rejects a bookmark whose path does not exist", async ({ request }) => {
  const res = await request.post("/api/bookmarks", {
    data: { name: "ghost", path: "/definitely-not-a-real-path-e2e" },
  });
  expect(res.status()).toBe(400);
});
```

(03's second test uses the storage-state cookie automatically via `request` — Playwright's `request` fixture shares `test.use` storage state.)

- [ ] **Step 2: `e2e/tests/04-profiles.spec.ts`:**

```ts
import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

test("the wizard profile exists; create and delete another profile", async ({ page }) => {
  await page.goto("/profiles");
  // Created by the wizard in spec 01.
  await expect(page.getByText("Default")).toBeVisible();

  await page.getByRole("button", { name: "New profile" }).click();
  await page.getByRole("combobox").click(); // Radix harness select trigger
  await page.getByRole("option", { name: "pi" }).click();
  await page.fill("#profile-name", "E2E shell");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("E2E shell")).toBeVisible();

  // Delete it again — leave only the wizard's Default for later specs.
  await page.getByRole("button", { name: "Actions for E2E shell" }).click();
  await page.getByRole("menuitem", { name: "Delete profile" }).click();
  await expect(page.getByText("Delete this profile?")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("E2E shell")).toHaveCount(0);
});
```

If the harness trigger is not `role=combobox`, locate it by its placeholder text "Choose a harness" (Radix Select renders a button; adjust per `profile-fields.tsx`).

- [ ] **Step 3: `e2e/tests/05-workspaces.spec.ts`:**

```ts
import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

test("create a workspace, add a session pane, and the layout survives reload", async ({ page }) => {
  await page.goto("/workspaces");
  await page.getByRole("button", { name: "New workspace" }).click();
  await expect(page).toHaveURL(/\/workspaces\/.+/);

  // Wide viewport (Desktop Chrome) → dock. Add a session through the picker.
  await page.getByRole("button", { name: "Add session" }).click();
  await expect(page.getByRole("heading", { name: "Add a session" })).toBeVisible();
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByRole("combobox").click();
  await page.getByRole("option").filter({ hasText: "Default" }).click();
  await page.fill("#picker-working-dir", "/tmp");
  await page.fill("#picker-session-name", "e2e-pane");
  await page.getByRole("button", { name: "Start session" }).click();

  // The pane appears carrying the session's name as its panel title.
  await expect(page.getByText("e2e-pane").first()).toBeVisible();

  // Layout persists: reload re-reads the dock state from the API.
  await page.reload();
  await expect(page.getByText("e2e-pane").first()).toBeVisible();
});
```

- [ ] **Step 4: Run** `bun run test:e2e` — expected: 7 passed.
- [ ] **Step 5: Commit** `git add e2e/tests && git commit -m "test(e2e): bookmarks, profiles, and workspace-pane specs"`

---

### Task 4: Session lifecycle spec against real tmux

**Files:**
- Create: `e2e/tests/06-session-lifecycle.spec.ts`

**Interfaces:**
- Consumes: Default profile (pi stub), `/tmp` working dir, `.auth/admin.json`.
- Produces: nothing later tasks need.

- [ ] **Step 1: Write `e2e/tests/06-session-lifecycle.spec.ts`:**

```ts
import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * The flagship path: create a real tmux session (stub `pi` binary, spec 01's
 * Default profile), watch the terminal attach, then terminate and delete.
 * xterm paints to a WebGL canvas, so "the pane is live" is asserted through
 * server-side truth: the ws-token mint + /ws upgrade + the absence of the
 * reconnecting pill — never canvas pixels.
 */
test("session: create -> attach -> terminate -> delete", async ({ page }) => {
  // Create from the /new page.
  await page.goto("/new");
  await page.getByRole("combobox").click();
  await page.getByRole("option").filter({ hasText: "Default" }).click();
  await page.fill("#working-dir", "/tmp");
  await page.fill("#name", "e2e-lifecycle");

  const tokenRes = page.waitForResponse((r) =>
    r.url().includes("/api/auth/ws-token") && r.status() === 200,
  );
  const socket = page.waitForEvent("websocket", (w) => w.url().includes("/ws?session="));
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(/\/sessions\/.+/);

  // Terminal attached: token minted, socket opened, no reconnecting pill.
  await tokenRes;
  const ws = await socket;
  await expect(ws.url()).toContain("/ws?session=");
  await expect(page.getByText("reconnecting…")).toHaveCount(0);

  // Header badge reflects server status.
  await expect(page.getByText("running").first()).toBeVisible();

  // Terminate from the sessions list via the actions menu + confirm.
  await page.goto("/");
  const card = page.locator("div, article").filter({ hasText: "e2e-lifecycle" }).last();
  await expect(card).toContainText("running");
  await page.getByRole("button", { name: "Actions for e2e-lifecycle" }).click();
  await page.getByRole("menuitem", { name: "Terminate" }).click();
  await expect(page.getByText('Terminate session "e2e-lifecycle"?')).toBeVisible();
  await page.getByRole("button", { name: "Terminate" }).click();
  await expect(page.getByText("ended").first()).toBeVisible();

  // Delete it.
  await page.getByRole("button", { name: "Actions for e2e-lifecycle" }).click();
  await page.getByRole("menuitem", { name: "Delete session" }).click();
  await expect(page.getByText('Delete session "e2e-lifecycle"?')).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("e2e-lifecycle")).toHaveCount(0);
});
```

- [ ] **Step 2: Run** `bun run test:e2e` — expected: 8 passed. This is the first spec that really spawns tmux; if the session goes to "exited" instead of "running", check the stub ran: `E2E_VERBOSE=1`, and inspect the pane log file under the stack's `SESSION_DATA_DIR` (path printed only with E2E_VERBOSE; or add a temporary console.log to stopStack — remove after).

- [ ] **Step 3: Commit** `git add e2e/tests/06-session-lifecycle.spec.ts && git commit -m "test(e2e): real-tmux session lifecycle spec"`

---

### Task 5: Channel round-trip spec (API-level, not browser)

**Files:**
- Create: `e2e/seal.ts`, `e2e/tests/07-channels-api.spec.ts`

**Interfaces:**
- Consumes: admin storage state (system-key minting + user creation are cookie-only admin routes).
- Produces: nothing.

**Background for the implementer (verified):** channels are machine-facing — no frontend UI exists. Identities are per-PRINCIPAL (`user:<id>` / `sess:<id>`); re-registering the same principal UPSERTS, so the spec needs THREE distinct principals → three distinct users. Sealing is a General JWE: one AES-256-GCM content key wrapped per recipient via ECDH-ES + A256KW; the backend never decrypts. Envelope format + headers are defined in `apps/backend/src/mcp/crypto.ts` (`seal`/unseal functions, `ALG = "ECDH-ES+A256KW"`, kid in header = principal id) — copy the needed functions into `e2e/seal.ts` verbatim (jose is a dependency of BOTH backend and e2e — check `import` lines in crypto.ts and mirror them). Session bearer tokens are never returned by REST (`POST /api/sessions` → `{id, tmuxSocket, promptDelivered}`), which is why this spec uses user identities, not session ones.

- [ ] **Step 1: Read `apps/backend/src/mcp/crypto.ts` and `apps/backend/src/api/channels.route.ts` + `identities.route.ts` end-to-end.** Confirm: POST /api/identities body `{publicKey, displayName?}`; POST /api/channels body (read CreateBodySchema); members endpoint body; posts body `{envelope, recipientIds}`; GET posts query (`since`, `wait`, `limit`, `mark` — leave `wait` unset for the spec). Record the exact recipient-header convention (where principalId appears in the General JWE) in your report.

- [ ] **Step 2: Create `e2e/seal.ts`** — the verbatim copy (with static `import ... from "jose"` / node:crypto lines matching the backend's) of just what the spec needs: keypair generation, public-JWK export, `seal(text, recipients)` and `unseal(envelope, privateKey)`. Keep JSDoc noting the source file. No dynamic imports.

- [ ] **Step 3: Write `e2e/tests/07-channels-api.spec.ts`:** structure (exact endpoint strings, per the routes you read in Step 1):

```ts
import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";
import { exportPublicJwk, generateIdentity, seal, unseal } from "../seal";

test.use({ storageState: ADMIN_STATE });

test("sealed posts reach the recipient only", async ({ playwright, request }) => {
  // Three distinct principals = three users (identities upsert per principal).
  const creds = { password: "e2e-channel-pass-1" };
  const emails = ["alice@mote.e2e", "bob@mote.e2e", "carol@mote.e2e"];
  const users: Record<string, { token: string; id: string }> = {};
  for (const email of emails) {
    const created = await request.post("/api/users", { data: { ...creds, email, role: "user" } });
    expect(created.status()).toBe(200);
    users[email] = await created.json();
  }

  // A context per user so each acts as its own principal.
  const sessions = {};
  for (const email of emails) {
    const ctx = await playwright.request.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const res = await ctx.post("/api/auth/sign-in/email", {
      data: { email, password: creds.password },
    });
    expect(res.ok()).toBeTruthy();
    sessions[email] = ctx;
  }

  // Register one ECDH identity per user.
  const ids = {};
  for (const email of emails) {
    const identity = generateIdentity();
    const pub = await exportPublicJwk(identity);
    const res = await sessions[email].post("/api/identities", {
      data: { publicKey: JSON.stringify(pub), displayName: email },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    ids[email] = { principalId: body.principalId, identity };
  }

  // Alice opens a channel and enrolls Bob (endpoint + body per CreateBodySchema).
  const ch = await sessions["alice@mote.e2e"].post("/api/channels", {
    data: { name: "e2e-room" /* + members field if the schema has one */ },
  });
  expect([200, 201]).toContain(ch.status());
  // If membership is a separate endpoint, add bob here:
  // POST /api/channels/e2e-room/members  { principalIds: [ids["bob@mote.e2e"].principalId] }

  // Alice seals "hello bob" to Bob (+self, mirroring real senders)...
  const sealed = await seal(
    "hello bob",
    [ids["bob@mote.e2e"], ids["alice@mote.e2e"]].map((r) => ({
      principalId: r.principalId,
      publicJwk: await exportPublicJwk(r.identity),
    })),
  );
  const post = await sessions["alice@mote.e2e"].post("/api/channels/e2e-room/posts", {
    data: sealed,
  });
  expect(post.status()).toBe(200);

  // ...Bob reads and decrypts; Carol (non-recipient) sees nothing.
  const bobPosts = await (
    await sessions["bob@mote.e2e"].get("/api/channels/e2e-room/posts?since=0")
  ).json();
  expect(bobPosts.posts.length).toBe(1);
  expect(await unseal(bobPosts.posts[0].envelope, ids["bob@mote.e2e"].identity)).toBe("hello bob");

  const carolPosts = await (
    await sessions["carol@mote.e2e"].get("/api/channels/e2e-room/posts?since=0")
  ).json();
  expect(carolPosts.posts.length).toBe(0);

  for (const ctx of Object.values(sessions)) await ctx.dispose();
});
```

Adapt the marked spots to the schemas you read in Step 1 (channel-create body, membership endpoint, response field names). The skeleton's flow, assertions, and endpoint strings are the requirement.

- [ ] **Step 4: Run** `bun run test:e2e` — expected: 9 passed. (If a channel-name 409 appears on re-run, the DB is not pristine between runs — stack bug, not spec bug.)
- [ ] **Step 5: Commit** `git add e2e/seal.ts e2e/tests/07-channels-api.spec.ts && git commit -m "test(e2e): API-level E2EE channel round-trip spec"`

---

### Task 6: CI job

**Files:**
- Modify: `.github/workflows/test.yml` (append an `e2e` job)

**Interfaces:**
- Consumes: `bun run test:e2e` / `test:e2e:install`, `e2e/package.json`.
- Produces: nothing.

- [ ] **Step 1: Append to `.github/workflows/test.yml`:** reuse the existing `test` job's checkout/setup-bun/cache-bun/cache-turbo/install/build steps verbatim (copy the SHA pins from THIS file — e.g. `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0`, `actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0`), then add:

```yaml
  e2e:
    name: End-to-end
    runs-on: ubuntu-latest
    steps:
      # ...the copied checkout / setup-bun / bun-cache / turbo-cache / install / build steps...

      # Keyed on the Playwright version so a bump downloads a matching browser.
      - name: Cache Playwright browsers
        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: ~/.cache/ms-playwright
          key: ${{ runner.os }}-playwright-${{ hashFiles('e2e/package.json') }}

      - name: Install Chromium
        run: bun run test:e2e:install

      # tmux ships preinstalled on ubuntu runners; the session specs need it.
      - name: Run end-to-end tests
        run: bun run test:e2e

      - name: Upload report on failure
        if: failure()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: playwright-report
          path: e2e/playwright-report/
          retention-days: 7
```

The artifact pin above is from the starter repo — VERIFY its SHA exists on `actions/upload-artifact` v7.0.1 tag before committing (fetch `https://api.github.com/repos/actions/upload-artifact/git/ref/tags/v7.0.1` and compare); if the object differs, use the verified SHA.

- [ ] **Step 2: Validate YAML parses** (`python3 -c "import yaml,glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]; print('ok')"` — fallback `bunx js-yaml`).
- [ ] **Step 3: Commit** `git add .github/workflows/test.yml && git commit -m "ci: e2e job running the Playwright suite on pull requests"`

---

### Task 7: Docs sync, spec amendment, and the full gate

**Files:**
- Modify: `apps/frontend/AGENTS.md` (e2e tense — it exists now), `AGENTS.md` (Commands → add e2e), `apps/backend/AGENTS.md` (note the e2e stack), `e2e/AGENTS.md` + `e2e/CLAUDE.md` (new), spec doc corrections

**Interfaces:**
- Consumes: everything above.
- Produces: accurate docs for the branch's final state.

- [ ] **Step 1:** In `apps/frontend/AGENTS.md`, change "end-to-end coverage will live in the repo-root `e2e/` workspace (Playwright), currently being built out." to "end-to-end coverage lives in the repo-root `e2e/` workspace (Playwright) — `bun run test:e2e` from the repo root (boots its own stack; run `bunx playwright install chromium` once)."
- [ ] **Step 2:** In root `AGENTS.md` `### Testing` block add:

```bash
bun run test:e2e           # Playwright end-to-end suite (boots its own backend on :3199)
```

- [ ] **Step 3:** Create `e2e/AGENTS.md` (keep ≤40 lines): what the suite covers, the single-origin stack (port 3199, temp dirs, stub `pi` via PI_PATH), the `workers: 1` file-ordering contract (01 creates the admin; `.auth/admin.json` handoff; terminal is canvas → assert server-side truth only), commands (`bun run test:e2e`, `test:e2e:ui`, `E2E_VERBOSE=1`). Then `e2e/CLAUDE.md` containing exactly `@AGENTS.md`.
- [ ] **Step 4: Amend the design spec** (`docs/superpowers/specs/2026-08-29-starter-structure-adoption-design.md`, Increment 2 section): replace "Unauthenticated visit redirects to login" with the implemented reality (API 401s + login page renders; no frontend guard exists), and the dummy-harness paragraph: profiles cannot carry a bash launch command — the harness registry has exactly four agent binaries, so the stack stubs the `pi` binary via `PI_PATH` (env-override detection) and sessions launch it through the real `env -i` path. Also record: terminal output is canvas-painted, so pane liveness is asserted via ws-token + /ws events and status chips.
- [ ] **Step 5: Full gate:** `bun run verify-types && bun run lint:check && bun run test && bun run test:e2e` — all green (e2e: 9 passed).
- [ ] **Step 6: Commit** `git add -A && git commit -m "docs: sync agent docs with the e2e workspace; amend spec to implemented behavior"`
