import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { sql } from "kysely";
import { usersRoutes } from "@/api/users.route.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * Admin user management: role assignment and password reset.
 *
 * Both are credential-grade surfaces, so the guards get more attention here
 * than the happy paths:
 *
 * - the LAST admin cannot be demoted, or the instance is left with nobody who
 *   can administer it and only `SUBSHELL_EMERGENCY_PASSWORD` to recover;
 * - a reset REVOKES the target's sessions, because a reset is usually an
 *   answer to "this account may be compromised" and live cookies would make
 *   it useless;
 * - an admin cannot reset their OWN password here, which would turn an
 *   unlocked laptop into a takeover with no knowledge of the current password;
 * - the `system` service account is untouchable;
 * - machine credentials never reach any of it.
 */
describe("admin user management", () => {
  const pw = "user-mgmt-pass-1";
  const adminEmail = `um-admin-${crypto.randomUUID()}@subshell.local`;
  const admin2Email = `um-admin2-${crypto.randomUUID()}@subshell.local`;
  const memberEmail = `um-member-${crypto.randomUUID()}@subshell.local`;
  let adminId: string;
  let admin2Id: string;
  let memberId: string;
  let adminCookie: string;
  let memberCookie: string;
  let systemId: string;
  /** A REAL, valid bearer key owned by the admin — see the bearer test. */
  let adminBearerKey: string;
  const subshellId = `um-sub-${crypto.randomUUID()}`;

  const users = new UsersRepository(db);
  const meta = new UserMetaRepository(db);

  async function mkUser(email: string, role: "admin" | "user"): Promise<string> {
    return await users.createUser({ email, passwordHash: await hashPassword(pw), role });
  }

  beforeAll(async () => {
    await setupAuthTables();
    systemId = await ensureSystemUser();
    adminId = await mkUser(adminEmail, "admin");
    admin2Id = await mkUser(admin2Email, "admin");
    memberId = await mkUser(memberEmail, "user");
    adminCookie = await signIn(adminEmail, pw);
    memberCookie = await signIn(memberEmail, pw);

    // A VALID key, owned by an admin. A bogus string would be 401'd by
    // authGuard before requireAdmin's cookie-only check ever ran, so it would
    // assert nothing about the rule that actually matters here: a machine
    // credential is refused even when its owner IS an admin.
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId: adminId,
      profileId: "p",
      harnessId: "claude-code",
      name: "user-mgmt-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    adminBearerKey = await issueSubshellToken(subshellId, adminId);
  });

  beforeEach(async () => {
    // Every case starts from two admins and one member, so a test that changes
    // roles cannot decide the next one's outcome.
    await meta.upsert({ userId: adminId, role: "admin" });
    await meta.upsert({ userId: admin2Id, role: "admin" });
    await meta.upsert({ userId: memberId, role: "user" });
    // ...and from a known password with live sessions. A reset REVOKES the
    // target's sessions by design, so without this the first reset test
    // silently 401s every later case that signs in as the member — the
    // feature working correctly would look like a broken test suite.
    await users.setPassword(memberId, await hashPassword(pw));
    adminCookie = await signIn(adminEmail, pw);
    memberCookie = await signIn(memberEmail, pw);
  });

  afterAll(async () => {
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    for (const email of [adminEmail, admin2Email, memberEmail]) await deleteUserByEmailOrId(email);
  });

  function req(method: string, path: string, cookie: string | null, body?: unknown, bearer?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cookie) headers.cookie = `better-auth.session_token=${cookie}`;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return usersRoutes.fetch(
      new Request(`http://localhost:3080/api/users${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  }

  describe("role assignment", () => {
    it("promotes a member to admin", async () => {
      const res = await req("PATCH", `/${memberId}/role`, adminCookie, { role: "admin" });
      expect(res.status).toBe(200);
      expect(await meta.getRole(memberId)).toBe("admin");
    });

    it("demotes an admin while another remains", async () => {
      const res = await req("PATCH", `/${admin2Id}/role`, adminCookie, { role: "user" });
      expect(res.status).toBe(200);
      expect(await meta.getRole(admin2Id)).toBe("user");
    });

    it("lets an admin step down themselves, while another remains", async () => {
      // Legitimate and deliberately not special-cased — the last-admin rule
      // already covers the only case that can strand the instance.
      const res = await req("PATCH", `/${adminId}/role`, adminCookie, { role: "user" });
      expect(res.status).toBe(200);
      expect(await meta.getRole(adminId)).toBe("user");
    });

    it("refuses to demote the LAST admin", async () => {
      // Every test file in this invocation shares one database, so other
      // suites' admins are present and `countAdmins()` is not this test's to
      // assume. Stand every OTHER admin down for the duration and put them
      // back afterwards, so the case is about the rule rather than about what
      // else happens to be in the table.
      const others = await otherAdminIds(adminId);
      for (const id of others) await meta.upsert({ userId: id, role: "user" });
      try {
        expect(await meta.countAdmins()).toBe(1);

        const res = await req("PATCH", `/${adminId}/role`, adminCookie, { role: "user" });
        expect(res.status).toBe(409);
        // Raw text here: the global error plugin that renders the structured
        // ApiErrorResponse is mounted by `createApp`, not by a route instance.
        // The message is what matters — a bare "conflict" would leave the
        // admin with no idea why.
        expect(await res.text()).toContain("only admin");
        // ...and the role is untouched, so the refusal is not partial.
        expect(await meta.getRole(adminId)).toBe("admin");
      } finally {
        for (const id of others) await meta.upsert({ userId: id, role: "admin" });
      }
    });

    it("still allows re-asserting the last admin's own role", async () => {
      // Only a DEMOTION can strand the instance; writing "admin" over "admin"
      // must not trip the guard.
      const others = await otherAdminIds(adminId);
      for (const id of others) await meta.upsert({ userId: id, role: "user" });
      try {
        const res = await req("PATCH", `/${adminId}/role`, adminCookie, { role: "admin" });
        expect(res.status).toBe(200);
      } finally {
        for (const id of others) await meta.upsert({ userId: id, role: "admin" });
      }
    });

    it("survives concurrent demotions with exactly one admin left standing", async () => {
      // The guard's reason for existing. Two admins demoting each other must
      // not both read "2 admins" and both succeed.
      //
      // It holds for a reason worth writing down: `bun:sqlite` is SYNCHRONOUS
      // and the dialect hands out one shared connection, so the awaits inside
      // `setRole`'s transaction never actually yield between its SELECT and
      // its write — the transactions serialize in practice. Measured here
      // rather than assumed: eight concurrent demotions, repeated, always
      // leave exactly one admin and never throw. If the dialect ever becomes
      // truly async or pooled, this test is what will notice.
      const others = await otherAdminIds(adminId);
      for (const id of others) await meta.upsert({ userId: id, role: "user" });
      const ids = [adminId, admin2Id, memberId];
      try {
        for (const id of ids) await meta.upsert({ userId: id, role: "admin" });
        const results = await Promise.allSettled(ids.map((id) => meta.setRole(id, "user")));

        // No throws: a loser must get an orderly refusal, not a 500.
        expect(results.every((r) => r.status === "fulfilled")).toBe(true);
        const refused = results.filter((r) => r.status === "fulfilled" && r.value === false);
        expect(refused).toHaveLength(1);
        expect(await meta.countAdmins()).toBe(1);
      } finally {
        for (const id of others) await meta.upsert({ userId: id, role: "admin" });
      }
    });

    it("refuses to touch the system service account", async () => {
      // 403, not 400: the body is valid, the caller simply may not.
      const res = await req("PATCH", `/${systemId}/role`, adminCookie, { role: "user" });
      expect(res.status).toBe(403);
    });

    it("upserts a role over a user with no user_meta row at all", async () => {
      // `listWithRoles` returns role: null for such a user, so the state is
      // reachable — and a bare UPDATE would silently no-op, leaving the admin
      // believing they had granted something.
      const orphanEmail = `um-orphan-${crypto.randomUUID()}@subshell.local`;
      const orphanId = await mkUser(orphanEmail, "user");
      await db.deleteFrom("userMeta").where("userId", "=", orphanId).execute();
      expect(await meta.getRole(orphanId)).toBeNull();
      try {
        const res = await req("PATCH", `/${orphanId}/role`, adminCookie, { role: "admin" });
        expect(res.status).toBe(200);
        expect(await meta.getRole(orphanId)).toBe("admin");
      } finally {
        await deleteUserByEmailOrId(orphanEmail);
      }
    });

    it("404s an unknown user", async () => {
      expect((await req("PATCH", `/${crypto.randomUUID()}/role`, adminCookie, { role: "user" })).status).toBe(404);
    });

    it("refuses a non-admin (403) and an anonymous caller (401)", async () => {
      expect((await req("PATCH", `/${memberId}/role`, memberCookie, { role: "admin" })).status).toBe(403);
      expect((await req("PATCH", `/${memberId}/role`, null, { role: "admin" })).status).toBe(401);
    });

    it("refuses an ADMIN'S OWN valid bearer key with 403", async () => {
      // The invariant: machine credentials cannot manage the instance even
      // when the human behind them is an admin. Exactly 403 — a 401 would mean
      // the key was merely unrecognised and the rule went untested.
      const res = await req("PATCH", `/${memberId}/role`, null, { role: "admin" }, adminBearerKey);
      expect(res.status).toBe(403);
      expect(await meta.getRole(memberId)).toBe("user");
    });
  });

  describe("create", () => {
    it("rejects a short password without quoting it back", async () => {
      // The pre-existing create route carried the same schema-level bound and
      // therefore the same echo; fixed with it.
      const rejected = "tiny";
      const res = await req("POST", "/", adminCookie, {
        email: `um-new-${crypto.randomUUID()}@subshell.local`,
        password: rejected,
        role: "user",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(rejected);
    });
  });

  describe("roster", () => {
    it("marks the system account unmanageable so the UI offers no doomed control", async () => {
      const res = await usersRoutes.fetch(
        new Request("http://localhost:3080/api/users", {
          headers: { cookie: `better-auth.session_token=${adminCookie}` },
        }),
      );
      const body = (await res.json()) as { users: { id: string; manageable: boolean }[] };
      expect(body.users.find((u) => u.id === systemId)?.manageable).toBe(false);
      expect(body.users.find((u) => u.id === memberId)?.manageable).toBe(true);
    });
  });

  describe("password reset", () => {
    it("sets a password the user can actually sign in with", async () => {
      const next = "brand-new-pass-9";
      const res = await req("PATCH", `/${memberId}/password`, adminCookie, { password: next });
      expect(res.status).toBe(200);

      const stored = await storedHash(memberId);
      expect(stored).not.toBeNull();
      // The real check: better-auth's own verifier accepts the new password
      // and rejects the old one. Comparing hashes would only prove we wrote
      // *something*.
      expect(await verifyPassword({ hash: stored as string, password: next })).toBe(true);
      expect(await verifyPassword({ hash: stored as string, password: pw })).toBe(false);
    });

    it("revokes every session the target holds, and says how many", async () => {
      // The point of the feature: a reset must evict someone already holding a
      // cookie, or it accomplishes nothing against a compromised account.
      await signIn(memberEmail, pw);
      const before = await sessionCount(memberId);
      expect(before).toBeGreaterThan(0);

      const res = await req("PATCH", `/${memberId}/password`, adminCookie, { password: "another-new-pass-1" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sessionsRevoked: number }).sessionsRevoked).toBe(before);
      expect(await sessionCount(memberId)).toBe(0);
    });

    it("leaves the ADMIN's own sessions alone", async () => {
      const mine = await sessionCount(adminId);
      await req("PATCH", `/${memberId}/password`, adminCookie, { password: "yet-another-pass-1" });
      expect(await sessionCount(adminId)).toBe(mine);
    });

    it("refuses self — Account is the path that requires the current password", async () => {
      const res = await req("PATCH", `/${adminId}/password`, adminCookie, { password: "self-service-pass-1" });
      expect(res.status).toBe(400);
      // Points at the path that DOES work, rather than just refusing.
      expect(await res.text()).toContain("Account");
    });

    it("refuses the system service account", async () => {
      expect((await req("PATCH", `/${systemId}/password`, adminCookie, { password: "nope-nope-nope" })).status).toBe(
        403,
      );
    });

    it("refuses a user who has no password login, rather than inventing one", async () => {
      // Reaching this branch takes a user with a `user` row and no
      // `account` row. Only `system` is like that in practice, and it is
      // refused earlier — so without constructing the state deliberately the
      // guard is unreachable, and an unreachable guard is one that rots.
      // Inventing a credential here would give a password login to an account
      // that deliberately had none.
      const noPwEmail = `um-nopw-${crypto.randomUUID()}@subshell.local`;
      const noPwId = await mkUser(noPwEmail, "user");
      await sql`DELETE FROM account WHERE userId = ${noPwId}`.execute(db);
      try {
        const res = await req("PATCH", `/${noPwId}/password`, adminCookie, { password: "brand-new-pass-2" });
        expect(res.status).toBe(409);
        expect(await res.text()).toContain("no password login");
        // ...and nothing was created behind it.
        expect(await storedHash(noPwId)).toBeNull();
      } finally {
        await deleteUserByEmailOrId(noPwEmail);
      }
    });

    it("keeps the password out of the AUDIT row, not just the response", async () => {
      // The response is the obvious place to check; the audit table is the one
      // that persists and gets read back by an admin months later.
      const secret = "audit-should-not-hold-this-1";
      await req("PATCH", `/${memberId}/password`, adminCookie, { password: secret });
      const rows = await db
        .selectFrom("auditEvents")
        .select(["action", "metadataJson"])
        .where("action", "=", "user.password_reset")
        .where("targetId", "=", memberId)
        .execute();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.metadataJson ?? "").not.toContain(secret);
      // It records what it should: who, and how much was cut.
      expect(rows.at(-1)?.metadataJson ?? "").toContain("sessionsRevoked");
    });

    it("rejects a password under 8 characters WITHOUT quoting it back", async () => {
      // The bound is checked in the handler, not by the schema, for exactly
      // this reason: Elysia renders a schema failure by putting the offending
      // VALUE in the message, and the error handler copies that message into
      // the response body — so a `minLength` here would echo the rejected
      // password into every proxy log and devtools panel on the way back.
      const rejected = "sekrit";
      const res = await req("PATCH", `/${memberId}/password`, adminCookie, { password: rejected });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).not.toContain(rejected);
      expect(body).toContain("at least 8");
    });

    it("never puts the password in the response, on success or refusal", async () => {
      const secret = "do-not-echo-this-1";
      const ok = await req("PATCH", `/${memberId}/password`, adminCookie, { password: secret });
      expect(ok.status).toBe(200);
      expect(await ok.text()).not.toContain(secret);

      // ...and on the paths that REFUSE, which is where it leaked: a refusal
      // is exactly when something is inclined to quote the input back.
      const onSelf = await req("PATCH", `/${adminId}/password`, adminCookie, { password: secret });
      expect(await onSelf.text()).not.toContain(secret);
      const onSystem = await req("PATCH", `/${systemId}/password`, adminCookie, { password: secret });
      expect(await onSystem.text()).not.toContain(secret);
    });

    it("refuses a non-admin, an anonymous caller, and a bearer key", async () => {
      expect((await req("PATCH", `/${memberId}/password`, memberCookie, { password: "member-tried-1" })).status).toBe(
        403,
      );
      expect((await req("PATCH", `/${memberId}/password`, null, { password: "anon-tried-11" })).status).toBe(401);
      const bearer = await req("PATCH", `/${memberId}/password`, null, { password: "bearer-tried-1" }, adminBearerKey);
      expect(bearer.status).toBe(403);
    });
  });
});

/** Every admin except `keep` — the shared test database holds other suites' admins too. */
async function otherAdminIds(keep: string): Promise<string[]> {
  const rows = await db.selectFrom("userMeta").select("userId").where("role", "=", "admin").execute();
  return rows.map((r) => r.userId).filter((id) => id !== keep);
}

/** The credential row's stored hash, or null when the user has no password login. */
async function storedHash(userId: string): Promise<string | null> {
  const { rows } = await sql<{ password: string | null }>`
    SELECT password FROM account WHERE userId = ${userId} AND providerId = ${"credential"}
  `.execute(db);
  return rows[0]?.password ?? null;
}

/** How many live sessions a user holds (better-auth's table, outside the Kysely schema). */
async function sessionCount(userId: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM session WHERE userId = ${userId}`.execute(db);
  return Number(rows[0]?.n ?? 0);
}
