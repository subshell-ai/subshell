import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sql } from "kysely";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import {
  BREAKGLASS_NONCE_HEADER,
  clearEmergencySignInMark,
  markEmergencySignIn,
  resetEmergencySignInMarksForTests,
  setAuditWriterForTests,
} from "@/auth/audit-hooks.js";
import { getAuth, setAuthPolicyDb } from "@/auth.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

/**
 * Sign-in / sign-out audit events (security audit 2026-09 item R1 — the gap
 * `docs/security.md` §10 used to call "known"). The suite pins the contract:
 *
 * - a SUCCESSFUL sign-in writes exactly one `auth.sign_in` per act, carrying
 *   only `{ method }` — never the session token the same response carries;
 * - a FAILED sign-in writes nothing (credential stuffing must not spam the
 *   trail; failures stay in the `authAttempts` backoff domain);
 * - a sign-out / revocation writes `auth.sign_out` once per session row
 *   actually deleted, and an anonymous sign-out (nothing to delete) writes
 *   nothing;
 * - the break-glass rewrite keeps its one row: `emergency_login.rewrite_credential`
 *   wins the act, no `auth.sign_in` is added for the same request;
 * - a throwing audit sink leaves sign-in itself working.
 *
 * Every assertion is scoped to the test's own user id: the suite DB is shared
 * and other suites sign in constantly. Fixture emails carry a random suffix;
 * failed attempts leave `authAttempts` rows behind for emails nothing reuses.
 */

const ENV = "SUBSHELL_EMERGENCY_PASSWORD";
const ENV_VALUE = "audit-break-glass-7";

interface AuditRow {
  id: string;
  action: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadataJson: string | null;
}

async function auditRows(action: string, actorUserId: string): Promise<AuditRow[]> {
  return (await db
    .selectFrom("auditEvents")
    .selectAll()
    .where("action", "=", action)
    .where("actorUserId", "=", actorUserId)
    .execute()) as unknown as AuditRow[];
}

async function countAction(action: string): Promise<number> {
  const row = await db
    .selectFrom("auditEvents")
    .select((eb) => eb.fn.count("id").as("n"))
    .where("action", "=", action)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Sign-out through the better-auth handler (the app's own mount point). */
async function signOut(token: string): Promise<Response> {
  return getAuth().handler(
    new Request("http://localhost:3080/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "http://localhost:5173", cookie: `better-auth.session_token=${token}` },
    }),
  );
}

describe("auth audit trail (sign-in / sign-out)", () => {
  const repo = new UsersRepository(db);
  const created: string[] = [];
  let savedEnv: string | undefined;

  beforeAll(async () => {
    await setupAuthTables();
    // The disabled-account refusal reads through the policy db boot injects;
    // suites set it the same way `users-management.test.ts` does (same
    // singleton, idempotent).
    setAuthPolicyDb(db);
    savedEnv = process.env[ENV];
    resetEmergencySignInMarksForTests();
  });

  afterAll(async () => {
    for (const email of created) await deleteUserByEmailOrId(email);
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
    setAuditWriterForTests(null);
    resetEmergencySignInMarksForTests();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
    setAuditWriterForTests(null);
    resetEmergencySignInMarksForTests();
  });

  async function makeUser(password: string, role: "admin" | "user" = "user"): Promise<{ email: string; id: string }> {
    const email = `auth-audit-${crypto.randomUUID()}@subshell.local`;
    const id = await repo.createUser({ email, name: email, passwordHash: await hashPassword(password), role });
    created.push(email);
    return { email, id };
  }

  it("a successful password sign-in writes exactly one auth.sign_in with method=password", async () => {
    const password = "audit-pass-123";
    const { email, id } = await makeUser(password);
    await signIn(email, password);

    const rows = await auditRows("auth.sign_in", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetType).toBe("user");
    expect(rows[0]?.targetId).toBe(id);
    expect(rows[0]?.metadataJson).toBe(JSON.stringify({ method: "password" }));
  });

  it("the sign_in row never carries the session token, a cookie value, or the email", async () => {
    const password = "audit-pass-123";
    const { email, id } = await makeUser(password);
    const token = await signIn(email, password);

    const [row] = await auditRows("auth.sign_in", id);
    expect(row).toBeDefined();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(email);
  });

  it("a failed password sign-in writes no auth.sign_in", async () => {
    const { email, id } = await makeUser("audit-right-pass-123");
    const before = await countAction("auth.sign_in");

    const res = await authRateLimitRoutes.fetch(
      new Request("http://localhost:3080/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({ email, password: "definitely-wrong-1" }),
      }),
    );
    expect(res.status).toBe(401);

    expect(await countAction("auth.sign_in")).toBe(before);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(0);
    await db.deleteFrom("authAttempts").where("email", "=", email).execute();
  });

  it("a sign-out writes one auth.sign_out naming the user, with no metadata", async () => {
    const password = "audit-pass-123";
    const { email, id } = await makeUser(password);
    const token = await signIn(email, password);

    const res = await signOut(token);
    expect(res.status).toBe(200);

    const rows = await auditRows("auth.sign_out", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetType).toBe("user");
    expect(rows[0]?.targetId).toBe(id);
    expect(rows[0]?.metadataJson).toBeNull();
  });

  it("a sign-out with an already-dead cookie deletes nothing and writes nothing", async () => {
    const password = "audit-pass-123";
    const { email, id } = await makeUser(password);
    const token = await signIn(email, password);
    expect((await signOut(token)).status).toBe(200);
    const afterFirst = await auditRows("auth.sign_out", id);

    // Same token again: the row is gone, so the second sign-out deletes no
    // session and must not fabricate a second row.
    expect((await signOut(token)).status).toBe(200);
    expect(await auditRows("auth.sign_out", id)).toHaveLength(afterFirst.length);
  });

  it("revoking all sessions writes one auth.sign_out per live session", async () => {
    const password = "audit-pass-123";
    const { email, id } = await makeUser(password);
    const first = await signIn(email, password);
    await signIn(email, password); // a second live session for the same user

    const res = await getAuth().handler(
      new Request("http://localhost:3080/api/auth/revoke-sessions", {
        method: "POST",
        headers: { origin: "http://localhost:5173", cookie: `better-auth.session_token=${first}` },
      }),
    );
    expect(res.status).toBe(200);

    // Both sessions were live (sign-in does not reuse rows), so the trail
    // carries one row per deleted session — the count is the contract.
    expect(await auditRows("auth.sign_out", id)).toHaveLength(2);
  });

  it("a disabled account's refused sign-in writes nothing", async () => {
    const password = "audit-pass-123";
    const { email, id } = await makeUser(password);
    await sql`UPDATE user_meta SET disabled = 1 WHERE user_id = ${id}`.execute(db);
    try {
      const res = await authRateLimitRoutes.fetch(
        new Request("http://localhost:3080/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:5173" },
          body: JSON.stringify({ email, password }),
        }),
      );
      expect(res.status).toBe(401);
      expect(await auditRows("auth.sign_in", id)).toHaveLength(0);
    } finally {
      await sql`UPDATE user_meta SET disabled = 0 WHERE user_id = ${id}`.execute(db);
    }
  });

  it("a throwing audit sink leaves sign-in itself working", async () => {
    const password = "audit-pass-123";
    const { email, id } = await makeUser(password);
    setAuditWriterForTests(async () => {
      throw new Error("audit sink closed");
    });

    const res = await authRateLimitRoutes.fetch(
      new Request("http://localhost:3080/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=");
    expect(await auditRows("auth.sign_in", id)).toHaveLength(0); // the failed write is swallowed, not half-written

    setAuditWriterForTests(null);
    const token = await signIn(email, password); // the same user works normally after restore
    expect(token).not.toBe("");
    expect(await auditRows("auth.sign_in", id)).toHaveLength(1);
  });

  it("an emergency sign-in keeps exactly one row: the rewrite wins, no auth.sign_in", async () => {
    process.env[ENV] = ENV_VALUE;
    const { email, id } = await makeUser("audit-old-admin-pass-123", "admin");
    const res = await authRateLimitRoutes.fetch(
      new Request("http://localhost:3080/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({ email, password: ENV_VALUE }),
      }),
    );
    expect(res.status).toBe(200);

    const rewrite = await db
      .selectFrom("auditEvents")
      .select("id")
      .where("action", "=", "emergency_login.rewrite_credential")
      .where("actorUserId", "=", id)
      .execute();
    expect(rewrite).toHaveLength(1);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(0);
    await db.deleteFrom("authAttempts").where("email", "=", email).execute();
  });

  it("an ordinary sign-in AFTER an emergency one still writes auth.sign_in", async () => {
    // The dedupe consumes its mark: the next password sign-in (a different
    // act) is audited normally.
    process.env[ENV] = ENV_VALUE;
    const { email, id } = await makeUser("audit-old-admin-pass-123", "admin");
    await authRateLimitRoutes.fetch(
      new Request("http://localhost:3080/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({ email, password: ENV_VALUE }),
      }),
    );
    expect(await auditRows("auth.sign_in", id)).toHaveLength(0);

    delete process.env[ENV]; // the rewrite destroyed the old password; the env value IS the password now
    await db.deleteFrom("authAttempts").where("email", "=", email).execute();
    await signIn(email, ENV_VALUE);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(1);
  });

  it("a FAILED emergency forward cannot suppress a later genuine sign-in", async () => {
    // The dedupe mark means "suppress the emergency act's OWN sign-in" — the
    // rewrite row already names the act. But the forwarded sign-in can fail
    // (a disabled account refuses the session downstream), and the mark used
    // to survive it as a plain "next sign-in ≤ 60 s is the rewrite" flag: an
    // admin re-enabled moments later, signing in for real, had its genuine
    // row suppressed by an emergency act that never completed. The wrapper
    // clears the mark when its own forward did not succeed, so the trail
    // reads: rewrite, then the genuine sign-in.
    process.env[ENV] = ENV_VALUE;
    const { email, id } = await makeUser("audit-old-admin-pass-123", "admin");
    await db.updateTable("userMeta").set({ disabled: 1 }).where("userId", "=", id).execute();
    try {
      const res = await authRateLimitRoutes.fetch(
        new Request("http://localhost:3080/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:5173" },
          body: JSON.stringify({ email, password: ENV_VALUE }),
        }),
      );
      // The rewrite still fired (the hatch reads the role, not the flag) and
      // the forwarded sign-in was refused — 401, nothing to suppress.
      expect(res.status).toBe(401);
      expect(await auditRows("auth.sign_in", id)).toHaveLength(0);

      // The operator finishes the break-glass procedure (the env is cleared)
      // and an admin re-enables the account; the sign-in that follows — whose
      // password IS the env value the rewrite installed, but which can no
      // longer be the hatch, because the hatch is disarmed — is a GENUINE
      // act inside the old 60-second mark window, and it must write its row.
      delete process.env[ENV];
      await db.updateTable("userMeta").set({ disabled: 0 }).where("userId", "=", id).execute();
      await db.deleteFrom("authAttempts").where("email", "=", email).execute();
      const token = await signIn(email, ENV_VALUE);
      expect(token).not.toBe("");
      expect(await auditRows("auth.sign_in", id)).toHaveLength(1);
      await db.deleteFrom("authAttempts").where("email", "=", email).execute();
    } finally {
      await db.updateTable("userMeta").set({ disabled: 0 }).where("userId", "=", id).execute();
    }
  });

  /**
   * Sign-in straight through better-auth carrying the break-glass header —
   * the shape of the wrapper's FORWARD, for cases that need the mark armed
   * without a completed rewrite to arm it (the wrapper is what mints the
   * nonce, and here the test holds it).
   */
  async function signInWithBreakglass(email: string, password: string, nonce: string | null): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      origin: "http://localhost:5173",
    };
    if (nonce !== null) headers[BREAKGLASS_NONCE_HEADER] = nonce;
    const res = await getAuth().handler(
      new Request("http://localhost:3080/api/auth/sign-in/email", {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(res.status).toBe(200);
    await db.deleteFrom("authAttempts").where("email", "=", email).execute();
  }

  it("an armed mark binds to its own act's header, not to the next sign-in of that user", async () => {
    // The mark used to be a userId-keyed "the next password sign-in ≤ 60 s
    // is the rewrite" flag, and interleaving made that lie: a genuine
    // sign-in that happened to land while a mark was armed — the crash-
    // before-clear backstop state, or the wrapper's own forward simply still
    // mid-flight — had its real act SUPPRESSED by an unrelated emergency
    // act's bookkeeping. The mark now carries a per-act nonce the wrapper
    // puts on the forwarded request; consumption matches userId AND header.
    // A complete act through the real wrapper (its forward carries the
    // nonce) is pinned by the two tests above; this one arms a mark by hand
    // to get the interleaving no end-to-end timing could produce on demand.
    const password = "audit-old-admin-pass-123";
    const { email, id } = await makeUser(password, "admin");
    const nonce = markEmergencySignIn(id); // the act is mid-flight: rewrite done, forward pending

    // A bystander's sign-in in the same window is never touched.
    const bystander = await makeUser("audit-bystander-pass-123");
    expect(await signIn(bystander.email, "audit-bystander-pass-123")).not.toBe("");
    expect(await auditRows("auth.sign_in", bystander.id)).toHaveLength(1);

    // The marked user's own GENUINE sign-in lands first: an ordinary act,
    // its own row, and it must not eat the mark.
    await signIn(email, password);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(1);

    // A sign-in carrying a WRONG nonce is likewise not the act: audited,
    // and the mark survives it.
    await signInWithBreakglass(email, password, "not-the-nonce");
    expect(await auditRows("auth.sign_in", id)).toHaveLength(2);

    // The act's own forwarded sign-in — same user AND the nonce — is the one
    // consumed: the rewrite row stands as its record, no duplicate.
    await signInWithBreakglass(email, password, nonce);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(2);
  });

  it("two interleaved marks for one admin bind to their own acts independently", async () => {
    // A Map with one mark per user means the second emergency act OVERWRITES
    // the first: the first act's forward carries a nonce nobody holds any
    // more, gets audited as if it were the rewrite's duplicate, and the
    // second act's genuine duplicate suppression lands on a stale binding.
    // Marks are a per-user SET: each act's nonce lives until its own act
    // consumes it or its own failed forward clears it.
    const password = "audit-old-admin-pass-123";
    const { email, id } = await makeUser(password, "admin");
    const n1 = markEmergencySignIn(id); // act #1 mid-flight
    const n2 = markEmergencySignIn(id); // act #2 starts before #1's forward returns

    // Act #1's forward completes: consumes ONLY N1 — its own duplicate is
    // suppressed, nothing else is touched.
    await signInWithBreakglass(email, password, n1);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(0);

    // N2 still suppresses act #2's own sign-in — act #1's consumption (or a
    // failed clear) must never spend a sibling's mark.
    await signInWithBreakglass(email, password, n2);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(0);

    // Both acts are spent: the next ordinary sign-in is a fresh act and is
    // audited.
    await signIn(email, password);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(1);
  });

  it("clearing one act's nonce leaves a sibling mark live", async () => {
    // The failed-forward clear used to delete the user's whole mark. With two
    // acts in flight, act #1's failure must not disarm act #2 — that would
    // leave #2's own duplicate to write a second row, the exact bug the mark
    // exists to prevent. The wrapper clears the nonce IT minted, only.
    const password = "audit-old-admin-pass-123";
    const { email, id } = await makeUser(password, "admin");
    const n1 = markEmergencySignIn(id);
    const n2 = markEmergencySignIn(id);
    clearEmergencySignInMark(id, n1); // act #1's forward failed; only its nonce goes

    // N1 is dead: a sign-in carrying it is an ordinary act, audited.
    await signInWithBreakglass(email, password, n1);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(1);

    // N2 is untouched: still armed, and still suppresses only its own act.
    await signInWithBreakglass(email, password, n2);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(1);

    // N2 spent, nothing remains: the next sign-in writes its row.
    await signIn(email, password);
    expect(await auditRows("auth.sign_in", id)).toHaveLength(2);
  });

  it("a refused passkey verification writes nothing", async () => {
    const before = await countAction("auth.sign_in");
    const res = await getAuth().handler(
      new Request("http://localhost:3080/api/auth/passkey/verify-authentication", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({ response: { id: "no-such-credential" } }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countAction("auth.sign_in")).toBe(before);
  });
});
