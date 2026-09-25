import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { authProvidersRoutes } from "@/api/auth-providers/index.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The admin door CRUD (spec 2026-09-24 §8): create with discovery as the save
 * gate, patch with the re-probe rule and the empty-string domain clear, the
 * reserved email row's immutability, the last-door guard on every write, the
 * probe route, and the audit rows that never carry the secret.
 *
 * The shared per-process DB is never assumed empty: the last-door scenario
 * force-closes every door it does not own for its duration and restores the
 * exact stored values afterwards, so a file that ran before it — or runs
 * after — sees its own rows untouched.
 */
const app = new Elysia().use(errorHandlerPlugin).use(authProvidersRoutes);

const doors = new AuthProvidersRepository(db);

const ISSUER = "https://idp.test";
const SECRET = "super-secret-never-echoed";
const pw = "ap-pass-1";
const adminEmail = `apv-admin-${crypto.randomUUID()}@subshell.local`;
const memberEmail = `apv-member-${crypto.randomUUID()}@subshell.local`;
const subshellId = `apv-sub-${crypto.randomUUID()}`;

let adminCookie: string;
let memberCookie: string;
let adminId: string;
let adminBearerKey: string;
const _fixtureUserIds: string[] = [];
/** Door ids this file created, removed in afterAll. */
const createdIds: string[] = [];
const restoreUserIds: string[] = [];

/** What the fake IdP answers with, flipped per test. */
const fake = {
  discoveryStatus: 200,
  grantTypes: ["authorization_code", "refresh_token"] as string[] | undefined,
  tokenStatus: 200,
  tokenUrls: [] as string[],
  tokenBodies: [] as string[],
};
let discoveryCount = 0;
const realFetch = globalThis.fetch;

function fakeIdp() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/.well-known/openid-configuration")) {
      discoveryCount++;
      if (fake.discoveryStatus !== 200) return new Response("down", { status: fake.discoveryStatus });
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        ...(fake.grantTypes ? { grant_types_supported: fake.grantTypes } : {}),
      });
    }
    if (url === `${ISSUER}/token`) {
      fake.tokenUrls.push(url);
      fake.tokenBodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: fake.tokenStatus });
    }
    throw new Error(`unstubbed fetch in auth-providers route test: ${url}`);
  }) as typeof fetch;
}

function req(
  method: string,
  path: string,
  cookie: string | null,
  body?: unknown,
  bearer?: string,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = `better-auth.session_token=${cookie}`;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return (
    (
      app
        // `app.fetch` is typed `MaybePromise<Response>`; awaited here it is a
        // plain promise (the precedent is users-pending's `req`).
        .fetch(
          new Request(`http://localhost:3080/api/auth-providers${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ) as Promise<Response>
    ).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }))
  );
}

/** A complete create body for a fresh door (the shape the SPA dialog sends). */
function createBody(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "oidc",
    name: id,
    issuer: ISSUER,
    clientId: "client-1",
    clientSecret: SECRET,
    entryOrigins: ["https://box.example/login"],
    enabled: true,
    signInEnabled: true,
    registrationEnabled: false,
    requireApproval: false,
    ...over,
  };
}

function freshId(label: string): string {
  const id = `apv-${label}-${crypto.randomUUID().slice(0, 8)}`;
  createdIds.push(id);
  return id;
}

async function auditRows(action: string): Promise<{ metadataJson: string | null }[]> {
  return await db.selectFrom("auditEvents").select("metadataJson").where("action", "=", action).execute();
}

describe("auth-providers admin CRUD (spec §8)", () => {
  beforeAll(async () => {
    await setupAuthTables();
    fakeIdp();
    const users = new UsersRepository(db);
    adminId = await users.createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    const memberId = await users.createUser({
      email: memberEmail,
      name: memberEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    restoreUserIds.push(adminId, memberId);
    adminCookie = await signIn(adminEmail, pw);
    memberCookie = await signIn(memberEmail, pw);
    // A VALID machine credential — a bogus key 401s before the cookie-only
    // rule can be asserted (the users-management discipline).
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId: adminId,
      presetId: "p",
      harnessId: "claude-code",
      name: "apv-token-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    adminBearerKey = await issueSubshellToken(subshellId, adminId);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const id of createdIds) await doors.remove(id);
    for (const id of restoreUserIds) {
      await db.deleteFrom("userMeta").where("userId", "=", id).execute();
      await deleteUserByEmailOrId(id);
    }
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
  });

  describe("gates", () => {
    it("anonymous 401, member cookie 403, bearer 403 on every verb", async () => {
      expect((await req("GET", "/", null)).status).toBe(401);
      expect((await req("POST", "/", null, createBody("apv-anon"))).status).toBe(401);
      expect((await req("GET", "/", memberCookie)).status).toBe(403);
      // Member POSTs carry schema-valid bodies, so the 403 is the admin gate,
      // never a body-validation slip.
      expect((await req("POST", "/", memberCookie, createBody(freshId("memb")))).status).toBe(403);
      expect((await req("POST", "/test", memberCookie, { issuer: ISSUER })).status).toBe(403);
      expect((await req("PATCH", "/email", memberCookie, { enabled: true })).status).toBe(403);
      expect((await req("DELETE", "/email", memberCookie)).status).toBe(403);
      // Bodies are schema-VALID so a 403 proves the cookie-only gate, not a
      // body-validation slip past the handler.
      const bearerCases: [string, string, unknown][] = [
        ["GET", "/", undefined],
        ["POST", "/", createBody(freshId("bearer"))],
        ["PATCH", "/email", { enabled: true }],
        ["DELETE", "/email", undefined],
        ["POST", "/test", { issuer: ISSUER }],
      ];
      for (const [method, path, body] of bearerCases) {
        const res = await req(method, path, null, body, adminBearerKey);
        expect(res.status, `${method} ${path} as bearer`).toBe(403);
      }
      expect(await doors.getById("email")).toBeDefined();
    });
  });

  describe("create + list", () => {
    it("creates a door: discovery resolved, origins canonicalized, secret stored but never serialized", async () => {
      const id = freshId("corp");
      // The array form of `allowedDomains`, as the review round's dialog sends
      // it; the comma-string form is pinned in the PATCH clear test.
      const res = await req("POST", "/", adminCookie, createBody(id, { allowedDomains: ["Acme.COM", "acme.com"] }));
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        id,
        kind: "oidc",
        issuer: ISSUER,
        clientId: "client-1",
        hasSecret: true,
        entryOrigins: ["https://box.example"],
        allowedDomains: ["acme.com"],
        enabled: true,
        signInEnabled: true,
        registrationEnabled: false,
        requireApproval: false,
        endpointsResolved: true,
      });
      expect(JSON.stringify(res.json)).not.toInclude(SECRET);
      const row = await doors.getById(id);
      expect(row?.clientSecret).toBe(SECRET);
      expect(JSON.parse(String(row?.endpointsJson))).toEqual({
        authorizationUrl: `${ISSUER}/authorize`,
        tokenUrl: `${ISSUER}/token`,
        userInfoUrl: `${ISSUER}/userinfo`,
      });
    });

    it("a 40-char-boundary name is creatable end-to-end via its preview string", async () => {
      // The dialog's flow for a name that hits the cap: previewProviderId
      // ("a"*39 + "-b") = "a"*39 (trim runs after the slice in BOTH mirrors),
      // sent as `id` — the strict gate must accept the preview as-is.
      const name = `${"a".repeat(39)}-b`;
      const preview = "a".repeat(39);
      createdIds.push(preview);
      const res = await req("POST", "/", adminCookie, createBody(preview, { name }));
      expect(res.status).toBe(200);
      expect(res.json.id).toBe(preview);
      expect((await doors.getById(preview))?.name).toBe(name);
    });

    it("the list carries the reserved email row with the null legacy gate and no endpoints", async () => {
      const res = await req("GET", "/", adminCookie);
      expect(res.status).toBe(200);
      const email = res.json.providers.find((p: { id: string }) => p.id === "email");
      expect(email).toMatchObject({
        kind: "email",
        issuer: null,
        clientId: null,
        hasSecret: false,
        entryOrigins: [],
        allowedDomains: null,
        registrationEnabled: null,
        endpointsResolved: false,
      });
    });

    it("an existing slug is refused 409 SLUG_TAKEN before discovery, and email is reserved", async () => {
      const taken = freshId("dup");
      await req("POST", "/", adminCookie, createBody(taken));
      const again = await req("POST", "/", adminCookie, createBody(taken));
      expect(again.status).toBe(409);
      expect(again.json.code).toBe("SLUG_TAKEN");
      // The reserved `email` slug is refused by name (the row's identity),
      // and any other existing id 409s as taken.
      const asEmail = await req("POST", "/", adminCookie, createBody("email"));
      expect(asEmail.status).toBe(409);
      expect(asEmail.json.code).toBe("SLUG_TAKEN");
      expect(JSON.stringify(asEmail.json)).toInclude("reserved");
      const emailKind = await req("POST", "/", adminCookie, createBody(freshId("ek"), { kind: "email" }));
      expect(emailKind.status).toBe(400);
      expect(emailKind.json.code).toBe("EMAIL_ROW_IMMUTABLE_KIND");
      // The email-kind refusal runs FIRST: even with an empty name it is the
      // reserved-kind answer, not the name-required one, and nothing lands.
      const emailKindNoName = await req(
        "POST",
        "/",
        adminCookie,
        createBody(freshId("ek2"), { kind: "email", name: "" }),
      );
      expect(emailKindNoName.json.code).toBe("EMAIL_ROW_IMMUTABLE_KIND");
      // And nothing was persisted: the reserved kind never reaches the row.
      expect(await doors.getById("email")).toMatchObject({ kind: "email" });
      // The id is required, never derived from the name: empty AND absent are
      // both refused before any discovery or write.
      const noId = await req("POST", "/", adminCookie, { ...createBody(freshId("noid")), id: "" });
      expect(noId.status).toBe(400);
      expect(noId.json.code).toBe("BAD_REQUEST");
      // Omitted entirely (schema-valid otherwise): the named 400, not a slug
      // invented from the name.
      const { id: _omit, ...bodyWithoutId } = createBody(freshId("omit"));
      const omittedId = await req("POST", "/", adminCookie, bodyWithoutId);
      expect(omittedId.status).toBe(400);
      expect(omittedId.json.code).toBe("BAD_REQUEST");
      // Required name: empty is a named 400, and a missing field is a 400
      // schema refusal — never a slug derived from an absent display name.
      const noName = await req("POST", "/", adminCookie, createBody(freshId("nname"), { name: "  " }));
      expect(noName.status).toBe(400);
      expect(noName.json.code).toBe("BAD_REQUEST");
      // Id alphabet: uppercase and commas are REFUSED, never normalized —
      // the roster's `providers` list is comma-joined (Task 9 GROUP_CONCAT)
      // and the id is a callback path segment.
      const upperId = await req("POST", "/", adminCookie, createBody("ACME-Corp"));
      expect(upperId.status).toBe(400);
      expect(upperId.json.code).toBe("BAD_REQUEST");
      expect(upperId.json.message).toInclude("slug");
      const commaId = await req("POST", "/", adminCookie, createBody(`a,${crypto.randomUUID().slice(0, 4)}`));
      expect(commaId.status).toBe(400);
      expect(commaId.json.code).toBe("BAD_REQUEST");
      expect(await doors.getById("acme-corp")).toBeUndefined();
    });

    it("an empty entryOrigins list is a 400, never a silent default", async () => {
      const res = await req("POST", "/", adminCookie, createBody(freshId("noorig"), { entryOrigins: [] }));
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("BAD_REQUEST");
      // Omitted entirely still answers with the instance's own origin.
      const { entryOrigins: _o, ...withoutOrigins } = createBody(freshId("dflt"));
      const omitted = await req("POST", "/", adminCookie, withoutOrigins);
      expect(omitted.status).toBe(200);
      expect(omitted.json.entryOrigins.length).toBeGreaterThan(0);
    });

    it("OIDC kinds require issuer/clientId/secret and discovery must pass", async () => {
      const missing = await req("POST", "/", adminCookie, createBody(freshId("miss"), { issuer: "" }));
      expect(missing.status).toBe(400);
      expect(JSON.stringify(missing.json)).not.toInclude(SECRET);
      const before = discoveryCount;
      const downId = freshId("down");
      fake.discoveryStatus = 500;
      const down = await req("POST", "/", adminCookie, createBody(downId));
      fake.discoveryStatus = 200;
      expect(down.status).toBe(400);
      expect(down.json.code).toBe("DISCOVERY_FAILED");
      expect(discoveryCount).toBe(before + 1);
      // Nothing was written by the refused save.
      expect(await doors.getById(downId)).toBeUndefined();
    });

    it("the name goes through the shared label normalizer, capped like every other NAME path (final review, minor)", async () => {
      // Same `normalizeLabel` the subshell/workspace/node renames use: Cf
      // format chars dropped (they would ride the ANONYMOUS login buttons),
      // control chars to a space, whitespace collapsed, capped at 120 code
      // points. The name is the one column a row carries into the pre-auth
      // surface verbatim, so it goes through the rule every other NAME path
      // already pays.
      const res = await req(
        "POST",
        "/",
        adminCookie,
        createBody(freshId("clean-name"), { name: "  Acme\u200b Corp\u0001Ltd  " }),
      );
      expect(res.status).toBe(200);
      expect(res.json.name).toBe("Acme Corp Ltd");
      const long = await req("POST", "/", adminCookie, createBody(freshId("long-name"), { name: "x".repeat(300) }));
      expect(long.status).toBe(200);
      expect(long.json.name).toBe("x".repeat(120));
    });

    it("a name that normalizes to nothing is refused 400", async () => {
      const res = await req("POST", "/", adminCookie, createBody(freshId("blank-name"), { name: "\u0001\u0002" }));
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("BAD_REQUEST");
    });
  });

  describe("patch", () => {
    const targetId = "apv-target";
    beforeAll(async () => {
      createdIds.push(targetId);
      await req("POST", "/", adminCookie, createBody(targetId, { allowedDomains: "acme.com" }));
    });

    it("renames and clears domains to NULL with an empty string (SPA contract)", async () => {
      const res = await req("PATCH", `/${targetId}`, adminCookie, { name: "Renamed", allowedDomains: "" });
      expect(res.status).toBe(200);
      expect(res.json.name).toBe("Renamed");
      expect(res.json.allowedDomains).toBeNull();
      const row = await doors.getById(targetId);
      expect(row?.allowedDomains).toBeNull();
      // The array spelling of the same clear (both accepted wire shapes).
      await req("PATCH", `/${targetId}`, adminCookie, { allowedDomains: ["Acme.COM", "acme.com"] });
      expect((await doors.getById(targetId))?.allowedDomains).toBe("acme.com");
      const clearedArr = await req("PATCH", `/${targetId}`, adminCookie, { allowedDomains: [] });
      expect(clearedArr.status).toBe(200);
      expect(clearedArr.json.allowedDomains).toBeNull();
      // And the comma-string form the on-disk dialog still sends.
      const setStr = await req("PATCH", `/${targetId}`, adminCookie, { allowedDomains: "X.COM, x.com, y.org" });
      expect(setStr.json.allowedDomains).toEqual(["x.com", "y.org"]);
    });

    it("an empty clientSecret leaves the stored secret; null is refused", async () => {
      const kept = await req("PATCH", `/${targetId}`, adminCookie, { clientSecret: "" });
      expect(kept.status).toBe(200);
      expect(kept.json.hasSecret).toBe(true);
      expect((await doors.getById(targetId))?.clientSecret).toBe(SECRET);
      const cleared = await req("PATCH", `/${targetId}`, adminCookie, { clientSecret: null });
      expect(cleared.status).toBe(400);
      expect((await doors.getById(targetId))?.clientSecret).toBe(SECRET);
    });

    it("a non-empty clientSecret replaces the stored one; the audit names the field only", async () => {
      const replacement = "replacement-secret-never-echoed";
      const res = await req("PATCH", `/${targetId}`, adminCookie, { clientSecret: replacement });
      expect(res.status).toBe(200);
      expect(res.json.hasSecret).toBe(true);
      expect(JSON.stringify(res.json)).not.toInclude(replacement);
      expect((await doors.getById(targetId))?.clientSecret).toBe(replacement);
      const rows = await auditRows("auth_provider.update");
      const last = rows.at(-1);
      expect(String(last?.metadataJson)).toInclude("clientSecret");
      expect(String(last?.metadataJson)).not.toInclude(replacement);
    });

    it("an issuer change re-probes; a discovery failure writes nothing", async () => {
      const before = discoveryCount;
      const ok = await req("PATCH", `/${targetId}`, adminCookie, { issuer: `${ISSUER}/` });
      expect(ok.status).toBe(200);
      expect(discoveryCount).toBe(before + 1);
      fake.discoveryStatus = 404;
      const bad = await req("PATCH", `/${targetId}`, adminCookie, { issuer: "https://broken.test" });
      fake.discoveryStatus = 200;
      expect(bad.status).toBe(400);
      expect(bad.json.code).toBe("DISCOVERY_FAILED");
      expect((await doors.getById(targetId))?.issuer).toBe(`${ISSUER}/`);
    });

    it("id/kind are immutable; a foreign id 404s", async () => {
      const kindChange = await req("PATCH", `/${targetId}`, adminCookie, { kind: "google" });
      expect(kindChange.status).toBe(400);
      expect((await doors.getById(targetId))?.kind).toBe("oidc");
      const wrongId = await req("PATCH", "/nope-does-not-exist", adminCookie, { name: "x" });
      expect(wrongId.status).toBe(404);
      expect(wrongId.json.code).toBe("PROVIDER_NOT_FOUND");
    });

    it("PATCH with a body id that mismatches the path id is refused 400", async () => {
      // Path param is the only target selector: a body id cannot steer the
      // write — the named door keeps its name.
      const res = await req("PATCH", `/${targetId}`, adminCookie, { id: "email", name: "steered" });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("BAD_REQUEST");
      expect((await doors.getById(targetId))?.name).not.toBe("steered");
      expect((await doors.getById("email"))?.name).toBe("E-mail");
    });

    it("entry origins are normalized and an empty list is refused", async () => {
      const res = await req("PATCH", `/${targetId}`, adminCookie, { entryOrigins: ["https://LAN.Example:3080/app"] });
      expect(res.json.entryOrigins).toEqual(["https://lan.example:3080"]);
      const empty = await req("PATCH", `/${targetId}`, adminCookie, { entryOrigins: [] });
      expect(empty.status).toBe(400);
    });
  });

  describe("email row", () => {
    it("its kind change carries EMAIL_ROW_IMMUTABLE_KIND", async () => {
      const res = await req("PATCH", "/email", adminCookie, { kind: "oidc" });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("EMAIL_ROW_IMMUTABLE_KIND");
    });

    it("delete is refused with EMAIL_ROW_UNDELETABLE", async () => {
      const res = await req("DELETE", "/email", adminCookie);
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("EMAIL_ROW_UNDELETABLE");
      expect(await doors.getById("email")).toBeDefined();
    });

    it("issuer/clientId/entryOrigins are refused on the E-mail row BEFORE any discovery probe", async () => {
      // The email row has no OAuth identity (spec §2) — the PATCH route used
      // to accept these fields and even run the save-time discovery against a
      // nonsense email-row issuer. The refusal must precede the network: the
      // fake IdP's counter says nothing was fetched.
      const before = discoveryCount;
      const row = await doors.getById("email");
      for (const body of [
        { issuer: "https://nowhere.invalid" },
        { clientId: "nope" },
        { entryOrigins: ["https://nowhere.invalid"] },
      ]) {
        const res = await req("PATCH", "/email", adminCookie, body);
        expect(res.status).toBe(400);
        expect(res.json.code).toBe("BAD_REQUEST");
      }
      expect(discoveryCount).toBe(before);
      const after = await doors.getById("email");
      expect(after?.issuer).toBe(row?.issuer);
      expect(after?.clientId).toBe(row?.clientId);
      expect(after?.entryOrigins).toBe(row?.entryOrigins);
    });

    it("its display name normalizes like every other row's", async () => {
      const res = await req("PATCH", "/email", adminCookie, { name: "  Login\u0001with  mail   " });
      expect(res.status).toBe(200);
      expect(res.json.name).toBe("Login with mail");
      // Restore the migration-seeded spelling so sibling suites read what they expect.
      const restored = await req("PATCH", "/email", adminCookie, { name: "E-mail" });
      expect(restored.json.name).toBe("E-mail");
    });
  });

  describe("last-door guard", () => {
    // Isolate the count: every door this file does not own is force-closed
    // for the duration and restored to its stored value afterwards.
    let restored: { id: string; enabled: number }[] = [];
    const doorB = "apv-door-b";

    beforeAll(async () => {
      const email = await doors.getById("email");
      restored = [{ id: "email", enabled: email?.enabled ?? 1 }];
      await doors.update("email", { enabled: 1, signInEnabled: 1 });
      for (const row of await doors.listAll()) {
        if (row.id === "email") continue;
        restored.push({ id: row.id, enabled: row.enabled });
        if (row.enabled === 1) await doors.update(row.id, { enabled: 0 });
      }
      createdIds.push(doorB);
    });

    it("opens a second door, closes the email row's sign-in, and refuses closing the last one", async () => {
      // Open door B through the route: a create adds a door and trivially
      // passes the guard.
      const opened = await req("POST", "/", adminCookie, createBody(doorB));
      expect(opened.status).toBe(200);
      // Closing door A's sign-in half is fine: B holds the instance open.
      const closedA = await req("PATCH", "/email", adminCookie, { signInEnabled: false });
      expect(closedA.status).toBe(200);
      expect(await doors.openSignInDoorCount()).toBe(1);
      // Closing B too is the refusal, and it saves nothing.
      const refused = await req("PATCH", `/${doorB}`, adminCookie, { signInEnabled: false });
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe("LAST_SIGN_IN_DOOR");
      expect(await doors.openSignInDoorCount()).toBe(1);
      expect((await doors.getById(doorB))?.signInEnabled).toBe(1);
      // Disabling B is the same refusal (the guard reads both halves), and so
      // is deleting it while it is the last open door.
      const disabled = await req("PATCH", `/${doorB}`, adminCookie, { enabled: false });
      expect(disabled.status).toBe(409);
      const deleted = await req("DELETE", `/${doorB}`, adminCookie);
      expect(deleted.status).toBe(409);
      expect(deleted.json.code).toBe("LAST_SIGN_IN_DOOR");
      expect(await doors.getById(doorB)).toBeDefined();
      // Re-open the email door, and B can now be deleted: a DELETE answers
      // 200 with a JSON body (the SPA contract — a bare 204 reads as failure).
      await req("PATCH", "/email", adminCookie, { signInEnabled: true });
      const removed = await req("DELETE", `/${doorB}`, adminCookie);
      expect(removed.status).toBe(200);
      expect(removed.json).toEqual({ ok: true });
      expect(await doors.getById(doorB)).toBeUndefined();
    });

    afterAll(async () => {
      for (const { id, enabled } of restored)
        await doors.update(id, { enabled, ...(id === "email" ? { signInEnabled: 1 } : {}) });
    });
  });

  describe("POST /test probe", () => {
    it("discovery-only probe answers the endpoints", async () => {
      const res = await req("POST", "/test", adminCookie, { issuer: ISSUER });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        ok: true,
        endpoints: {
          authorizationUrl: `${ISSUER}/authorize`,
          tokenUrl: `${ISSUER}/token`,
          userInfoUrl: `${ISSUER}/userinfo`,
        },
      });
    });

    it("credentials with the grant offered attempt one token fetch; refusal is a 400 without echo", async () => {
      fake.tokenUrls = [];
      fake.grantTypes = ["client_credentials", "authorization_code"];
      const ok = await req("POST", "/test", adminCookie, { issuer: ISSUER, clientId: "c", clientSecret: SECRET });
      expect(ok.status).toBe(200);
      expect(fake.tokenUrls).toEqual([`${ISSUER}/token`]);
      expect(JSON.stringify(ok.json)).not.toInclude(SECRET);
      fake.tokenStatus = 401;
      const bad = await req("POST", "/test", adminCookie, { issuer: ISSUER, clientId: "c", clientSecret: SECRET });
      fake.tokenStatus = 200;
      expect(bad.status).toBe(400);
      expect(bad.json.code).toBe("DISCOVERY_FAILED");
      expect(JSON.stringify(bad.json)).not.toInclude(SECRET);
    });

    it("credentials without the advertised grant PASS with the note (Google's shape)", async () => {
      fake.grantTypes = ["authorization_code"];
      const res = await req("POST", "/test", adminCookie, { issuer: ISSUER, clientId: "c", clientSecret: SECRET });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.note).toBe("token-endpoint grant not offered; discovery verified");
      fake.grantTypes = undefined;
      const noField = await req("POST", "/test", adminCookie, { issuer: ISSUER, clientId: "c", clientSecret: SECRET });
      expect(noField.json.note).toBe("token-endpoint grant not offered; discovery verified");
      fake.grantTypes = ["authorization_code", "refresh_token"];
    });

    it("a dead issuer answers 400 DISCOVERY_FAILED", async () => {
      fake.discoveryStatus = 503;
      const res = await req("POST", "/test", adminCookie, { issuer: ISSUER });
      fake.discoveryStatus = 200;
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("DISCOVERY_FAILED");
    });
  });

  describe("audit rows", () => {
    it("carry field names and issuer only — never the secret", async () => {
      const creates = await auditRows("auth_provider.create");
      expect(creates.length).toBeGreaterThan(0);
      const updates = await auditRows("auth_provider.update");
      expect(updates.length).toBeGreaterThan(0);
      for (const row of [...creates, ...updates]) {
        expect(String(row.metadataJson)).not.toInclude(SECRET);
      }
      // Creates always name their issuer; an update on the email row names
      // null — the shape is field names + issuer, never values.
      for (const row of creates) expect(String(row.metadataJson)).toInclude(ISSUER);
      // The secret was PATCHed onto a door mid-suite; the row names the
      // field, not the value.
      expect(JSON.stringify(updates.map((r) => r.metadataJson))).toInclude("clientSecret");
    });
  });
});
