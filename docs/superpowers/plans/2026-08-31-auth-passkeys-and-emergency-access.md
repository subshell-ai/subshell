# Passkeys, Setup Password Confirm & Emergency Admin Login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add passkey sign-in (better-auth plugin) alongside passwords, a confirm-password field to the first-run wizard, and a break-glass `MOTE_EMERGENCY_PASSWORD` admin login with an all-users warning banner.

**Architecture:** Backend registers `@better-auth/passkey` in the existing `AUTH_OPTIONS` and extends the sign-in rate-limit wrapper with the break-glass credential rewrite (rewrite the admin's hash, then let better-auth's own verified sign-in path mint the session). Frontend adopts the better-auth client for all auth calls (new for passkey ceremonies, a migration for the five existing raw-`fetch` call sites) and adds a warning-tone banner in the shell driven by a flag on `GET /api/settings/public`.

**Tech Stack:** better-auth 1.7.1 + `@better-auth/passkey` 1.7.1 (server + client plugin), Elysia, Kysely/bun:sqlite (raw `sql` fragments against better-auth's camelCase tables), React 19 + TanStack Query, `bun test`, Playwright (repo-root `e2e/`).

**Spec:** `docs/superpowers/specs/2026-08-31-auth-passkeys-and-emergency-access-design.md`

## Global Constraints

- better-auth ecosystem pinned **exactly `1.7.1`** (backend already pins `better-auth` and `@better-auth/api-key`; every new dep matches). No `^`/`~` anywhere — pre-commit enforces pinning; after any `bun add` confirm the new package.json entries are exact strings.
- Bun only: `bun add` / `bun install` / `bunx`, never npm/npx.
- No dynamic imports (static top-level imports only).
- Every Elysia `t` schema property gets a `description`.
- Tests are `bun test` only; the suite DB is a per-process temp file — it is **never** the live instance's database, and all suites in one invocation share it (fixtures must use unique `crypto.randomUUID()` emails; suites must not assume an empty DB).
- Verification triad after every task that changes code: `bun run verify-types`, `bun run lint:check` (repo root), `bun run test`; plus `turbo build` whenever a backend route/schema changed (Eden Treaty infers from the built `App` type).
- Work happens in the worktree `/home/theo/projects/mote/.claude/worktrees/feat+auth-passkeys` (branch `worktree-feat+auth-passkeys`). Never start a server on the live instance's ports; manual server runs use `SERVER_PORT=3181`.

### Verified API surfaces (already checked against the installed 1.7.1 packages — trust these, don't re-derive)

- Server plugin: `import { passkey } from "@better-auth/passkey"` — options `rpID`, `rpName`, `origin`, `authenticatorSelection`, `advanced`, `schema`, `registration`, `authentication`. **No** `login:{enabled}` option; sign-in ships enabled. `registration.requireSession` defaults true. Endpoints: `GET /passkey/generate-register-options`, `GET /passkey/list-user-passkeys`, `POST /passkey/delete-passkey`, `POST /passkey/register`, `POST /passkey/authenticate`.
- Client plugin: `import { passkeyClient } from "@better-auth/passkey/client"` — actions `authClient.signIn.passkey({})` and `authClient.passkey.addPasskey({ name })`; error codes include `AUTH_CANCELLED`, `REGISTRATION_CANCELLED`.
- Sign-in verification compares `account.password` with the same hasher as `hashPassword` from `better-auth/crypto` (proven by `users.repository.ts` creating sign-in-able accounts). Account rows: table `account`, columns `userId`, `providerId` (literal `'credential'`), `password`, `updatedAt` — camelCase, addressed via raw `sql`.
- `error-banner.tsx` currently bakes `border-destructive`/`text-destructive` into the cva base string; Button has `outline` and `ghost` variants; `errMessage(err, fallback)` exists in `lib/api.ts`.

---

### Task 1: Setup wizard — confirm password

**Files:**
- Modify: `apps/frontend/src/routes/setup.tsx` (password field block at :115-125, submit button at :127-129, state block at :30-34)
- Modify: `e2e/tests/01-setup-wizard.spec.ts` (form-fill block at :10-14)

**Interfaces:**
- Consumes: nothing (leaf change).
- Produces: `#password-confirm` input id — the e2e spec and the manual checklist reference it.

- [ ] **Step 1: Update the e2e wizard spec (failing first)**

In `e2e/tests/01-setup-wizard.spec.ts`, replace:

```ts
  await page.fill("#password", ADMIN.password);
  await page.getByRole("button", { name: "Create admin account" }).click();
```

with:

```ts
  await page.fill("#password", ADMIN.password);
  // A typo in the confirmation must block submit (there is no password reset
  // until the break-glass hatch; the wizard is the one place that matters).
  await page.fill("#password-confirm", "typo-does-not-match");
  await page.locator("#password-confirm").blur();
  await expect(page.getByText("Passwords do not match")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create admin account" })).toBeDisabled();
  await page.fill("#password-confirm", ADMIN.password);
  await page.getByRole("button", { name: "Create admin account" }).click();
```

- [ ] **Step 2: Add the confirm field to the wizard**

In `apps/frontend/src/routes/setup.tsx`:

a) State — after `const [password, setPassword] = useState("");` (line ~32) add:

```ts
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmTouched, setConfirmTouched] = useState(false);
```

b) After the password `<div className="space-y-2">…</div>` block (ends line ~125) add:

```tsx
              <div className="space-y-2">
                <Label htmlFor="password-confirm">Confirm password</Label>
                <Input
                  id="password-confirm"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onBlur={() => setConfirmTouched(true)}
                />
                {confirmTouched && confirmPassword !== password && (
                  <p className="text-destructive text-sm">Passwords do not match</p>
                )}
              </div>
```

c) The submit Button (line ~127) gains the parity gate — while `confirmPassword` differs from `password` (including the empty initial state) it stays disabled:

```tsx
              <Button type="submit" className="w-full" disabled={busy || confirmPassword !== password}>
                {busy ? "Creating account…" : "Create admin account"}
              </Button>
```

No server change: registration stays `authClient.signUp.email` with the single `password` (this task precedes the client migration; still `fetch` here — Task 2 replaces it and touches nothing in this block).

- [ ] **Step 3: Verify**

Run: `bun run verify-types && bun run lint:check && bun run test` (repo root)
Expected: all pass. The e2e spec is NOT run here (Task 8 runs the suite once).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/routes/setup.tsx e2e/tests/01-setup-wizard.spec.ts
git commit -m "feat(setup): require password confirmation in the first-run wizard"
```

---

### Task 2: Frontend better-auth client — foundation + migrate the five call sites

**Files:**
- Modify: `apps/frontend/package.json` (new deps)
- Create: `apps/frontend/src/lib/auth-client.ts`
- Modify: `apps/frontend/src/lib/auth.ts:14-17` (getSessionUser)
- Modify: `apps/frontend/src/routes/login.tsx:32-54` (onSubmit)
- Modify: `apps/frontend/src/routes/setup.tsx:53-78` (register)
- Modify: `apps/frontend/src/routes/settings.tsx:36-72` (changePassword)
- Modify: `apps/frontend/src/components/app-sidebar.tsx` (signOut, ~line 42-49)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `authClient` (export const in `@/lib/auth-client`) — the ONLY better-auth surface Tasks 6–7 use (`authClient.signIn.passkey`, `authClient.passkey.addPasskey`, `authClient.getSession`, `authClient.signOut`, `authClient.$fetch`).

- [ ] **Step 1: Add pinned deps**

```bash
cd apps/frontend && bun add better-auth@1.7.1 @better-auth/passkey@1.7.1 && bunx syncpack fix && bun install && cd ../..
```

Expected: `apps/frontend/package.json` dependencies gain exactly `"better-auth": "1.7.1"` and `"@better-auth/passkey": "1.7.1"` (no prefixes; `syncpack fix` strips any `^`). If `syncpack fix` errors, fix the two entries by hand and re-run `bun install`.

- [ ] **Step 2: Create the client module**

Create `apps/frontend/src/lib/auth-client.ts`:

```ts
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

/**
 * The single better-auth browser client (spec 2026-08-31 §3). Every auth
 * call goes through it: migrated password sign-in/sign-up/change-password/
 * sign-out/get-session plus the passkey ceremonies (WebAuthn challenge
 * handling is exactly why the plugin exists — do not hand-roll it).
 *
 * baseURL defaults to `/api/auth`, which is correct under the Vite dev proxy
 * and same-origin in prod. Non-auth API traffic stays on apiFetch (lib/api).
 */
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
  fetchOptions: { credentials: "include" },
});
```

- [ ] **Step 3: Migrate `lib/auth.ts`**

Replace the `getSessionUser` body (keep `SessionUser` and `useCurrentUser` as-is, same query key `["current-user"]`):

```ts
import { authClient } from "@/lib/auth-client";

/**
 * Fetches the current session through the better-auth client.
 * Returns null when unauthenticated (401/403); other failures throw so the
 * query surfaces a real error instead of silently rendering signed-out.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const { data, error } = await authClient.getSession();
  if (error && error.status !== 401 && error.status !== 403) {
    throw new Error(error.message ?? "Session check failed");
  }
  const user = data?.user;
  return user ? { id: user.id, email: user.email, name: user.name ?? "" } : null;
}
```

Drop the now-unused `apiFetch` import from this file.

- [ ] **Step 4: Migrate `login.tsx` onSubmit**

Replace lines 36-47 (the `fetch("/api/auth/sign-in/email"…)` block) inside the existing try/catch:

```ts
      const { error: signInError } = await authClient.signIn.email({ email, password });
      if (signInError) {
        setError(signInError.message ?? "Sign-in failed");
        return;
      }
```

The wrapper's exponential backoff is timing-only (the response stays a plain 401), so the error-message path is unchanged. Add `import { authClient } from "@/lib/auth-client";`.

- [ ] **Step 5: Migrate `setup.tsx` register()**

Replace the fetch/response-parse block (lines 57-67) inside the existing try:

```ts
      const { error: signUpError } = await authClient.signUp.email({ name, email, password });
      if (signUpError) {
        setRegError(signUpError.message ?? "Registration failed");
        return;
      }
```

Keep the `queryClient.invalidateQueries({ queryKey: ["current-user"] })` + `setStep(1)` that follow, and add the `authClient` import.

- [ ] **Step 6: Migrate `settings.tsx` changePassword**

Replace lines 49-62 (fetch + `body?.details` handling) inside the existing try:

```ts
      const { error: pwError2 } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (pwError2) {
        const details = (pwError2 as unknown as { body?: { details?: unknown[] } }).body?.details;
        const detail = Array.isArray(details) && details.length > 0 ? String(details[0]) : null;
        setPwError(detail ?? "Password change failed — is the current password correct?");
        return;
      }
```

(The local state setter is also named `setPwError`; the destructure is named `pwError2` to avoid shadowing the state value `pwError` — keep that name.) Add the `authClient` import.

- [ ] **Step 7: Migrate sign-out in `app-sidebar.tsx`**

Replace the fetch at ~line 45:

```ts
    await authClient.signOut();
```

Keep the try/catch ("expired session — still clear client state") and the `window.location.href = "/login"`. Add the `authClient` import.

Then confirm no other raw auth fetches remain:

```bash
grep -rn "api/auth/" apps/frontend/src --include="*.tsx" --include="*.ts" | grep -v "lib/auth" | grep fetch
```

Expected: no output (if a mobile drawer file appears with a sign-out fetch, migrate it identically).

- [ ] **Step 8: Verify**

Run: `bun run verify-types && bun run lint:check && bun run test`
Expected: all pass (existing frontend unit tests keep green — `lib/auth.ts` has no direct test; behavior is identical).

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/package.json bun.lock apps/frontend/src
git commit -m "refactor(frontend): route all auth calls through the better-auth client"
```

---

### Task 3: Backend passkey plugin

**Files:**
- Modify: `apps/backend/package.json` (new dep)
- Modify: `apps/backend/src/auth.ts` (imports at top, `plugins` array at :52-61)
- Test: `apps/backend/src/__tests__/passkey-plugin.test.ts` (create)

**Interfaces:**
- Consumes: `setupAuthTables`/`signIn` helpers, `auth` singleton.
- Produces: `passkey` table + `/api/auth/passkey/*` endpoints — Task 7's frontend UI and Task 8's manual ceremony depend on these.

- [ ] **Step 1: Add the pinned dep**

```bash
cd apps/backend && bun add @better-auth/passkey@1.7.1 && bunx syncpack fix && bun install && cd ../..
```

Expected: exact `"@better-auth/passkey": "1.7.1"` in `apps/backend/package.json` dependencies.

- [ ] **Step 2: Write the failing integration test**

Create `apps/backend/src/__tests__/passkey-plugin.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sql } from "kysely";
import { signIn, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

/**
 * Server-side passkey plugin (spec 2026-08-31 §4): the migration chain must
 * create the plugin table, and the better-auth handler must expose the
 * registration-options endpoint. The WebAuthn ceremony itself is browser
 * territory — verified manually (Task 8); this pins the server half.
 */
describe("passkey plugin (server)", () => {
  const password = "passkey-test-pass-1";
  let email = "";
  let token = "";

  beforeAll(async () => {
    await setupAuthTables();
    email = `passkey-${crypto.randomUUID()}@mote.local`;
    await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    token = await signIn(email, password);
  });

  it("runAuthMigrations creates the passkey table", async () => {
    const { rows } = await sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'passkey'
    `.execute(db);
    expect(rows).toHaveLength(1);
  });

  it("generate-register-options refuses an anonymous request", async () => {
    const res = await auth.handler(
      new Request("http://localhost:3080/api/auth/passkey/generate-register-options", {
        headers: { origin: "http://localhost:5173" },
      }),
    );
    expect([401, 403]).toContain(res.status);
  });

  it("generate-register-options returns WebAuthn options for a session", async () => {
    const res = await auth.handler(
      new Request("http://localhost:3080/api/auth/passkey/generate-register-options", {
        headers: { origin: "http://localhost:5173", cookie: `better-auth.session_token=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge?: string; rp?: { name?: string } };
    expect(typeof body.challenge).toBe("string");
    expect(body.rp?.name).toBe("mote");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/backend && bun test src/__tests__/passkey-plugin.test.ts`
Expected: FAIL — passkey table missing (`toHaveLength(1)` gets 0) and endpoints 404.

- [ ] **Step 4: Register the plugin**

In `apps/backend/src/auth.ts`: add the import beside the existing one (line 1):

```ts
import { passkey } from "@better-auth/passkey";
```

and append to the `plugins` array after `apiKey({...})`:

```ts
    // Passkeys (spec 2026-08-31): additional browser credential, never a
    // second factor. rpID is deliberately unset — better-auth derives it from
    // the request host, so loopback AND the NetBird domain each own their
    // passkeys (a per-origin reality, stated in the UI copy). origin unset
    // likewise: the client supplies it (1.7.1 documented default).
    passkey({ rpName: "mote" }),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/backend && bun test src/__tests__/passkey-plugin.test.ts`
Expected: 3 pass. If `generate-register-options` needs POST instead of GET, adjust the test to the method the 1.7.1 dist implements (`grep -n "generate-register-options" -A3` in the installed package shows the method) — do NOT change the server.

- [ ] **Step 6: Full verification + build (auth tables changed → rebuild dependents)**

Run: `bun run verify-types && bun run lint:check && bun run test && turbo build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/package.json bun.lock apps/backend/src/auth.ts apps/backend/src/__tests__/passkey-plugin.test.ts
git commit -m "feat(auth): register the better-auth passkey plugin"
```

---

### Task 4: Emergency admin login — break-glass credential rewrite

**Files:**
- Modify: `apps/backend/src/constants.ts` (add near `AUTH_SECRET`, ~line 145)
- Modify: `apps/backend/.env.example` (append)
- Modify: `apps/backend/src/api/auth-rate-limit.route.ts`
- Test: `apps/backend/src/api/__tests__/emergency-login.test.ts` (create)

**Interfaces:**
- Consumes: `db` singleton, `hashPassword`, `UsersRepository` (tests).
- Produces: `emergencyPassword(): string` from `@/constants.js` (empty = disarmed) — Task 5 reads it for the public flag.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/api/__tests__/emergency-login.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { deleteUserByEmailOrId, setupAuthTables } from "./helpers/auth-tables.js";

/**
 * Break-glass admin login (spec 2026-08-31 §6). The wrapper sits ahead of
 * better-auth and rewrites an ADMIN's credential hash when the submitted
 * password equals MOTE_EMERGENCY_PASSWORD exactly — better-auth then mints a
 * real session through its own verified path. Non-matches, non-admins and
 * unknown emails must be indistinguishable from a normal bad-password 401
 * (no signal about which half failed), and the rewrite must be destructive
 * only for the account it approves.
 *
 * Fresh fixture users per test + a cleared authAttempts row between attempts:
 * the wrapper sleeps 2^n after failures, and the suite DB is shared, so
 * emails carry crypto.randomUUID() suffixes and counters are wiped inline.
 */
const ENV = "MOTE_EMERGENCY_PASSWORD";
const ENV_VALUE = "break-glass-value-9";
const OLD_ADMIN_PASS = "old-admin-pass-123";
const USER_PASS = "plain-user-pass-123";

function signInRaw(email: string, password: string): Promise<Response> {
  return authRateLimitRoutes.fetch(
    new Request("http://localhost:3080/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password }),
    }),
  );
}

describe("emergency admin login (MOTE_EMERGENCY_PASSWORD)", () => {
  const repo = new UsersRepository(db);
  const created: { email: string }[] = [];
  let savedEnv: string | undefined;

  beforeAll(async () => {
    await setupAuthTables();
    savedEnv = process.env[ENV];
  });

  afterAll(async () => {
    for (const { email } of created) await deleteUserByEmailOrId(email);
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  async function makeUser(role: "admin" | "user", password: string): Promise<string> {
    const email = `emergency-${role}-${crypto.randomUUID()}@mote.local`;
    await repo.createUser({ email, passwordHash: await hashPassword(password), role });
    created.push({ email });
    return email;
  }

  /** No backoff sleep before the next attempt for this email. */
  async function clearAttempts(email: string): Promise<void> {
    await db.deleteFrom("authAttempts").where("email", "=", email).execute();
  }

  it("armed: admin signs in with the env value and gets a session cookie", async () => {
    process.env[ENV] = ENV_VALUE;
    const email = await makeUser("admin", OLD_ADMIN_PASS);
    const res = await signInRaw(email, ENV_VALUE);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });

  it("armed: a successful emergency login destroys the old password", async () => {
    process.env[ENV] = ENV_VALUE;
    const email = await makeUser("admin", OLD_ADMIN_PASS);
    expect((await signInRaw(email, ENV_VALUE)).status).toBe(200);
    await clearAttempts(email);
    expect((await signInRaw(email, OLD_ADMIN_PASS)).status).toBe(401);
  });

  it("armed: a non-admin submitting the env value gets the plain 401 and keeps its password", async () => {
    process.env[ENV] = ENV_VALUE;
    const email = await makeUser("user", USER_PASS);
    expect((await signInRaw(email, ENV_VALUE)).status).toBe(401);
    await clearAttempts(email);
    expect((await signInRaw(email, USER_PASS)).status).toBe(200);
  });

  it("unarmed: the env value is just a wrong password", async () => {
    delete process.env[ENV];
    const email = await makeUser("admin", OLD_ADMIN_PASS);
    expect((await signInRaw(email, ENV_VALUE)).status).toBe(401);
  });

  it("armed: unknown email + env value behaves like a bad password", async () => {
    process.env[ENV] = ENV_VALUE;
    const res = await signInRaw(`ghost-${crypto.randomUUID()}@mote.local`, ENV_VALUE);
    expect(res.status).toBe(401);
  });
});
```

Run: `cd apps/backend && bun test src/api/__tests__/emergency-login.test.ts`
Expected: FAIL — the first test gets 401 (no rewrite logic yet).

- [ ] **Step 2: Add the env accessor**

In `apps/backend/src/constants.ts`, after the `AUTH_SECRET` block:

```ts
/**
 * Break-glass admin password (spec 2026-08-31 §6). Empty/absent ⇒ the hatch
 * is disarmed and sign-in behaves normally.
 *
 * A live read (function, not a module constant) on purpose: tests arm and
 * disarm between cases, and an operator flipping the var needs only the
 * restart they were going to do anyway. The banner (via the public-settings
 * flag) is the guard — this is an operator feature, so no prod boot-guard.
 */
export function emergencyPassword(): string {
  return process.env.MOTE_EMERGENCY_PASSWORD ?? "";
}
```

- [ ] **Step 3: Implement the rewrite in the sign-in wrapper**

In `apps/backend/src/api/auth-rate-limit.route.ts`: add imports at the top:

```ts
import { hashPassword } from "better-auth/crypto";
import { emergencyPassword } from "@/constants.js";
```

above `authRateLimitRoutes` add:

```ts
/**
 * Break-glass admin login (spec 2026-08-31 §6): when MOTE_EMERGENCY_PASSWORD
 * is set and the submitted password equals it EXACTLY for an existing account
 * whose user_meta role is "admin", overwrite that account's credential hash
 * with the env value's hash. The caller then forwards the ordinary sign-in:
 * better-auth verifies the value just stored and mints a REAL session
 * through its own path — nothing is forged.
 *
 * The overwrite is destructive by design (the forgotten password dies the
 * moment the hatch fires); the armed-state banner tells the admin to set a
 * new password before clearing the env var. Non-admin/mismatch/unknown-email
 * return false without touching anything, so the response stays an ordinary
 * bad-password 401 — no signal about which half failed.
 *
 * Raw SQL on purpose: better-auth owns `user`/`account`/`user_meta` targets
 * (camelCase columns outside the typed Database) — same precedent as
 * UsersRepository.createUser.
 *
 * @param email - normalized (lowercased, trimmed) sign-in email
 * @param password - the submitted password, compared to the env value
 * @returns true when the credential was rewritten (emergency login approved)
 */
async function rewriteAdminCredentialToEnvPassword(email: string, password: string): Promise<boolean> {
  const envValue = emergencyPassword();
  if (!envValue || !email || password !== envValue) return false;
  const found = await sql<{ id: string; role: string | null }>`
    SELECT u.id, m.role
    FROM user u
    LEFT JOIN user_meta m ON m.user_id = u.id
    WHERE u.email = ${email}
  `.execute(db);
  const row = found.rows[0];
  if (!row || row.role !== "admin") return false;
  await sql`
    UPDATE account
    SET password = ${await hashPassword(envValue)}, "updatedAt" = ${new Date().toISOString()}
    WHERE userId = ${row.id} AND providerId = 'credential'
  `.execute(db);
  return true;
}
```

and inside the route handler, directly AFTER the backoff delay line (`if (delay) await Bun.sleep(delay);`) and BEFORE building `forwarded`:

```ts
    // Hatch attempts share the ordinary backoff: the delay above already
    // applied to them. A rewrite here is invisible to the client — the
    // forwarded body is unchanged (password === env value) and better-auth's
    // success path (cookie + attempt-clear below) does the rest.
    await rewriteAdminCredentialToEnvPassword(email, body.password ?? "");
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/backend && bun test src/api/__tests__/emergency-login.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Document the env var**

Append to `apps/backend/.env.example`:

```
# Break-glass admin login (temporary!). While set, ANY admin account can sign
# in with this exact value as its password, which OVERWRITES its stored
# password. The UI shows a loud warning banner while armed. Use it only to
# recover a forgotten admin password: sign in, Settings → Change password (the
# current password you type is this value), then delete this line and restart.
MOTE_EMERGENCY_PASSWORD=
```

- [ ] **Step 6: Full verification + build**

Run: `bun run verify-types && bun run lint:check && bun run test && turbo build`
Expected: all pass (the existing rate-limit suite still passes — passthrough behavior is untouched when unarmed).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/constants.ts apps/backend/src/api/auth-rate-limit.route.ts apps/backend/src/api/__tests__/emergency-login.test.ts apps/backend/.env.example
git commit -m "feat(auth): break-glass admin login via MOTE_EMERGENCY_PASSWORD"
```

---

### Task 5: Public settings — `emergencyLoginActive` flag

**Files:**
- Modify: `apps/backend/src/api/settings.route.ts:7-34`
- Test: `apps/backend/src/api/__tests__/settings-route.test.ts` (extend)

**Interfaces:**
- Consumes: `emergencyPassword()` (Task 4).
- Produces: `GET /api/settings/public` → `{ allowRegistrations: boolean, emergencyLoginActive: boolean }` — Task 6's banner query key `["settings-public"]` fetches exactly this.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("settings routes (admin cookie only)")` in `apps/backend/src/api/__tests__/settings-route.test.ts` (it already has an in-scope `app` composed with `settingsRoutes`):

```ts
  it("GET /public reports emergencyLoginActive around the env var", async () => {
    type Public = { allowRegistrations: boolean; emergencyLoginActive: boolean };
    const saved = process.env.MOTE_EMERGENCY_PASSWORD;
    try {
      delete process.env.MOTE_EMERGENCY_PASSWORD;
      const off = (await (
        await app.fetch(new Request("http://localhost:3080/api/settings/public"))
      ).json()) as Public;
      expect(off.emergencyLoginActive).toBe(false);
      process.env.MOTE_EMERGENCY_PASSWORD = "armed-for-test";
      const on = (await (await app.fetch(new Request("http://localhost:3080/api/settings/public"))).json()) as Public;
      expect(on.emergencyLoginActive).toBe(true);
      expect(on.allowRegistrations).toBe(off.allowRegistrations);
    } finally {
      if (saved === undefined) delete process.env.MOTE_EMERGENCY_PASSWORD;
      else process.env.MOTE_EMERGENCY_PASSWORD = saved;
    }
  });
```

Run: `cd apps/backend && bun test src/api/__tests__/settings-route.test.ts`
Expected: FAIL — `emergencyLoginActive` is `undefined`, not `false`.

- [ ] **Step 2: Implement**

In `apps/backend/src/api/settings.route.ts`: add the import `import { emergencyPassword } from "@/constants.js";`, and define a public-only response schema next to `SettingsSchema`:

```ts
/** Public read gains the break-glass flag (spec 2026-08-31 §6) — it leaks
 * only that the hatch is armed, which the banner itself broadcasts. */
const PublicSettingsSchema = t.Object({
  allowRegistrations: t.Boolean({ description: "Whether new users can register" }),
  emergencyLoginActive: t.Boolean({
    description: "True while MOTE_EMERGENCY_PASSWORD is set (break-glass admin login armed; drives the warning banner)",
  }),
});
```

Change ONLY the `/public` route: `return { allowRegistrations: allow, emergencyLoginActive: emergencyPassword() !== "" } as const;` and `response: PublicSettingsSchema`. GET `/` and PATCH `/` keep `SettingsSchema` untouched.

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd apps/backend && bun test src/api/__tests__/settings-route.test.ts`
Expected: all pass.

- [ ] **Step 4: Full verification + build**

Run: `bun run verify-types && bun run lint:check && bun run test && turbo build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/api/settings.route.ts apps/backend/src/api/__tests__/settings-route.test.ts
git commit -m "feat(settings): expose emergencyLoginActive on the public settings read"
```

---

### Task 6: Warning-tone banner in the app shell

**Files:**
- Modify: `apps/frontend/src/components/error-banner.tsx` (cva: add a `tone` axis)
- Create: `apps/frontend/src/components/emergency-login-banner.tsx`
- Modify: `apps/frontend/src/routes/__root.tsx:86-99` (render in the frame)
- Test: `apps/frontend/src/components/__tests__/emergency-login-banner.test.tsx` (create)

**Interfaces:**
- Consumes: `["settings-public"]` shape from Task 5 via `apiFetch`.
- Produces: `EmergencyLoginBanner` component + `tone="warning"` on `ErrorBanner` (existing `danger` usage is the default and stays source-compatible).

- [ ] **Step 1: Write the failing component test**

Create `apps/frontend/src/components/__tests__/emergency-login-banner.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { EmergencyLoginBanner } from "@/components/emergency-login-banner";

/**
 * The banner is data-driven: it renders the alert ONLY from a seeded cache
 * entry (the same key the shell's query uses), so no fetch happens here.
 */
function renderWithCache(active: boolean) {
  const qc = new QueryClient();
  qc.setQueryData(["settings-public"], { allowRegistrations: false, emergencyLoginActive: active });
  render(
    <QueryClientProvider client={qc}>
      <EmergencyLoginBanner />
    </QueryClientProvider>,
  );
}

describe("EmergencyLoginBanner", () => {
  afterEach(cleanup);

  it("shows the alert while the hatch is armed", () => {
    renderWithCache(true);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Emergency admin login is enabled");
  });

  it("renders nothing while disarmed", () => {
    renderWithCache(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
```

Run: `cd apps/frontend && bun test src/components/__tests__/emergency-login-banner.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 2: Add the `tone` axis to ErrorBanner**

In `apps/frontend/src/components/error-banner.tsx`, move the colors out of the base string into a variant axis (danger keeps today's look exactly):

```ts
const errorBannerVariants = cva("flex items-center bg-terminal-strip text-xs", {
  variants: {
    variant: {
      bar: "justify-between gap-2 border-b px-3 py-1.5",
      floating: "fixed top-16 left-1/2 z-[110] -translate-x-1/2 rounded-md border px-3 py-1.5 shadow-lg",
    },
    tone: {
      danger: "border-destructive text-destructive",
      // Amber, deliberately NOT destructive: the break-glass hatch is a
      // warned-about operator state, not a request failure.
      warning: "border-amber-500/70 text-amber-600 dark:text-amber-400",
    },
  },
  defaultVariants: {
    variant: "bar",
    tone: "danger",
  },
});
```

`ErrorBannerProps` already extends `VariantProps<typeof errorBannerVariants>`, so `tone` flows through; keep everything else (the component signature stays `{ variant = "bar", message, action, className }` — `tone` is picked up via the variants props automatically; pass it through: `errorBannerVariants({ variant, tone })` — destructure `tone` with no default so the cva default applies:

```tsx
export function ErrorBanner({ variant = "bar", tone, message, action, className }: ErrorBannerProps) {
  return (
    <div role="alert" className={cn(errorBannerVariants({ variant, tone }), className)}>
```

- [ ] **Step 3: Create the banner component**

Create `apps/frontend/src/components/emergency-login-banner.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { ErrorBanner } from "@/components/error-banner";
import { apiFetch } from "@/lib/api";

/** Public settings shape — only the fields the shell observes. */
interface PublicSettings {
  /** Kept for the shared cache shape; unused here */
  allowRegistrations: boolean;
  /** True while MOTE_EMERGENCY_PASSWORD is set (spec 2026-08-31 §6) */
  emergencyLoginActive: boolean;
}

/**
 * Non-dismissible amber alert shown to EVERY signed-in user while the
 * break-glass admin password is armed: the instance currently has a
 * backdoor credential, which is everyone's business, not just the admin's.
 * Not dismissible by design — the fix is server-side (change password,
 * clear the env var, restart).
 *
 * staleTime 30 s mirrors the current-user freshness: after the operator
 * clears the var and restarts, the banner retires on the next mount within
 * the window without any manual reload, and the endpoint is local + cheap.
 */
export function EmergencyLoginBanner() {
  const { data } = useQuery({
    queryKey: ["settings-public"],
    queryFn: () => apiFetch<PublicSettings>("/api/settings/public"),
    staleTime: 30_000,
  });
  if (!data?.emergencyLoginActive) return null;
  return (
    <ErrorBanner
      tone="warning"
      message="Emergency admin login is enabled. Admins should set a new password now (Settings → Change password), then remove MOTE_EMERGENCY_PASSWORD and restart the server."
    />
  );
}
```

- [ ] **Step 4: Render it in the shell**

In `apps/frontend/src/routes/__root.tsx`: import `EmergencyLoginBanner` and make it the first child inside the frame div (line ~90, before `{!wide && !bare && <MobileTopBar />}`):

```tsx
      {user && <EmergencyLoginBanner />}
```

Signed-in only (the pre-auth wizard/login pages are the lockout surface itself — no banner there), and above the top bar so it spans the full width.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/frontend && bun test src/components/__tests__/emergency-login-banner.test.tsx`
Expected: 2 pass.

- [ ] **Step 6: Full verification**

Run: `bun run verify-types && bun run lint:check && bun run test`
Expected: all pass (existing ErrorBanner call sites keep compiling — `tone` is optional).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/components/error-banner.tsx apps/frontend/src/components/emergency-login-banner.tsx apps/frontend/src/components/__tests__/emergency-login-banner.test.tsx apps/frontend/src/routes/__root.tsx
git commit -m "feat(frontend): warning banner while emergency admin login is armed"
```

---

### Task 7: Passkey UI — login button + Settings card

**Files:**
- Modify: `apps/frontend/src/routes/login.tsx` (passkey button after the form)
- Create: `apps/frontend/src/components/passkeys-card.tsx`
- Modify: `apps/frontend/src/routes/settings.tsx` (mount the card)

**Interfaces:**
- Consumes: `authClient` with `passkeyClient()` (Task 2), `/api/auth/passkey/*` endpoints (Task 3), `apiFetch`/`errMessage` (`lib/api.ts`), Card/Input/Button/Label/ErrorBanner primitives.
- Produces: manual-check surface for Task 8.

- [ ] **Step 1: Add the passkey sign-in button to the login page**

In `apps/frontend/src/routes/login.tsx`, after `onSubmit` add:

```ts
  async function signInWithPasskey() {
    setBusy(true);
    setError(null);
    try {
      const { error: pkError } = await authClient.signIn.passkey({});
      if (pkError) {
        const code = (pkError as unknown as { code?: string }).code;
        // Dismissing the platform chooser is a cancel, not an app failure.
        if (code !== "AUTH_CANCELLED") setError(pkError.message ?? "Passkey sign-in failed");
        return;
      }
      window.location.href = redirect ?? "/";
    } finally {
      setBusy(false);
    }
  }
```

and after the closing `</form>` (inside the same `CardContent`) a clearly secondary affordance:

```tsx
          <div className="mt-4">
            <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void signInWithPasskey()}>
              Sign in with a passkey
            </Button>
            <p className="mt-2 text-muted-foreground text-xs">
              Passkeys are tied to this address (origin) and device — register one here and, if you use the
              NetBird domain, another there.
            </p>
          </div>
```

(`authClient` is already imported from Task 2.)

- [ ] **Step 2: Create the Passkeys card**

Create `apps/frontend/src/components/passkeys-card.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, errMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/** A registered passkey as returned by better-auth's list endpoint. */
interface PasskeyRow {
  /** Delete handle */
  id: string;
  /** User-supplied label */
  name?: string | null;
  /** ISO 8601 registration time (unused; kept honest with the payload) */
  createdAt?: string;
}

/**
 * Self-service passkeys (spec 2026-08-31 §4): every signed-in user manages
 * their OWN credentials here. The WebAuthn ceremony (add) goes through the
 * better-auth client plugin — challenge encoding is its job. The plain JSON
 * list/delete endpoints stay on apiFetch, matching every other same-origin
 * read in the app.
 */
export function PasskeysCard() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: passkeys, isError: listError, refetch } = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => apiFetch<PasskeyRow[]>("/api/auth/passkey/list-user-passkeys"),
  });

  async function addPasskey() {
    setBusy(true);
    setError(null);
    try {
      const { error: addErr } = await authClient.passkey.addPasskey(name.trim() ? { name: name.trim() } : {});
      if (addErr) {
        const code = (addErr as unknown as { code?: string }).code;
        if (code !== "REGISTRATION_CANCELLED") setError(addErr.message ?? "Couldn't register the passkey");
        return;
      }
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await apiFetch("/api/auth/passkey/delete-passkey", { method: "POST", body: JSON.stringify({ id }) });
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    } catch (err) {
      setError(errMessage(err, "Couldn't delete the passkey."));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>
          Sign in without a password. A passkey belongs to this browser on this address — register one per origin
          you use, and on each device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-2">
            <Label htmlFor="passkey-name">Passkey name</Label>
            <Input
              id="passkey-name"
              value={name}
              placeholder="e.g. MacBook Touch ID"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button onClick={() => void addPasskey()} disabled={busy}>
            {busy ? "Waiting for device…" : "Add passkey"}
          </Button>
        </div>
        {listError ? (
          <ErrorBanner
            message="Couldn't load passkeys."
            className="rounded-md border"
            action={
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-inherit text-xs underline"
                onClick={() => void refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : (passkeys?.length ?? 0) === 0 ? (
          <p className="text-muted-foreground text-sm">No passkeys yet.</p>
        ) : (
          <ul className="space-y-1">
            {passkeys?.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{p.name || "Unnamed passkey"}</span>
                <Button variant="ghost" size="sm" onClick={() => void remove(p.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </CardContent>
    </Card>
  );
}
```

If `apiFetch`'s JSON parse trips on the delete response, check the endpoint's body shape first (`curl` in Task 8's session) — better-auth returns the deleted passkey object, which parses fine.

- [ ] **Step 3: Mount it on the Settings page**

In `apps/frontend/src/routes/settings.tsx`: import `PasskeysCard` and render it directly after the `SystemApiKeysCard` line (152):

```tsx
      <PasskeysCard />
```

(The card is self-service for ANY signed-in user — it reads/writes only the caller's own passkeys via better-auth's session — so it sits above the admin-scoped cards' concerns even on this mostly-admin page.)

- [ ] **Step 4: Verify**

Run: `bun run verify-types && bun run lint:check && bun run test`
Expected: all pass. (The real ceremony is verified live in Task 8 — Playwright virtual-authenticator e2e was judged best-effort in the spec and is deliberately NOT part of this plan.)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/routes/login.tsx apps/frontend/src/components/passkeys-card.tsx apps/frontend/src/routes/settings.tsx
git commit -m "feat(frontend): passkey sign-in button and Settings passkeys card"
```

---

### Task 8: Full verification, e2e run, and the live manual checklist

**Files:** none created (verification task). Commit any fixes under their own messages.

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Repo-wide gates**

Run: `bun run verify-types && bun run lint:check && bun run test && turbo build`
Expected: all green.

- [ ] **Step 2: E2E suite**

Run: `bun run test:e2e` (repo root; needs tmux + `bunx playwright install chromium` once)
Expected: all specs green — `01-setup-wizard` exercises the new confirm field AND the client-migrated sign-up/login/logout paths; `00-smoke` still sees no banner (flag false); `10-auth-experience` still passes (guard untouched).

- [ ] **Step 3: Live manual check — passkeys (own DB, own port; the live instance is never touched)**

```bash
cd apps/backend
rm -f ./data/worktree-auth.db*
SERVER_PORT=3181 HOST=127.0.0.1 DATABASE_PATH=./data/worktree-auth.db APP_BASE_URL=http://127.0.0.1:3181 bun run dev
```

(Use `!`-prefixed commands or a second terminal if the harness cannot hold a dev server.) In a browser at `http://127.0.0.1:3181`:

1. First-run wizard: type mismatched confirmation → button stays disabled + "Passwords do not match" after blur; matching → account created (first user = admin).
2. Settings → Passkeys: add a passkey (Touch ID / phone / Windows Hello prompt appears), it lists with the chosen name.
3. Logout → "Sign in with a passkey" → platform prompt → lands on `/`.
4. Remove the passkey in Settings; the login page's passkey sign-in now errors or finds no credential (expected — passkeys were origin/device-bound to that registration).

- [ ] **Step 4: Live manual check — break-glass hatch**

With the same worktree DB, restart the server armed:

```bash
SERVER_PORT=3181 HOST=127.0.0.1 DATABASE_PATH=./data/worktree-auth.db APP_BASE_URL=http://127.0.0.1:3181 MOTE_EMERGENCY_PASSWORD=break-glass-run-9 bun run dev
```

1. Amber banner renders at the top for the signed-in admin; a second (non-admin, created via Users page) account also sees it.
2. Sign out; sign in as the admin with their OLD password → 401. Sign in with the env value → success (banner still up).
3. Settings → Change password: current = `break-glass-run-9`, new = something else → saved.
4. Sign out → sign in with the NEW password → success. Env value now rejected (old-credential rewrite is per-login attempt, not a second password).
5. Restart unarmed (no env var): banner gone; `GET /api/settings/public` shows `"emergencyLoginActive":false`.
6. Shut the server down.

- [ ] **Step 5: Docs touch-up (behavior the repo docs state changes)**

If any statement in `apps/backend/AGENTS.md` / `.claude/rules/security-context.md` now reads inaccurately (auth kinds = "email/password + bearer keys"; add passkeys + the break-glass hatch to the Authentication list, one or two lines each), update them in the same style as the surrounding text and commit:

```bash
git add apps/backend/AGENTS.md .claude/rules/security-context.md
git commit -m "docs: record passkeys and the emergency admin login in the auth posture"
```

---

## Plan self-review notes

- Spec coverage: §3 client migration → Task 2; §4 server → Task 3; §4 UI → Task 7; §5 confirm → Task 1; §6 hatch → Tasks 4–6; §7 tests → per-task + Task 8; §8 out-of-scope respected (no mail flow, no 2FA, no mobile, no better-auth-ui dep removal).
- The e2e wizard change (Task 1) and the login/logout migration (Task 2) are both verified by the single e2e run in Task 8 (workers: 1; the suite boots its own backend).
- `error-banner` tone default keeps every existing call site source-compatible (verified: only `variant`/`message`/`action`/`className` are passed today).
