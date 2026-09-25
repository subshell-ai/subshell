import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { evaluateProviderPolicy } from "@/auth/provider-policy.js";
import { markApprovalProviderArrival, setAuthPolicyDb } from "@/auth.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";

/**
 * The DB-backed provider policy (spec 2026-09-24 §3–§6): provider resolution, the
 * existing user's approval state, and the §6 re-stamp — driven directly,
 * because the hook that runs it (`user.validateUserInfo`) fires for exactly
 * the four provisioning seams measured in `provider-guards.test.ts`, and the
 * cascade deserves its own matrix.
 *
 * The data shape here is the MEASURED `validateUserInfo` input — 1.7.1 hands
 * `{ user, source }` with the action spelled INSIDE `source`
 * (`dist/db/internal-adapter.mjs`, `dist/oauth2/link-account.mjs`,
 * `dist/api/routes/callback.mjs`); the design-time sketch's top-level
 * `{ action, profile }` does not exist in the installed package.
 */

const createdUserIds: string[] = [];
const createdProviderIds: string[] = [];
const createdAccountIds: string[] = [];

async function makeUser(email: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await sql`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
            VALUES (${id}, '', ${email}, 0, ${now}, ${now})`.execute(db);
  createdUserIds.push(id);
  return id;
}

/** An oidc provider row that any mid-run auth rebuild could safely build. */
async function makeOidcProvider(id: string, over: Record<string, unknown> = {}): Promise<void> {
  await new AuthProvidersRepository(db)
    .create({
      id,
      kind: "oidc",
      name: `Provider ${id}`,
      endpointsJson: JSON.stringify({
        authorizationUrl: "https://issuer.invalid/authorize",
        tokenUrl: "https://issuer.invalid/token",
        userInfoUrl: null,
      }),
      entryOrigins: JSON.stringify(["http://localhost:3080"]),
      ...over,
    })
    .catch(async () => {
      // A rerun of this file in the same process: the row exists already.
      await new AuthProvidersRepository(db).update(id, over);
    });
  createdProviderIds.push(id);
}

/** One `account` row (better-auth's table: physical camelCase, raw SQL). */
async function makeAccount(userId: string, providerId: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await sql`INSERT INTO account (id, issuer, accountId, providerId, userId, createdAt, updatedAt)
            VALUES (${id}, ${providerId}, ${id}, ${providerId}, ${userId}, ${now}, ${now})`.execute(db);
  createdAccountIds.push(id);
  return id;
}

beforeAll(async () => {
  await runMigrations();
  // The arrival hook reads the same injected handle production injects.
  setAuthPolicyDb(db);
});

afterAll(async () => {
  for (const id of createdAccountIds) await sql`DELETE FROM account WHERE id = ${id}`.execute(db);
  for (const id of createdProviderIds) await new AuthProvidersRepository(db).remove(id);
  for (const userId of createdUserIds) {
    await sql`DELETE FROM user_meta WHERE user_id = ${userId}`.execute(db);
    await sql`DELETE FROM user WHERE id = ${userId}`.execute(db);
  }
});

describe("evaluateProviderPolicy", () => {
  test("a pending row answers with the named code and echoes the email", async () => {
    const id = `acme-${crypto.randomUUID().slice(0, 8)}`;
    await makeOidcProvider(id, { registrationEnabled: 1, requireApproval: 1 });
    const email = `${id}@example.test`;
    const userId = await makeUser(email);
    await new UserMetaRepository(db).setApproval(userId, "pending", { arrivedAt: new Date().toISOString() });
    const decision = await evaluateProviderPolicy(db, {
      user: { email, emailVerified: true },
      source: { action: "sign-in", method: "oauth", oauth: { providerId: id, profile: {} } },
    });
    expect(decision).toEqual({ error: "pending_approval", errorDescription: email });
    // the repeat knock re-stamped §6 dedup: pending_arrived_at is fresh
    const stale = await db
      .selectFrom("userMeta")
      .select("pendingArrivedAt")
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(stale.pendingArrivedAt).not.toBeNull();
    const past = new Date(Date.parse(stale.pendingArrivedAt ?? "") - 60_000).toISOString();
    await sql`UPDATE user_meta SET pending_arrived_at = ${past} WHERE user_id = ${userId}`.execute(db);
    await evaluateProviderPolicy(db, {
      user: { email, emailVerified: true },
      source: { action: "sign-in", method: "oauth", oauth: { providerId: id, profile: {} } },
    });
    const fresh = await db
      .selectFrom("userMeta")
      .select("pendingArrivedAt")
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(Date.parse(fresh.pendingArrivedAt ?? "")).toBeGreaterThan(Date.parse(past));
  });

  test("a REJECTED row answers with the named code but is NOT re-stamped", async () => {
    // §6's dedup stamp follows the knock that could still be admitted; a
    // rejection is not waiting on an admin, and refreshing its clock would
    // misrepresent the queue the expiry sweep reads.
    const id = `rej-${crypto.randomUUID().slice(0, 8)}`;
    await makeOidcProvider(id, { registrationEnabled: 1, requireApproval: 1 });
    const email = `${id}@example.test`;
    const userId = await makeUser(email);
    const meta = new UserMetaRepository(db);
    await meta.setApproval(userId, "pending", { arrivedAt: new Date().toISOString() });
    await meta.setApproval(userId, "rejected"); // leaving pending clears the stamp
    const before = await db
      .selectFrom("userMeta")
      .select("pendingArrivedAt")
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(before.pendingArrivedAt).toBeNull();
    const decision = await evaluateProviderPolicy(db, {
      user: { email, emailVerified: true },
      source: { action: "sign-in", method: "oauth", oauth: { providerId: id, profile: {} } },
    });
    expect(decision).toEqual({ error: "pending_approval", errorDescription: email });
    const after = await db
      .selectFrom("userMeta")
      .select("pendingArrivedAt")
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(after.pendingArrivedAt).toBeNull();
  });

  test("an unconfigured providerId refuses provider_closed", async () => {
    const decision = await evaluateProviderPolicy(db, {
      user: { email: "x@y.z", emailVerified: true },
      source: { action: "sign-in", method: "oauth", oauth: { providerId: "nope-none", profile: {} } },
    });
    expect(decision).toEqual({ error: "provider_closed" });
  });

  test("a disabled provider row is no provider (defence against out-of-band writes)", async () => {
    // buildAuth never builds a disabled provider, so this seam is unreachable via
    // a real callback — but evaluate answers from the TABLE, and a row that
    // says `enabled = 0` is not a provider whatever put it there.
    const id = `off-${crypto.randomUUID().slice(0, 8)}`;
    await makeOidcProvider(id, { enabled: 0, signInEnabled: 1, registrationEnabled: 1 });
    const decision = await evaluateProviderPolicy(db, {
      user: { email: "x@y.z", emailVerified: true },
      source: { action: "sign-in", method: "oauth", oauth: { providerId: id, profile: {} } },
    });
    expect(decision).toEqual({ error: "provider_closed" });
  });

  test("an oidc row with registrationEnabled NULL reads CLOSED on create-user (FOLD d)", async () => {
    // The route normalizes oidc rows to explicit 0/1; NULL there is a hand
    // edit. The legacy dynamic window belongs to the EMAIL provider alone, so
    // evaluate coerces NULL→closed on non-email rows rather than letting the
    // pure cascade's `=== false` read it as open.
    const id = `nullreg-${crypto.randomUUID().slice(0, 8)}`;
    await makeOidcProvider(id, { signInEnabled: 1 }); // registrationEnabled left NULL by the DB default
    const decision = await evaluateProviderPolicy(db, {
      user: { email: `new@${id}.example.test`, emailVerified: true },
      source: { action: "create-user", method: "oauth", oauth: { providerId: id, profile: {} } },
    });
    expect(decision).toEqual({ error: "registration_closed" });
  });

  test("the email provider consults registrationOpen (explicit 0 refuses create-user)", async () => {
    const emailRow = new AuthProvidersRepository(db);
    const stored = (await emailRow.getById("email"))?.registrationEnabled;
    try {
      await emailRow.update("email", { registrationEnabled: 0, signInEnabled: 1 });
      const decision = await evaluateProviderPolicy(db, {
        user: { email: "newcomer@example.test", emailVerified: false },
        source: { action: "create-user", method: "email-password" },
      });
      expect(decision).toEqual({ error: "registration_closed" });
    } finally {
      await emailRow.update("email", { registrationEnabled: stored ?? null });
    }
  });

  test("the email provider with an explicit 1 lets create-user through", async () => {
    const emailRow = new AuthProvidersRepository(db);
    const stored = (await emailRow.getById("email"))?.registrationEnabled;
    try {
      await emailRow.update("email", { registrationEnabled: 1, signInEnabled: 1 });
      const decision = await evaluateProviderPolicy(db, {
        user: { email: `ok-${crypto.randomUUID()}@example.test`, emailVerified: false },
        source: { action: "create-user", method: "email-password" },
      });
      expect(decision).toBeUndefined();
    } finally {
      await emailRow.update("email", { registrationEnabled: stored ?? null });
    }
  });

  test("emailVerified falls back to the raw provider profile's claim", async () => {
    const id = `ver-${crypto.randomUUID().slice(0, 8)}`;
    await makeOidcProvider(id, { registrationEnabled: 1 });
    // The link path hands the UNMAPPED profile beside the user record; the
    // verified claim may live in either spelling.
    const denied = await evaluateProviderPolicy(db, {
      user: { email: `u@${id}.example.test`, emailVerified: false },
      source: { action: "link-account", method: "oauth", oauth: { providerId: id, profile: {} } },
    });
    expect(denied).toEqual({ error: "unverified_email" });
    const allowed = await evaluateProviderPolicy(db, {
      user: { email: `u@${id}.example.test`, emailVerified: false },
      source: { action: "link-account", method: "oauth", oauth: { providerId: id, profile: { email_verified: true } } },
    });
    expect(allowed).toBeUndefined();
  });

  test("an unrecognized action reads as sign-in, not as create-user", async () => {
    // The three spellings are 1.7.1's whole set; a future rename must not
    // gain the registration gate's benefit of the doubt in the wrong
    // direction. Sign-in is the action that never consults registration.
    const id = `act-${crypto.randomUUID().slice(0, 8)}`;
    await makeOidcProvider(id, { registrationEnabled: 0 });
    const decision = await evaluateProviderPolicy(db, {
      user: { email: `s@${id}.example.test`, emailVerified: true },
      source: { action: "some-future-action", method: "oauth", oauth: { providerId: id, profile: {} } },
    } as never);
    expect(decision).toBeUndefined();
  });

  test("an email whose user has no meta row is treated as approved, not nobody", async () => {
    // The LEFT JOIN shape: the person EXISTS (their create-user/link must not
    // sail past the pending gate as if they were new), and an absent meta
    // row is the `asApprovalState` "approved" reading, not null.
    const id = `orphan-${crypto.randomUUID().slice(0, 8)}`;
    await makeOidcProvider(id, { registrationEnabled: 0 });
    const email = `orphan@${id}.example.test`;
    await makeUser(email);
    const decision = await evaluateProviderPolicy(db, {
      user: { email, emailVerified: true },
      source: { action: "sign-in", method: "oauth", oauth: { providerId: id, profile: {} } },
    });
    expect(decision).toBeUndefined(); // sign-in as approved
  });
});

describe("markApprovalProviderArrival (account.create.after)", () => {
  test("a fresh arrival at a require-approval provider is marked pending and demoted", async () => {
    // The exact §6 moment: `user.create.after` has just minted admin for this
    // brand-new user (an instance with no admin yet), and the provider's
    // account row now lands. One account on the user IS the arrival proof.
    const id = `arrive-${crypto.randomUUID().slice(0, 8)}`;
    await makeOidcProvider(id, { registrationEnabled: 1, requireApproval: 1 });
    const userId = await makeUser(`${id}@example.test`);
    const meta = new UserMetaRepository(db);
    await meta.upsert({ userId, role: "admin" }); // what promotion would have written
    await meta.setSetupStep(userId, "network");
    const accountId = await makeAccount(userId, id);
    await markApprovalProviderArrival({ id: accountId, providerId: id, userId });
    const row = await db
      .selectFrom("userMeta")
      .select(["role", "setupStep", "approvalState", "pendingArrivedAt"])
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      role: "user",
      setupStep: null,
      approvalState: "pending",
      pendingArrivedAt: row.pendingArrivedAt,
    });
    expect(row.pendingArrivedAt).not.toBeNull();
  });

  test("a LINK at a require-approval provider is not pended and never demotes", async () => {
    // The hazard the arrival gate closes: `linkAccount` runs through the
    // same adapter create, and the linking user here is an EXISTING admin —
    // hooking the link would pend them and bypass the last-admin guard.
    const id = `link-${crypto.randomUUID().slice(0, 8)}`;
    await makeOidcProvider(id, { registrationEnabled: 1, requireApproval: 1 });
    const userId = await makeUser(`${id}@example.test`);
    const meta = new UserMetaRepository(db);
    await meta.upsert({ userId, role: "admin" });
    await makeAccount(userId, "credential"); // the pre-existing credential account
    const linkId = await makeAccount(userId, id); // the link firing this seam
    await markApprovalProviderArrival({ id: linkId, providerId: id, userId });
    const row = await db
      .selectFrom("userMeta")
      .select(["role", "approvalState", "pendingArrivedAt"])
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ role: "admin", approvalState: "approved", pendingArrivedAt: null });
  });

  test("the email provider (credential) and non-approval providers are skipped", async () => {
    const id = `plain-${crypto.randomUUID().slice(0, 8)}`;
    await makeOidcProvider(id, { registrationEnabled: 1 }); // requireApproval left at 0
    const userId = await makeUser(`${id}@example.test`);
    await new UserMetaRepository(db).upsert({ userId, role: "admin" });
    const a1 = await makeAccount(userId, "credential");
    await markApprovalProviderArrival({ id: a1, providerId: "credential", userId });
    const a2 = await makeAccount(userId, id);
    await markApprovalProviderArrival({ id: a2, providerId: id, userId });
    const row = await db
      .selectFrom("userMeta")
      .select(["role", "approvalState"])
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ role: "admin", approvalState: "approved" });
  });

  test("an unknown providerId (passkey rows and friends) is skipped", async () => {
    const userId = await makeUser(`pk-${crypto.randomUUID()}@example.test`);
    await new UserMetaRepository(db).upsert({ userId, role: "admin" });
    const a = await makeAccount(userId, "passkey");
    await markApprovalProviderArrival({ id: a, providerId: "passkey", userId });
    const row = await db
      .selectFrom("userMeta")
      .select(["role", "approvalState"])
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ role: "admin", approvalState: "approved" });
  });
});

describe("UserMetaRepository approval methods", () => {
  test("demoteAdminIfAutoPromoted only touches the row §6 just minted admin for", async () => {
    const userId = await makeUser(`undo-${crypto.randomUUID()}@example.test`);
    const repo = new UserMetaRepository(db);
    await repo.upsert({ userId, role: "admin" });
    await repo.setApproval(userId, "pending", { arrivedAt: new Date().toISOString() });
    await repo.demoteAdminIfAutoPromoted(userId);
    const meta = await db.selectFrom("userMeta").selectAll().where("userId", "=", userId).executeTakeFirstOrThrow();
    expect(meta.role).toBe("user");
    expect(meta.setupStep).toBeNull();
    expect(meta.approvalState).toBe("pending"); // the demote leaves the queue state alone
  });

  test("demoteAdminIfAutoPromoted does not touch a non-admin row", async () => {
    const userId = await makeUser(`plain-${crypto.randomUUID()}@example.test`);
    const repo = new UserMetaRepository(db);
    await repo.upsert({ userId, role: "user" });
    await repo.setSetupStep(userId, "network"); // a bookmark the demote must NOT clear on a plain row
    await repo.demoteAdminIfAutoPromoted(userId);
    const meta = await db
      .selectFrom("userMeta")
      .select(["role", "setupStep"])
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(meta).toEqual({ role: "user", setupStep: "network" });
  });

  test("approvalState reads an absent row as approved, and setApproval stamps by state", async () => {
    const repo = new UserMetaRepository(db);
    const ghostId = crypto.randomUUID();
    expect(await repo.approvalState(ghostId)).toBe("approved");

    const userId = await makeUser(`stamp-${crypto.randomUUID()}@example.test`);
    const arrivedAt = "2026-09-24T00:00:00.000Z";
    await repo.setApproval(userId, "pending", { arrivedAt });
    let row = await db
      .selectFrom("userMeta")
      .select(["approvalState", "pendingArrivedAt"])
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ approvalState: "pending", pendingArrivedAt: arrivedAt });

    await repo.setApproval(userId, "approved");
    row = await db
      .selectFrom("userMeta")
      .select(["approvalState", "pendingArrivedAt"])
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ approvalState: "approved", pendingArrivedAt: null });
    expect(await repo.approvalState(userId)).toBe("approved");
  });

  test("touchPendingArrivedByEmail only stamps the pending", async () => {
    const repo = new UserMetaRepository(db);
    const email = `touch-${crypto.randomUUID()}@example.test`;
    const userId = await makeUser(email);
    await repo.setApproval(userId, "pending", { arrivedAt: "2026-01-01T00:00:00.000Z" });
    await repo.touchPendingArrivedByEmail(email, "2026-09-24T12:00:00.000Z");
    let row = await db
      .selectFrom("userMeta")
      .select("pendingArrivedAt")
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row.pendingArrivedAt).toBe("2026-09-24T12:00:00.000Z");

    await repo.setApproval(userId, "approved");
    await repo.touchPendingArrivedByEmail(email, "2026-09-25T00:00:00.000Z");
    row = await db
      .selectFrom("userMeta")
      .select("pendingArrivedAt")
      .where("userId", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row.pendingArrivedAt).toBeNull(); // an approved row is never re-stamped
  });
});
