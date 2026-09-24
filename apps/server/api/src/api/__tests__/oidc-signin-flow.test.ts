import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";
import { getAuth, invalidateAuth, setAuthPolicyDb } from "@/auth.js";
import { APP_BASE_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { NewAuthProvider } from "@/db/types/auth-providers.db-types.js";
import { authPlugin } from "@/plugins/auth.plugin.js";
import { deleteUserByEmailOrId, setupAuthTables } from "./helpers/auth-tables.js";
import { type FakeIdp, startFakeIdp } from "./helpers/fake-oidc.js";

/**
 * The end-to-end sign-in matrix (spec 2026-09-24 §4/§5/§6/§7): a fake OIDC
 * issuer, real `auth_providers` rows, and the whole better-auth round trip
 * driven server-side — `POST /api/auth/sign-in/social` → the IdP's `/authorize`
 * 302 → `GET /api/auth/callback/<id>` with the state cookie carried back — so
 * every refusal is asserted as the wire shape the login page actually
 * receives (`/login?error=<code>[&error_description=…]`), not as a unit-level
 * call of the policy function. Cases name the spec section they prove.
 *
 * What the matrix deliberately does NOT assert: anything about the UI
 * mapping of a code. The `auth.sign_in` audit invariant (spec §4: exactly one
 * row per OIDC success, none per refusal, and the password path keeps
 * spelling itself `password`) IS asserted, per case, with the target user's
 * rows cleared before each flow so the counts are exact.
 *
 * Shared-DB discipline: the per-process temp database is shared by every test
 * file in the invocation, so this file creates its doors and users with random
 * ids, purges them as it goes, restores the E-mail row's seeded defaults, and
 * ends with `invalidateAuth()` + `getAuth()` so the next sibling file gets a
 * door-less auth build.
 */

const app = new Elysia().use(authPlugin);
const ORIGIN = APP_BASE_URL; // forced to http://localhost:<port> under IS_TEST

const doors = new AuthProvidersRepository(db);
const meta = new UserMetaRepository(db);
const users = new UsersRepository(db);

let idp: FakeIdp;

/** Door ids created by this file; removed in afterAll. */
const providerIds: string[] = [];
/** Every email this file may have written a user for; purged in afterAll. */
const fixtureEmails: string[] = [];

function emailN(tag: string): string {
  const e = `t7-${tag}-${crypto.randomUUID()}@subshell.test`;
  fixtureEmails.push(e);
  return e;
}

/**
 * A userinfo profile. `id` is stable per address because the fake is discovered
 * by nothing (explicit endpoints), which makes genericOAuth's account subject
 * `profile.id`; repeat flows for one address must present one account subject
 * or they would not re-find the same account row.
 */
function profileFor(email: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const stable = String(over.id ?? `acct-of-${email}`);
  return { id: stable, sub: stable, email, email_verified: true, name: "T7 Fake", ...over };
}

/** Seeds a door pointing at the fake issuer and rebuilds auth to see it. */
async function mkDoor(over: Partial<NewAuthProvider> = {}): Promise<string> {
  const id = `t7-${crypto.randomUUID().slice(0, 8)}`;
  await doors.create({
    id,
    kind: "oidc",
    name: "T7 fake door",
    issuer: idp.url,
    clientId: "t7-client",
    endpointsJson: JSON.stringify({
      authorizationUrl: `${idp.url}/authorize`,
      tokenUrl: `${idp.url}/token`,
      userInfoUrl: `${idp.url}/userinfo`,
    }),
    entryOrigins: JSON.stringify([ORIGIN]),
    allowedDomains: null,
    enabled: 1,
    signInEnabled: 1,
    // Explicit 1 on an oidc row: NULL reads CLOSED to the door policy (§2), so
    // a door that lets anyone in must SAY 1.
    registrationEnabled: 1,
    requireApproval: 0,
    ...over,
  });
  providerIds.push(id);
  invalidateAuth();
  return id;
}

type FlowResult =
  | {
      kind: "session";
      token: string;
      code?: undefined;
      description?: undefined;
      location: string | null;
      status: number;
    }
  | { kind: "error"; token?: undefined; code: string; description: string | null; location: string; status: number }
  | {
      kind: "http";
      token?: undefined;
      code?: undefined;
      description?: undefined;
      location: string | null;
      status: number;
    };

/**
 * Drives one full flow and classifies the callback response. Success is the
 * 3xx to `/` WITH a session cookie (a redirect without one is a `http`, never
 * a pass); a refusal is the 3xx to `/login?error=<code>` and carries the code
 * and `error_description` verbatim for the caller to assert.
 */
async function runFlow(doorId: string, profile: Record<string, unknown>): Promise<FlowResult> {
  idp.setProfile(profile);
  const start = (await app.fetch(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: doorId, callbackURL: "/", errorCallbackURL: "/login" }),
    }),
  )) as Response;
  expect(start.status).toBe(200);
  const { url: authorizeUrl } = (await start.json()) as { url?: string };
  if (typeof authorizeUrl !== "string") throw new Error("sign-in/social returned no authorize URL");
  // The flow's state lives in a cookie better-auth sets on this response and
  // re-reads on the callback (CSRF binding); carry every pair back verbatim.
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
  const token = (cb.headers
    .getSetCookie()
    .join("\n")
    .match(/better-auth\.session_token=([^;]+)/) ?? [])[1];
  if (location && /^\/login(\?|$)/.test(location)) {
    const u = new URL(location, ORIGIN);
    return {
      kind: "error",
      code: u.searchParams.get("error") ?? "",
      description: u.searchParams.get("error_description"),
      location,
      status: cb.status,
    };
  }
  if (cb.status >= 300 && cb.status < 400 && token) return { kind: "session", token, location, status: cb.status };
  return { kind: "http", location, status: cb.status };
}

async function userIdFor(email: string): Promise<string | undefined> {
  // Raw SQL: better-auth's `user` table is outside the typed Database.
  const { rows } = await sql<{ id: string }>`SELECT id FROM user WHERE email = ${email}`.execute(db);
  return rows[0]?.id;
}

async function emailVerifiedFlag(userId: string): Promise<number> {
  const { rows } = await sql<{ emailVerified: number }>`SELECT emailVerified FROM user WHERE id = ${userId}`.execute(
    db,
  );
  return rows[0]?.emailVerified ?? -1;
}

async function accountProviders(userId: string): Promise<string[]> {
  const { rows } = await sql<{ providerId: string }>`SELECT providerId FROM account WHERE userId = ${userId}`.execute(
    db,
  );
  return rows.map((r) => r.providerId);
}

async function sessionCount(userId: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM session WHERE userId = ${userId}`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

interface SignInRow {
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadataJson: string | null;
}

/** The file's audit lens: every `auth.sign_in` row whose actor is `userId`. */
async function signInRows(userId: string): Promise<SignInRow[]> {
  return (await db
    .selectFrom("auditEvents")
    .select(["actorUserId", "targetType", "targetId", "metadataJson"])
    .where("action", "=", "auth.sign_in")
    .where("actorUserId", "=", userId)
    .execute()) as unknown as SignInRow[];
}

/**
 * Drops one user's `auth.sign_in` rows so the next flow's count is exact.
 * Shared-DB discipline: scoped to the actor, never a blanket delete — other
 * suites sign in constantly against the same per-process database.
 */
async function clearSignInRows(userId: string): Promise<void> {
  await db.deleteFrom("auditEvents").where("action", "=", "auth.sign_in").where("actorUserId", "=", userId).execute();
}

/** Instance-wide `auth.sign_in` count, for refusals that name no user at all. */
async function countSignInRows(): Promise<number> {
  const row = await db
    .selectFrom("auditEvents")
    .select((eb) => eb.fn.count("id").as("n"))
    .where("action", "=", "auth.sign_in")
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Parses a row's metadata, failing loudly (not silently) on a null row. */
function metaOf(row: SignInRow | undefined): Record<string, unknown> {
  return JSON.parse(row?.metadataJson ?? "null") as Record<string, unknown>;
}

async function purgeByEmail(email: string): Promise<void> {
  const id = await userIdFor(email);
  if (id) {
    await db.deleteFrom("userMeta").where("userId", "=", id).execute();
    await sql`DELETE FROM session WHERE userId = ${id}`.execute(db);
    await sql`DELETE FROM account WHERE userId = ${id}`.execute(db);
  }
  await deleteUserByEmailOrId(email);
  await sql`DELETE FROM auth_attempts WHERE email = ${email}`.execute(db);
}

async function realUserCount(): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM user`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

describe("OIDC sign-in matrix (spec §4/§5/§6/§7, fake issuer)", () => {
  beforeAll(async () => {
    await setupAuthTables();
    // The door policy, the session hook and the door guard all read through
    // the boot-injected app handle; a test file that drives auth must inject
    // it exactly like `index.ts` does.
    setAuthPolicyDb(db);
    idp = await startFakeIdp({});
  });

  afterAll(async () => {
    for (const email of fixtureEmails) await purgeByEmail(email);
    for (const id of providerIds) await doors.remove(id);
    // Restore the seeded E-mail row defaults: the shared test DB outlives this
    // file, and the sibling suites assume `sign_in_enabled=1, registration NULL`.
    await sql`UPDATE auth_providers SET sign_in_enabled = 1, registration_enabled = NULL WHERE id = 'email'`.execute(
      db,
    );
    // A final rebuild so the next file's first getAuth() sees a door-less,
    // email-default instance rather than this file's last configuration.
    invalidateAuth();
    getAuth();
    idp.close();
  });

  // Case 1 — §4 bullet 1: a new email at a plain approved door is created and
  // signed in on first arrival — and the arrival writes EXACTLY ONE
  // `auth.sign_in` (spec §4): the actor/target is the signed-in user's id
  // (the cookie→session-table lookup resolving to the RIGHT user is the
  // proof, not merely that some row appeared), the method names the door, and
  // the never-values rule holds on the serialized row.
  it("1. create through an approved door lands a session", async () => {
    const door = await mkDoor();
    const email = emailN("create");
    const r = await runFlow(door, profileFor(email));
    expect(r.kind).toBe("session");
    expect(r.token).toBeTruthy();
    const id = (await userIdFor(email)) ?? "";
    expect(id).toBeTruthy();
    expect(await meta.approvalState(id)).toBe("approved");
    expect(await accountProviders(id)).toEqual([door]);

    const rows = await signInRows(id); // the user is new: any row is THIS flow's
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetType).toBe("user");
    expect(rows[0]?.targetId).toBe(id);
    expect(metaOf(rows[0])).toEqual({ method: `oidc:${door}`, userId: id });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(r.token ?? " ");
    expect(serialized).not.toContain((r.token ?? "").split(".")[0]); // the raw token, not just the signed cookie

    await purgeByEmail(email);
  });

  // Case 2 — §5's inversion proof. The local row starts at emailVerified=0,
  // which is what every account this instance writes carries; with better-auth's
  // default `requireLocalEmailVerified` the implicit link would die here with
  // the generic "account not linked". AUTH_OPTIONS inverts it, so a VERIFIED
  // provider profile links straight in — and the §5 side effect (better-auth
  // flips the local emailVerified on a verified match) is pinned, not discovered.
  it("2. a verified profile links an existing emailVerified=0 user (§5 inversion + flip)", async () => {
    const door = await mkDoor();
    const email = emailN("link");
    const id = await users.createUser({
      email,
      name: email,
      passwordHash: await hashPassword("t7-pass-1"),
      role: "user",
    });
    expect(await emailVerifiedFlag(id)).toBe(0);

    await clearSignInRows(id); // a pre-existing user: start the count at zero
    const r = await runFlow(door, profileFor(email));
    expect(r.kind).toBe("session");
    expect(await accountProviders(id)).toContain(door);
    expect(await emailVerifiedFlag(id)).toBe(1);

    // The LINK arrival is one sign-in too — and its row names this user,
    // proving the callback's session-token lookup lands on the right account.
    const rows = await signInRows(id);
    expect(rows).toHaveLength(1);
    expect(metaOf(rows[0])).toEqual({ method: `oidc:${door}`, userId: id });

    await purgeByEmail(email);
  });

  // Cases 3–7 are ONE lifecycle on one door and one person: the §6 queue, seen
  // end to end. They run in declaration order on purpose.
  const approvalEmail = emailN("pending");
  const approvalProfile = profileFor(approvalEmail);
  let approvalDoor = "";
  let approvalUserId = "";

  // Case 3 — §4 bullet 2: the account IS created (the queue needs a row), the
  // arrival is marked pending, and the SESSION is what refuses — the generic
  // `unable_to_create_session`, deliberately with no description (it cannot
  // distinguish pending from disabled and must not).
  it("3. first arrival at a require-approval door: row created, session refused generically", async () => {
    approvalDoor = await mkDoor({ requireApproval: 1 });
    const r = await runFlow(approvalDoor, approvalProfile);
    expect(r.kind).toBe("error");
    expect(r.code).toBe("unable_to_create_session");
    expect(r.description).toBeNull();

    approvalUserId = (await userIdFor(approvalEmail)) ?? "";
    expect(approvalUserId).toBeTruthy();
    const m = await db
      .selectFrom("userMeta")
      .selectAll()
      .where("userId", "=", approvalUserId)
      .executeTakeFirstOrThrow();
    expect(m.approvalState).toBe("pending");
    expect(m.pendingArrivedAt).not.toBeNull();
    // No session was minted behind the refusal — and §4's audit half: the
    // refusal writes no `auth.sign_in` either (the session-hook shape).
    expect(await sessionCount(approvalUserId)).toBe(0);
    expect(await signInRows(approvalUserId)).toHaveLength(0);
  });

  // Case 4 — §6: the pending arrival is invisible to the members roster, and
  // its meta row reads `user`, not `admin` — whichever half of the promotion's
  // CASE wrote the role under test (this file's ordering means an admin may
  // already exist, so it is the ELSE branch here; the DEMOTE-UNDO — an arrival
  // that WAS the instance's first-ever account — is proven on a clean scratch
  // DB by Task 6's hook test and cannot be reproduced against the shared
  // per-process DB, where any sibling suite may have seeded a user first).
  it("4. the pending arrival never reaches the roster and never becomes admin", async () => {
    const roster = await users.listWithRoles();
    expect(roster.some((u) => u.email === approvalEmail)).toBe(false);
    const m = await db
      .selectFrom("userMeta")
      .selectAll()
      .where("userId", "=", approvalUserId)
      .executeTakeFirstOrThrow();
    expect(m.role).toBe("user");
    expect(m.approvalState).toBe("pending");
  });

  // Case 5 — §4 bullet 3 + §6 dedup: a repeat knock is refused at
  // `validateUserInfo` with the NAMED code and the email as description (the
  // distinguishable outcome the session hook cannot carry), and the knock
  // re-stamps the queue row. The stamp is aged by hand first so the change
  // assertion cannot pass on two same-millisecond ISO strings.
  it("5. a second arrival while pending: named refusal, email echoed, arrival re-stamped", async () => {
    const stale = "2026-01-01T00:00:00.000Z";
    await meta.setApproval(approvalUserId, "pending", { arrivedAt: stale });

    await clearSignInRows(approvalUserId);
    const r = await runFlow(approvalDoor, approvalProfile);
    expect(r.kind).toBe("error");
    expect(r.code).toBe("pending_approval");
    expect(r.description).toBe(approvalEmail);
    // The hook-code refusal shape writes no audit row either.
    expect(await signInRows(approvalUserId)).toHaveLength(0);

    const m = await db
      .selectFrom("userMeta")
      .selectAll()
      .where("userId", "=", approvalUserId)
      .executeTakeFirstOrThrow();
    expect(m.pendingArrivedAt).not.toBeNull();
    expect(m.pendingArrivedAt).not.toBe(stale);
    expect(Date.parse(String(m.pendingArrivedAt))).toBeGreaterThan(Date.parse(stale));
    // Still the one person: no second user row for the address.
    const { rows } = await sql`SELECT id FROM user WHERE email = ${approvalEmail}`.execute(db);
    expect(rows).toHaveLength(1);
  });

  // Case 6 — §4/§8: approval moves the row out of the queue, and the NEXT
  // arrival signs straight in. No invalidateAuth here on purpose: the approval
  // state is read live by the hooks, not built into the config — that
  // asymmetry (door config rebuilds, user state does not) is part of what this
  // case pins.
  it("6. after an admin approval the next arrival signs straight in", async () => {
    await meta.setApproval(approvalUserId, "approved");
    await clearSignInRows(approvalUserId);
    const r = await runFlow(approvalDoor, approvalProfile);
    expect(r.kind).toBe("session");
    expect(r.token).toBeTruthy();

    // §4's invariant on the SAME actor across the lifecycle: the two refused
    // arrivals (cases 3/5) wrote nothing, so this success is the user's only
    // sign_in row — one row per SUCCESS, none per refusal, cumulatively.
    const rows = await signInRows(approvalUserId);
    expect(rows).toHaveLength(1);
    expect(metaOf(rows[0])).toEqual({ method: `oidc:${approvalDoor}`, userId: approvalUserId });
  });

  // Case 7 — §4's indistinguishability: a rejected person gets the PENDING
  // person's screen — same code, same description — and the rejected row is
  // NOT re-stamped (§6: it answers the queue's view only while pending).
  it("7. rejection answers the identical pending wire, and does not re-enter the queue", async () => {
    await meta.setApproval(approvalUserId, "rejected");
    await clearSignInRows(approvalUserId);
    expect((await runFlow(approvalDoor, approvalProfile)).code).toBe("pending_approval");

    const r = await runFlow(approvalDoor, approvalProfile);
    expect(r.kind).toBe("error");
    expect(r.code).toBe("pending_approval");
    expect(r.description).toBe(approvalEmail);
    // A rejected person's refused knocks write no audit row (three flows in
    // this case: two refusals here, case 6's success was cleared above).
    expect(await signInRows(approvalUserId)).toHaveLength(0);
    const m = await db
      .selectFrom("userMeta")
      .selectAll()
      .where("userId", "=", approvalUserId)
      .executeTakeFirstOrThrow();
    // Leaving pending cleared the stamp (case 7's own setApproval); the refused
    // knocks must not put it back.
    expect(m.pendingArrivedAt).toBeNull();

    await purgeByEmail(approvalEmail);
  });

  // Case 8 — §4 bullet 4: a closed door refuses a NEW email. The code is the
  // same `registration_closed` the E-mail door's closed gate returns — nothing
  // about the provider leaks, and no user row is written.
  it("8. closed registration on a door refuses a new email and creates nobody", async () => {
    const door = await mkDoor({ registrationEnabled: 0 });
    const email = emailN("closed");
    const before = await realUserCount();
    const signInBefore = await countSignInRows();
    const r = await runFlow(door, profileFor(email));
    expect(r.kind).toBe("error");
    expect(r.code).toBe("registration_closed");
    expect(await userIdFor(email)).toBeUndefined();
    expect(await realUserCount()).toBe(before);
    // No actor exists to scope an audit assertion to, so the instance-wide
    // count is the lens: the refusal added no `auth.sign_in` anywhere.
    expect(await countSignInRows()).toBe(signInBefore);
  });

  // Case 9 — §5's link gate, first layer: an UNVERIFIED profile email may not
  // link an existing account and creates nothing. Which seam speaks is asserted
  // as measured: better-auth's own gate (`!trusted && !emailVerified`) answers
  // BEFORE our hook runs on the implicit-link path, so the wire code is the
  // generic `account_not_linked` — §5's `unverified_email` is the hook's second
  // belt (reachable on the explicit `/link-social` seam, and unit-pinned in
  // door-policy.test.ts). Either seam: no link row, no session, no new account.
  it("9. an unverified profile cannot link an existing account (§5, generic refusal)", async () => {
    const door = await mkDoor();
    const email = emailN("unverified");
    const id = await users.createUser({
      email,
      name: email,
      passwordHash: await hashPassword("t7-pass-1"),
      role: "user",
    });
    await clearSignInRows(id);
    const r = await runFlow(door, profileFor(email, { email_verified: undefined }));
    expect(r.kind).toBe("error");
    expect(r.code).toBe("account_not_linked");
    expect(await sessionCount(id)).toBe(0);
    expect(await accountProviders(id)).toEqual(["credential"]);
    expect(await emailVerifiedFlag(id)).toBe(0);
    expect(await signInRows(id)).toHaveLength(0); // better-auth's own gate still writes no audit row
    await purgeByEmail(email);
  });

  // Case 10 — §5's domain gate: the check runs before the link/create decision,
  // so a non-matching email cannot link either — even an existing user's.
  it("10. the domain gate refuses a non-matching email that already has a user", async () => {
    const door = await mkDoor({ allowedDomains: "acme.com" });
    const email = "intruder@evil.com"; // deliberately outside the fixture domain
    const id = await users.createUser({
      email,
      name: email,
      passwordHash: await hashPassword("t7-pass-1"),
      role: "user",
    });
    fixtureEmails.push(email);
    const before = await realUserCount();

    await clearSignInRows(id);
    const r = await runFlow(door, profileFor(email));
    expect(r.kind).toBe("error");
    expect(r.code).toBe("domain_not_allowed");
    expect(await accountProviders(id)).toEqual(["credential"]);
    expect(await realUserCount()).toBe(before);
    expect(await signInRows(id)).toHaveLength(0); // refused before the link/create decision, and before any row
    await purgeByEmail(email);
  });

  // Case 11 — §7: the E-mail door's sign_in_enabled refuses the PASSWORD path
  // at the server (the door-guards before-hook — `validateUserInfo` never fires
  // there, measured), while a provider door keeps working. The row is closed
  // and restored through raw SQL, and every edge carries an invalidateAuth()
  // because the config build reads the table too.
  it("11. closing the E-mail door 403s password sign-in; the OIDC door keeps working", async () => {
    const email = emailN("pw-door");
    const pwId = await users.createUser({
      email,
      name: email,
      passwordHash: await hashPassword("t7-pass-1"),
      role: "user",
    });
    const signIn = () =>
      app.fetch(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:5173" },
          body: JSON.stringify({ email, password: "t7-pass-1" }),
        }),
      ) as unknown as Promise<Response>;

    // Audit seam: the password path must keep spelling itself `password`
    // even after the same after-hook grew the OIDC `/callback/` branch — a
    // `/sign-in/email` act can never be claimed by an `oidc:` row.
    await clearSignInRows(pwId);
    expect((await signIn()).status).toBe(200); // precondition: the credential works while the door is open
    let pwRows = await signInRows(pwId);
    expect(pwRows).toHaveLength(1);
    expect(metaOf(pwRows[0])).toEqual({ method: "password" });

    await sql`UPDATE auth_providers SET sign_in_enabled = 0 WHERE id = 'email'`.execute(db);
    invalidateAuth();
    const closed = await signIn();
    expect(closed.status).toBe(403);
    const body = (await closed.json().catch(() => null)) as { message?: string } | null;
    expect(String(body?.message ?? "")).toContain("disabled");
    expect(await signInRows(pwId)).toHaveLength(1); // the refused password act writes nothing

    // The refusal is the E-mail door's, not a blanket auth outage.
    const oidc = await mkDoor();
    const okEmail = emailN("oidc-after-email-closed");
    const r = await runFlow(oidc, profileFor(okEmail));
    expect(r.kind).toBe("session");
    const okId = (await userIdFor(okEmail)) ?? "";
    expect(okId).toBeTruthy();
    expect(await signInRows(okId)).toEqual([
      {
        actorUserId: okId,
        targetType: "user",
        targetId: okId,
        metadataJson: JSON.stringify({ method: `oidc:${oidc}`, userId: okId }),
      },
    ]); // exactly one, right actor, right method — while the closed E-mail door is irrelevant to it
    // ...and the password user is still holding ONLY its own password row.
    pwRows = await signInRows(pwId);
    expect(pwRows).toHaveLength(1);
    expect(metaOf(pwRows[0])).toEqual({ method: "password" });
    await purgeByEmail(okEmail);

    await sql`UPDATE auth_providers SET sign_in_enabled = 1 WHERE id = 'email'`.execute(db);
    invalidateAuth();
    expect((await signIn()).status).toBe(200);
    pwRows = await signInRows(pwId);
    expect(pwRows).toHaveLength(2);
    expect(pwRows.every((row) => metaOf(row).method === "password")).toBe(true); // two genuine acts, neither mislabeled
    await purgeByEmail(email);
  });

  // Case 12 — §2's seam shift: with the E-mail row's gate closed, the CREATE
  // path (which `validateUserInfo` DOES see) refuses with the named code and
  // writes nobody. (Distinct from case 11 by design: the sign-in refusal lives
  // in the before-hook, the create refusal in the provisioning hook.)
  it("12. a closed E-mail gate refuses sign-up with 403 registration_closed, creating nobody", async () => {
    await new AuthProvidersRepository(db).update("email", { registrationEnabled: 0 });
    invalidateAuth();
    const email = emailN("signup-closed");
    const before = await realUserCount();
    const signInBefore = await countSignInRows();
    const res = (await app.fetch(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({ email, password: "t7-pass-1", name: "T7 Closed" }),
      }),
    )) as Response;
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("registration_closed");
    expect(await userIdFor(email)).toBeUndefined();
    expect(await realUserCount()).toBe(before);
    expect(await countSignInRows()).toBe(signInBefore); // a refused sign-up is no sign-in act

    // Back to the seeded default the sibling suites assume (NULL = legacy
    // dynamic window), NOT to 1 — the shared DB's gate posture belongs to the
    // migration, not to this file.
    await new AuthProvidersRepository(db).update("email", { registrationEnabled: null });
    invalidateAuth();
  });
});
