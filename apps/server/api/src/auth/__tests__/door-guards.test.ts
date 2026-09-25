import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sql } from "kysely";
import { seedLocalPluginsForTests } from "@/api/__tests__/helpers/auth-tables.js";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { BREAKGLASS_NONCE_HEADER, markEmergencySignIn, resetEmergencySignInMarksForTests } from "@/auth/audit-hooks.js";
import { createDoorGuardBeforeHook } from "@/auth/door-guards.js";
import { getAuth, setAuthPolicyDb } from "@/auth.js";
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

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
/** Every user id this suite creates (the shared test DB outlives the file). */
const createdUserIds: string[] = [];

async function setEmailSignIn(on: boolean): Promise<void> {
  await new AuthProvidersRepository(db).update("email", { signInEnabled: on ? 1 : 0 });
}

/** Set BOTH E-mail-row switches at once; every matrix case below states both. */
async function setEmailRow(over: { enabled: 0 | 1; signInEnabled: 0 | 1 }): Promise<void> {
  await new AuthProvidersRepository(db).update("email", over);
}

async function signInRequest(extraHeaders: Record<string, string> = {}): Promise<Response> {
  return authRateLimitRoutes.fetch(
    new Request("http://localhost:3080/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173", ...extraHeaders },
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
    const body = (await res.json()) as { user?: { id?: string } };
    if (typeof body.user?.id === "string") createdUserIds.push(body.user.id);
  } finally {
    await reg.update("email", { registrationEnabled: stored ?? null });
  }
});

afterAll(async () => {
  await setEmailSignIn(true);
  resetEmergencySignInMarksForTests();
  // Full cleanup like the sibling suite: the sign-up leaves `account` and
  // `user_meta` rows beside the `user` row, and the break-glass admin's
  // credential lives in `account` too — deleting only the user strands all
  // of them in the shared test DB.
  for (const id of createdUserIds) {
    await sql`DELETE FROM account WHERE userId = ${id}`.execute(db);
    await sql`DELETE FROM user_meta WHERE user_id = ${id}`.execute(db);
    await sql`DELETE FROM user WHERE id = ${id}`.execute(db);
  }
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

  test("the master switch closes the door too: the enabled/signInEnabled matrix (final review, Important 1)", async () => {
    // `enabled = 0` on the E-mail row is writable (the PATCH route's
    // `booleanField("enabled")` accepts it, and the admin table renders the
    // switch on the email row), and every OTHER reader treats it as closed —
    // the last-door count, the anonymous `emailSignIn`, the door policy's
    // create branch. The sign-in guard must give the same answer; a hidden
    // door that still signs people in is the §7 violation this closes.
    const hook = createDoorGuardBeforeHook(() => db);
    const cases: [0 | 1, 0 | 1][] = [
      [0, 1], // master OFF, half-switch on
      [1, 0], // master on, half-switch off (the shipped rule, re-pinned)
      [0, 0], // both off
    ];
    for (const [enabled, signInEnabled] of cases) {
      await setEmailRow({ enabled, signInEnabled });
      try {
        for (const path of ["/sign-in/email", "/passkey/verify-authentication"]) {
          const err = await hook({ path }).catch((e: unknown) => e);
          expect(err).toBeTruthy();
          expect((err as { statusCode?: number }).statusCode).toBe(403);
        }
      } finally {
        await setEmailRow({ enabled: 1, signInEnabled: 1 });
      }
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

  test("a live break-glass mark exempts the guarded paths; a forged nonce does not", async () => {
    const hook = createDoorGuardBeforeHook(() => db);
    await setEmailSignIn(false);
    // Simulated mark: exactly what the emergency wrapper mints for an act
    // whose rewrite fired (hasActiveEmergencyMark reads the same store the
    // audit dedupe owns — no second store to fake).
    const nonce = markEmergencySignIn("door-guard-mark-holder");
    const marked = new Request("http://localhost:3080/api/auth/sign-in/email", {
      method: "POST",
      headers: { [BREAKGLASS_NONCE_HEADER]: nonce },
    });
    const forged = new Request("http://localhost:3080/api/auth/sign-in/email", {
      method: "POST",
      headers: { [BREAKGLASS_NONCE_HEADER]: `forged-${crypto.randomUUID()}` },
    });
    const plain = new Request("http://localhost:3080/api/auth/sign-in/email", { method: "POST" });
    try {
      for (const path of ["/sign-in/email", "/passkey/verify-authentication"]) {
        await expect(hook({ path, request: marked })).resolves.toBeUndefined();
      }
      // Read-only: the guard's check must NOT consume — the after-hook
      // spends the same mark moments later on the same request.
      await expect(hook({ path: "/sign-in/email", request: marked })).resolves.toBeUndefined();
      for (const req of [forged, plain]) {
        const err = await hook({ path: "/sign-in/email", request: req }).catch((e: unknown) => e);
        expect((err as { statusCode?: number }).statusCode).toBe(403);
      }
      // Unguarded paths were never the guard's business, mark or not.
      await expect(hook({ path: "/sign-up/email", request: marked })).resolves.toBeUndefined();
    } finally {
      resetEmergencySignInMarksForTests();
      await setEmailSignIn(true);
    }
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

  test("the master switch answers 403 on the real handler too (enabled=0, signInEnabled=1)", async () => {
    // The HTTP half of the matrix above: the switch the admin flips is the
    // one on the table row, and the wire must refuse what the UI hid.
    await new AuthProvidersRepository(db).update("email", { enabled: 0, signInEnabled: 1 });
    try {
      expect((await signInRequest()).status).toBe(403);
    } finally {
      await new AuthProvidersRepository(db).update("email", { enabled: 1 });
    }
  });

  test("a CLOSED REGISTRATION GATE does not refuse an existing account's sign-in", async () => {
    // The two flags gate DIFFERENT things (spec §2): registration decides who
    // may CREATE an account — signing in is signInEnabled's decision. The
    // legacy dynamic window closes registration while every member keeps
    // their way in, so this edge must stay a 200. (Pinned because a future
    // "derive the whole policy in the sign-in guard" edit would break it.)
    const reg = new AuthProvidersRepository(db);
    const stored = (await reg.getById("email"))?.registrationEnabled;
    await reg.update("email", { registrationEnabled: 0, signInEnabled: 1, enabled: 1 });
    try {
      expect((await signInRequest()).status).toBe(200);
    } finally {
      await reg.update("email", { registrationEnabled: stored ?? null });
    }
  });

  test("a forged break-glass header does NOT exempt a closed-door sign-in (HTTP)", async () => {
    // The wrapper copies incoming headers onto the forwarded request, so a
    // client CAN put the header there — the point is that a header without
    // a live server-minted mark changes nothing.
    await setEmailSignIn(false);
    try {
      const res = await signInRequest({ [BREAKGLASS_NONCE_HEADER]: `forged-${crypto.randomUUID()}` });
      expect(res.status).toBe(403);
    } finally {
      await setEmailSignIn(true);
    }
  });

  test("the armed break-glass signs an admin in through a CLOSED door (spec §9)", async () => {
    // The full chain: the wrapper rewrites the admin's credential, mints the
    // mark, sets the nonce header, and the forwarded sign-in reaches the
    // REAL hook inside the REAL auth instance — and must not be refused by
    // the closed door it would otherwise answer 403 to.
    const envName = "SUBSHELL_EMERGENCY_PASSWORD";
    const envValue = "door-guard-breakglass-7";
    const savedEnv = process.env[envName];
    const adminEmail = `breakglass-${crypto.randomUUID()}@subshell.local`;
    const adminId = await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword("forgotten-pass-1"),
      role: "admin",
    });
    createdUserIds.push(adminId);
    await setEmailSignIn(false);
    process.env[envName] = envValue;
    try {
      const res = await authRateLimitRoutes.fetch(
        new Request("http://localhost:3080/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:5173" },
          body: JSON.stringify({ email: adminEmail, password: envValue }),
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=");
    } finally {
      if (savedEnv === undefined) delete process.env[envName];
      else process.env[envName] = savedEnv;
      await setEmailSignIn(true);
      await db.deleteFrom("authAttempts").where("email", "=", adminEmail).execute();
    }
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
