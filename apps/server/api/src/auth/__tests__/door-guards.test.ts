import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { seedLocalPluginsForTests } from "@/api/__tests__/helpers/auth-tables.js";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { createDoorGuardBeforeHook } from "@/auth/door-guards.js";
import { getAuth, setAuthPolicyDb } from "@/auth.js";
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";

/**
 * The E-mail door guard (spec 2026-09-24 §7) and the MEASUREMENT that fixes
 * its role.
 *
 * Measured on the installed better-auth 1.7.1 (`dist/api/routes/sign-in.mjs`
 * carries no `assertValidUserInfo` call; the util's importers are
 * `internal-adapter.mjs`, `oauth2/link-account.mjs` and
 * `api/routes/callback.mjs`): `user.validateUserInfo` fires for FOUR seams
 * only — email-password CREATE (sign-up), OAuth create, OAuth link, OAuth
 * repeat sign-in. It never fires for `/sign-in/email` or
 * `/passkey/verify-authentication`. So for a closed E-mail door at SIGN-IN
 * this hooks.before guard is the load-bearing server-side refusal — not a
 * redundancy beside validateUserInfo. (The runtime proof is below: a closed
 * door answers 403 on the real handler with a CORRECT password.)
 */

const email = `guarded-${crypto.randomUUID()}@subshell.local`;
const password = "guarded-pass-1";

async function setEmailSignIn(on: boolean): Promise<void> {
  await new AuthProvidersRepository(db).update("email", { signInEnabled: on ? 1 : 0 });
}

async function signInRequest(): Promise<Response> {
  return authRateLimitRoutes.fetch(
    new Request("http://localhost:3080/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password }),
    }),
  );
}

beforeAll(async () => {
  await runMigrations();
  await runAuthMigrations();
  setAuthPolicyDb(db);
  await seedLocalPluginsForTests();
  // The user must exist with a working credential while the door is open,
  // so the refused case below cannot be confused with a wrong-password 401.
  await setEmailSignIn(true);
  const reg = new AuthProvidersRepository(db);
  const stored = (await reg.getById("email"))?.registrationEnabled;
  try {
    await reg.update("email", { registrationEnabled: 1 });
    const res = await getAuth().handler(
      new Request("http://localhost:3080/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({ email, password, name: "Guarded" }),
      }),
    );
    expect(res.status).toBe(200);
  } finally {
    await reg.update("email", { registrationEnabled: stored ?? null });
  }
});

afterAll(async () => {
  await setEmailSignIn(true);
  await sql`DELETE FROM user WHERE email = ${email}`.execute(db);
  await sql`DELETE FROM auth_attempts WHERE email = ${email}`.execute(db);
});

describe("doorGuardBeforeHook (unit)", () => {
  test("a closed E-mail row refuses both sign-in paths with a 403", async () => {
    const hook = createDoorGuardBeforeHook(() => db);
    await setEmailSignIn(false);
    try {
      for (const path of ["/sign-in/email", "/passkey/verify-authentication"]) {
        const err = await hook({ path }).catch((e: unknown) => e);
        expect(err).toBeTruthy();
        // better-call's APIError: numeric status is stored verbatim and
        // mirrored to `statusCode` when it is a number (error.d.mjs ctor).
        const apiErr = err as { statusCode?: number; body?: { message?: string }; name?: string };
        expect(apiErr.name).toBe("APIError");
        expect(apiErr.statusCode).toBe(403);
        expect(String(apiErr.body?.message ?? "")).toContain("disabled");
      }
    } finally {
      await setEmailSignIn(true);
    }
  });

  test("an open door passes every path through untouched, and so does an unreadable db", async () => {
    const hook = createDoorGuardBeforeHook(() => db);
    await expect(hook({ path: "/sign-in/email" })).resolves.toBeUndefined();
    await expect(hook({ path: "/sign-up/email" })).resolves.toBeUndefined();
    await expect(hook({ path: "/session" })).resolves.toBeUndefined();
    const noDb = createDoorGuardBeforeHook(() => undefined);
    await setEmailSignIn(false);
    try {
      await expect(noDb({ path: "/sign-in/email" })).resolves.toBeUndefined(); // pre-boot gap
    } finally {
      await setEmailSignIn(true);
    }
  });

  test("an absent email row (pre-migration db) is not a closed door", async () => {
    const empty = createDoorGuardBeforeHook(() => undefined);
    // `undefined` models the gap; the absent-ROW case is the same answer
    // through the repository: getById finds nothing, `=== 0` never holds.
    await expect(empty({ path: "/sign-in/email" })).resolves.toBeUndefined();
  });
});

describe("door guard on the real handler (HTTP)", () => {
  test("a closed E-mail door answers 403 on the CORRECT password", async () => {
    await setEmailSignIn(false);
    try {
      const res = await signInRequest();
      expect(res.status).toBe(403);
      const body = (await res.json()) as { message?: string; error?: { message?: string } };
      expect(String(body.message ?? body.error?.message ?? "")).toContain("disabled");
    } finally {
      await setEmailSignIn(true);
    }
  });

  test("the open door signs the same credential in (the guard is not a blanket denial)", async () => {
    const res = await signInRequest();
    expect(res.status).toBe(200);
  });

  test("a closed registration door refuses sign-up at the SERVER with 403 registration_closed", async () => {
    // The seam-shift proof: the refusal moved from `user.create.before`
    // (a silent false) to validateUserInfo — and it still refuses at the
    // server, now with a machine-readable code.
    const reg = new AuthProvidersRepository(db);
    const stored = (await reg.getById("email"))?.registrationEnabled;
    await reg.update("email", { registrationEnabled: 0 });
    try {
      const res = await getAuth().handler(
        new Request("http://localhost:3080/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:5173" },
          body: JSON.stringify({ email: `signup-refused-${crypto.randomUUID()}@subshell.local`, password, name: "x" }),
        }),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("registration_closed");
    } finally {
      await reg.update("email", { registrationEnabled: stored ?? null });
    }
  });
});
