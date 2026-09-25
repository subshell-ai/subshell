import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";
import { usersRoutes } from "@/api/users/index.js";
import { createHeldEmailGuardBeforeHook, heldEmailMessage, oidcHolderNameByEmail } from "@/auth/held-email-guards.js";
import { getAuth, invalidateAuth, setAuthPolicyDb } from "@/auth.js";
import { APP_BASE_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { NewAuthProvider } from "@/db/types/auth-providers.db-types.js";
import { authPlugin } from "@/plugins/auth.plugin.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";
import { type FakeIdp, startFakeIdp } from "./helpers/fake-oidc.js";

/**
 * The provider-NAMED refusal of email sign-ups for OIDC-held addresses
 * (spec 2026-09-24 §5, operator ruling). The seam is `hooks.before` on
 * `/sign-up/email` — MEASURED on better-auth 1.7.1 (`dist/api/routes/
 * sign-up.mjs`): the route throws `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`
 * (422) on `findUserByEmail` BEFORE `internalAdapter.createUser`, and
 * `createUser` is where `validateUserInfo` and `user.create.before` fire —
 * so neither provisioning seam ever sees a held address, and only the before
 * hook can name the provider. Its wire shape is pinned here end-to-end, the
 * same way `oidc-signin-flow.test.ts` pins the provider policy: fake issuer,
 * real `auth_providers` rows, real round trips.
 *
 * The cases are the requirement list: (a) pending holder, (b) approved
 * holder, (c) rejected holder — all named, with (a) pinning the sentence's
 * LITERAL bytes (T17 review: every other assertion compared against the
 * producing helper, so a copy rewrite could drift both sides and pass);
 * (d) credential-only duplicate — generic, unchanged; (e) closed gate + held
 * address — STILL registration_closed, byte-identical to the free-address
 * answer (order + no-leak proof); (f) the admin `POST /api/users` twin —
 * GENERIC even for a provider-held address (spec §5 governs; the T17 fix round
 * reverted the named twin that shipped first); (g) the wizard-safety case: a
 * fresh address signs up exactly as before (the guard early-returns when
 * nobody holds it — the real zero-user first run cannot be reproduced against
 * this per-process shared DB, which is why the case states the gate open, the
 * one condition the first-run window also satisfies); (h) a DISABLED provider row
 * still names its provider and (i) a DELETED one names nothing — the two
 * one-line-SQL flips the T17 review flagged, each pinned on HTTP.
 *
 * Shared-DB discipline mirrors the sibling matrix: random ids, purged rows,
 * the E-mail row restored to its seeded NULL, `invalidateAuth()` + `getAuth()`
 * at the end.
 */

const app = new Elysia().use(authPlugin);
const ORIGIN = APP_BASE_URL; // forced to http://localhost:<port> under IS_TEST

const providers = new AuthProvidersRepository(db);
const meta = new UserMetaRepository(db);
const users = new UsersRepository(db);

let idp: FakeIdp;

const providerIds: string[] = [];
const fixtureEmails: string[] = [];
const flowStates: string[] = [];
/** User ids this file may have written meta/account rows for. */
const fixtureUserIds: string[] = [];

function emailN(tag: string): string {
  const e = `t17-${tag}-${crypto.randomUUID()}@subshell.test`;
  fixtureEmails.push(e);
  return e;
}

function profileFor(email: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const stable = String(over.id ?? `acct-of-${email}`);
  return { id: stable, sub: stable, email, email_verified: true, name: "T17 Fake", ...over };
}

async function mkProvider(over: Partial<NewAuthProvider> = {}): Promise<string> {
  const id = over.id ?? `t17-${crypto.randomUUID().slice(0, 8)}`;
  await providers.create({
    id,
    kind: "oidc",
    name: `T17 provider ${id}`,
    issuer: idp.url,
    clientId: "t17-client",
    endpointsJson: JSON.stringify({
      authorizationUrl: `${idp.url}/authorize`,
      tokenUrl: `${idp.url}/token`,
      userInfoUrl: `${idp.url}/userinfo`,
    }),
    entryOrigins: JSON.stringify([ORIGIN]),
    allowedDomains: null,
    enabled: 1,
    signInEnabled: 1,
    registrationEnabled: 1,
    requireApproval: 0,
    ...over,
  });
  providerIds.push(id);
  invalidateAuth();
  return id;
}

/** Drives one full OIDC flow; classification copied from the sibling matrix. */
async function runFlow(providerId: string, profile: Record<string, unknown>): Promise<"session" | "error" | "http"> {
  idp.setProfile(profile);
  const start = (await app.fetch(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: providerId, callbackURL: "/", errorCallbackURL: "/login" }),
    }),
  )) as Response;
  expect(start.status).toBe(200);
  const { url: authorizeUrl } = (await start.json()) as { url?: string };
  if (typeof authorizeUrl !== "string") throw new Error("sign-in/social returned no authorize URL");
  const state = new URL(authorizeUrl).searchParams.get("state");
  if (state) flowStates.push(state);
  const cookie = start.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(cookie).not.toBe("");

  const toIdp = await idp.handle(new Request(authorizeUrl));
  expect(toIdp.status).toBe(302);
  const callbackUrl = toIdp.headers.get("location");
  if (!callbackUrl) throw new Error("the fake issuer did not 302 back to the callback");

  const cb = (await app.fetch(new Request(callbackUrl, { headers: { cookie } }))) as Response;
  const location = cb.headers.get("location");
  if (location && /^\/login(\?|$)/.test(location)) return "error";
  const token = (cb.headers
    .getSetCookie()
    .join("\n")
    .match(/better-auth\.session_token=([^;]+)/) ?? [])[1];
  if (cb.status >= 300 && cb.status < 400 && token) return "session";
  return "http";
}

/** POSTs the real `/sign-up/email` the way a browser form would. */
async function signUpAttempt(email: string, password = "t17-pass-1"): Promise<Response> {
  return (await app.fetch(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password, name: "T17 Attempt" }),
    }),
  )) as Response;
}

async function userIdFor(email: string): Promise<string | undefined> {
  const { rows } = await sql<{ id: string }>`SELECT id FROM user WHERE email = ${email}`.execute(db);
  return rows[0]?.id;
}

async function rowCount(email: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM user WHERE email = ${email}`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

async function sessionCount(userId: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM session WHERE userId = ${userId}`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

async function countSignInRows(): Promise<number> {
  const row = await db
    .selectFrom("auditEvents")
    .select((eb) => eb.fn.count("id").as("n"))
    .where("action", "=", "auth.sign_in")
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

async function setEmailRegistration(stored: number | null): Promise<void> {
  await providers.update("email", { registrationEnabled: stored });
}

/** Raw insert of a second provider's `account` row (better-auth's own tables;
 * `issuer` is NOT NULL and carries the provider's issuer for OAuth rows — the
 * credential shape "local:credential" is UsersRepository.createUser's half
 * of the same schema). */
async function insertProviderAccount(userId: string, providerId: string): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO account (id, issuer, accountId, providerId, userId, createdAt, updatedAt)
    VALUES (${crypto.randomUUID()}, ${idp.url}, ${`sub-${providerId}-${userId}`}, ${providerId}, ${userId}, ${now}, ${now})
  `.execute(db);
}

async function purgeFixture(email: string): Promise<void> {
  const id = await userIdFor(email);
  if (id) {
    fixtureUserIds.push(id);
    await db.deleteFrom("userMeta").where("userId", "=", id).execute();
    await sql`DELETE FROM session WHERE userId = ${id}`.execute(db);
    await sql`DELETE FROM account WHERE userId = ${id}`.execute(db);
  }
  await deleteUserByEmailOrId(email);
  await sql`DELETE FROM auth_attempts WHERE email = ${email}`.execute(db);
}

beforeAll(async () => {
  await setupAuthTables();
  setAuthPolicyDb(db);
  idp = await startFakeIdp({});
});

afterAll(async () => {
  for (const email of fixtureEmails) await purgeFixture(email);
  for (const id of providerIds) await providers.remove(id);
  // Restore the seeded E-mail row default the sibling suites assume.
  await setEmailRegistration(null);
  expect(flowStates.length).toBeGreaterThan(0);
  for (const state of flowStates) {
    await sql`DELETE FROM verification WHERE identifier = ${state}`.execute(db);
  }
  // Audit hygiene for the actors this file signed in / acted as.
  for (const id of [...new Set(fixtureUserIds)]) {
    await db.deleteFrom("auditEvents").where("actorUserId", "=", id).execute();
  }
  invalidateAuth();
  getAuth();
  idp.close();
});

describe("held-email lookup + hook (unit)", () => {
  it("names nobody for nobody, and nobody for a credential-only holder", async () => {
    expect(await oidcHolderNameByEmail(db, `t17-absent-${crypto.randomUUID()}@subshell.test`)).toBeUndefined();
    const email = emailN("unit-cred");
    const id = await users.createUser({
      email,
      name: email,
      passwordHash: await hashPassword("t17-pass-1"),
      role: "user",
    });
    fixtureUserIds.push(id);
    expect(await oidcHolderNameByEmail(db, email)).toBeUndefined();
    await purgeFixture(email);
  });

  it("names the LOWEST matching provider id among several providers (the queue's MIN rule)", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    // Byte order is decided by the first differing character, so `-lower-`
    // sorts below `-upper-` whatever the random suffix carries.
    const lower = await mkProvider({ id: `t17-lower-${suffix}`, name: "T17 Lower Provider" });
    const upper = await mkProvider({ id: `t17-upper-${suffix}`, name: "T17 Upper Provider" });
    const email = emailN("unit-min");
    const id = await users.createUser({
      email,
      name: email,
      passwordHash: await hashPassword("t17-pass-1"),
      role: "user",
    });
    fixtureUserIds.push(id);
    // Seed the providers in the WRONG order so the pick cannot pass on insertion.
    await insertProviderAccount(id, upper);
    await insertProviderAccount(id, lower);
    expect(await oidcHolderNameByEmail(db, email)).toBe("T17 Lower Provider");
    await purgeFixture(email);
  });

  it("the hook passes through non-sign-up paths, bodyless requests, and the pre-boot gap", async () => {
    const hook = createHeldEmailGuardBeforeHook(() => db);
    // The gate is opened first: with it closed the guard throws
    // registration_closed for EVERY valid-email sign-up attempt (the
    // gate-first order, proven on HTTP below), which would mask the
    // pass-throughs this case is about.
    await setEmailRegistration(1);
    try {
      await expect(hook({ path: "/sign-in/email", body: { email: "whoever@subshell.test" } })).resolves.toBeUndefined();
      await expect(hook({ path: "/sign-up/email" })).resolves.toBeUndefined();
      await expect(hook({ path: "/sign-up/email", body: {} })).resolves.toBeUndefined();
      await expect(hook({ path: "/sign-up/email", body: { email: 42 } })).resolves.toBeUndefined();
      // An unheld address on an OPEN gate: nothing to name, no refusal.
      await expect(hook({ path: "/sign-up/email", body: { email: "whoever@subshell.test" } })).resolves.toBeUndefined();
      const noDb = createHeldEmailGuardBeforeHook(() => undefined);
      await expect(noDb({ path: "/sign-up/email", body: { email: "whoever@subshell.test" } })).resolves.toBeUndefined();
    } finally {
      await setEmailRegistration(null);
    }
  });
});

describe("sign-up refusal names the holding provider (spec §5, HTTP)", () => {
  // (a) A PENDING arrival holds its email too — the row exists — and gets the
  // named answer, with no second user, no session, and no audit row.
  it("(a) a pending OIDC holder gets the named refusal, writing nobody", async () => {
    const providerName = "T17 Approving Co";
    const provider = await mkProvider({ name: providerName, requireApproval: 1 });
    const email = emailN("pending");
    expect(await runFlow(provider, profileFor(email))).toBe("error"); // pending: session refused
    const holderId = (await userIdFor(email)) ?? "";
    expect(holderId).toBeTruthy();
    fixtureUserIds.push(holderId);
    expect(await meta.approvalState(holderId)).toBe("pending");

    await setEmailRegistration(1); // the sign-up must speak past the gate to reach the named branch
    try {
      const before = await countSignInRows();
      const res = await signUpAttempt(email);
      expect(res.status).toBe(403);
      // THE LITERAL WIRE PIN (T17 review): the sentence's own bytes, concrete
      // provider name and exact punctuation — not `heldEmailMessage(providerName)`,
      // so a copy rewrite fails here instead of passing on both sides.
      expect(((await res.json()) as { message?: string }).message).toBe(
        "An account for this e-mail exists. Sign in with T17 Approving Co.",
      );
      expect(await rowCount(email)).toBe(1); // nobody new behind the refusal
      expect(await sessionCount(holderId)).toBe(0); // and no session for the attempt
      expect(await countSignInRows()).toBe(before); // a refused sign-up writes nothing
    } finally {
      await setEmailRegistration(null);
    }
    await purgeFixture(email);
  });

  // (b) The approved OIDC-only holder — the person who would otherwise get
  // better-auth's generic sentence today — gets the provider named.
  it("(b) an approved OIDC-only holder gets the named refusal", async () => {
    const providerName = "T17 Front Gate";
    const provider = await mkProvider({ name: providerName });
    const email = emailN("approved");
    expect(await runFlow(provider, profileFor(email))).toBe("session");
    const holderId = (await userIdFor(email)) ?? "";
    expect(holderId).toBeTruthy();
    fixtureUserIds.push(holderId);

    await setEmailRegistration(1);
    try {
      const res = await signUpAttempt(email);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { message?: string }).message).toBe(heldEmailMessage(providerName));
      expect(await rowCount(email)).toBe(1);
      expect(await sessionCount(holderId)).toBe(1); // still exactly their own arrival session
    } finally {
      await setEmailRegistration(null);
    }

    // (e, first half) the SAME held address, gate closed: the gate answers,
    // not the name — and with the exact bytes a free address gets, so the
    // closed provider cannot be probed for holders.
    await setEmailRegistration(0);
    try {
      const held = await signUpAttempt(email);
      expect(held.status).toBe(403);
      const heldBody = (await held.json()) as { code?: string; message?: string };
      expect(heldBody.code).toBe("registration_closed");
      expect(heldBody.message).toBe("registration_closed"); // no provider named anywhere
      const free = await signUpAttempt(emailN("closed-free-control"));
      expect(free.status).toBe(403);
      // The uniform answer: a held address and a free one are the same bytes,
      // so the closed gate cannot be probed for holders.
      expect(await free.json()).toEqual(heldBody);
    } finally {
      await setEmailRegistration(null);
    }

    // (c) A rejected arrival holds the address the same way — same wording,
    // nothing that invites approval-seeking beyond the sentence.
    await meta.setApproval(holderId, "rejected");
    await setEmailRegistration(1);
    try {
      const res = await signUpAttempt(email);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { message?: string }).message).toBe(heldEmailMessage(providerName));
    } finally {
      await setEmailRegistration(null);
    }
    await purgeFixture(email);
  });

  // (d) The requirement's "nothing changes" half: a credential duplicate with
  // the gate open still gets better-auth's own sentence, untouched.
  it("(d) a credential-only duplicate keeps the generic refusal, pinned", async () => {
    const email = emailN("credential");
    const id = await users.createUser({
      email,
      name: email,
      passwordHash: await hashPassword("t17-pass-1"),
      role: "user",
    });
    fixtureUserIds.push(id);
    await setEmailRegistration(1);
    try {
      const res = await signUpAttempt(email);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { message?: string }).message).toBe("User already exists. Use another email.");
      expect(await rowCount(email)).toBe(1);
    } finally {
      await setEmailRegistration(null);
    }
    await purgeFixture(email);
  });

  // (g) Wizard safety: the first-run screen calls `signUp.email` on a fresh
  // address; the guard can only fire when a holder EXISTS, and a fresh
  // address has none — the successful sign-up below is that early return.
  // (The literal zero-user first run is not reproducible on the shared
  // per-process DB; the gate is opened explicitly because the first-run
  // window's `registrationOpen` answer — TRUE — is the condition being
  // reproduced, not the row encoding.)
  it("(g) an unheld email signs up through the guard, untouched", async () => {
    const email = emailN("wizard");
    await setEmailRegistration(1);
    try {
      const res = await signUpAttempt(email);
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie().join("\n")).toContain("better-auth.session_token=");
      expect(await rowCount(email)).toBe(1);
    } finally {
      await setEmailRegistration(null);
    }
    await purgeFixture(email);
  });
});

describe("sign-up refusal edge pins (T17 review)", () => {
  // (h) A provider row present but `enabled = 0` STILL names its provider:
  // disabling takes away sign-in availability, not the fact that the address
  // arrived through that provider. Pinned on HTTP — an `AND p.enabled = 1`
  // slipped into the lookup SQL would silently downgrade these holders to
  // the generic sentence and nothing else would notice.
  it("(h) a disabled provider row still names its provider", async () => {
    const providerName = "T17 Switched-off Gate";
    const provider = await mkProvider({ name: providerName });
    const email = emailN("disabled-provider");
    expect(await runFlow(provider, profileFor(email))).toBe("session"); // arrives while the provider is open
    const holderId = (await userIdFor(email)) ?? "";
    expect(holderId).toBeTruthy();
    fixtureUserIds.push(holderId);

    await providers.update(provider, { enabled: 0 });
    invalidateAuth();
    await setEmailRegistration(1);
    try {
      const res = await signUpAttempt(email);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { message?: string }).message).toBe(heldEmailMessage(providerName));
    } finally {
      await setEmailRegistration(null);
      await providers.update(provider, { enabled: 1 });
      invalidateAuth();
    }
    await purgeFixture(email);
  });

  // (i) The provider row DELETED — the account's providerId names no
  // `auth_providers` row — names nothing and falls through to better-auth's
  // own generic answer. The mirror pin of (h): loosening the JOIN (LEFT JOIN,
  // or dropping the `auth_providers` constraint) would resurrect a name for
  // a provider the admin deliberately erased.
  it("(i) a deleted provider row falls through to the generic answer", async () => {
    const provider = await mkProvider({ name: "T17 Erased Gate" });
    const email = emailN("deleted-provider");
    expect(await runFlow(provider, profileFor(email))).toBe("session");
    const holderId = (await userIdFor(email)) ?? "";
    expect(holderId).toBeTruthy();
    fixtureUserIds.push(holderId);

    await providers.remove(provider); // afterAll repeats this; remove() tolerates absence
    invalidateAuth();
    await setEmailRegistration(1);
    try {
      const res = await signUpAttempt(email);
      expect(res.status).toBe(422); // better-auth's untouched duplicate answer
      expect(((await res.json()) as { message?: string }).message).toBe("User already exists. Use another email.");
      expect(await rowCount(email)).toBe(1); // and still nothing created behind it
    } finally {
      await setEmailRegistration(null);
    }
    await purgeFixture(email);
  });
});

describe("POST /api/users keeps the generic answer (spec §5 governs)", () => {
  // (f, reverted in the T17 fix round) The admin twin answers GENERIC even
  // when an OIDC provider holds the address: spec §5 says an admin typing an
  // email that exists does not need a provider name back. The named refusal
  // belongs to the public sign-up provider alone. (The credential-holder site's
  // generic sentence is pinned in users-admin.test.ts.)
  it("(f) an admin create for an OIDC-held email answers the generic 409", async () => {
    const providerName = "T17 Admin-held Gate";
    const provider = await mkProvider({ name: providerName });
    const heldEmail = emailN("admin-held");
    expect(await runFlow(provider, profileFor(heldEmail))).toBe("session");
    const holderId = (await userIdFor(heldEmail)) ?? "";
    expect(holderId).toBeTruthy();
    fixtureUserIds.push(holderId);

    const adminEmail = emailN("t17-admin");
    const adminPw = "t17-admin-pass-1";
    const adminId = await users.createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(adminPw),
      role: "admin",
    });
    fixtureUserIds.push(adminId);
    const adminCookie = await signIn(adminEmail, adminPw);

    const res = await usersRoutes.fetch(
      authedRequest("/api/users", adminCookie, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "T17 Dup", email: heldEmail, password: "t17-admin-pass-2", role: "user" }),
      }),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toBe("E-mail already registered"); // the generic sentence for every holder
    expect(text).not.toContain(providerName); // no provider named here, held or not
    expect(await rowCount(heldEmail)).toBe(1); // the refusal created nothing

    await purgeFixture(heldEmail);
    await purgeFixture(adminEmail);
  });
});
