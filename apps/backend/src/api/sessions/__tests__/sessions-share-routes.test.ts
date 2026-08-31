import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sessionRoutes } from "@/api/sessions/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

type ShareRow = { id: string; granteeUserId: string | null; granteeName: string | null; permission: string };

/**
 * GET/PUT /api/sessions/:id/shares — the owner's sharing control (spec
 * 2026-08-31 §4). Owner-only (edit grantees get 403), cookie-only (a machine
 * token gets 403 even for its own session), invisible sessions 404, and an
 * unknown grantee on PUT is a 400.
 */
describe("/api/sessions/:id/shares", () => {
  const pw = "share-crud-1";
  const aliceEmail = `sc-alice-${crypto.randomUUID()}@mote.local`;
  const bobEmail = `sc-bob-${crypto.randomUUID()}@mote.local`;
  const carolEmail = `sc-carol-${crypto.randomUUID()}@mote.local`;
  let aliceId: string;
  let bobId: string;
  let aliceCookie: string;
  let bobCookie: string;
  let carolCookie: string;
  let sessionKeyForOwn: string;
  const created = ["s_own"];
  const createdKeys: string[] = [];

  async function mkUser(email: string): Promise<string> {
    return await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
  }

  beforeAll(async () => {
    await setupAuthTables();
    aliceId = await mkUser(aliceEmail);
    bobId = await mkUser(bobEmail);
    await mkUser(carolEmail);
    aliceCookie = await signIn(aliceEmail, pw);
    bobCookie = await signIn(bobEmail, pw);
    carolCookie = await signIn(carolEmail, pw);

    await new SessionsRepository(db).create({
      id: "s_own",
      userId: aliceId,
      profileId: "p",
      harnessId: "claude-code",
      name: "s_own",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    // A real session bearer key for s_own — proves cookie-only enforcement.
    sessionKeyForOwn = await issueSessionToken("s_own", aliceId);
    const row = await new SessionsRepository(db).findById("s_own");
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
  });

  afterAll(async () => {
    for (const kid of createdKeys) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const id of created) await db.deleteFrom("sessions").where("id", "=", id).execute();
    for (const email of [aliceEmail, bobEmail, carolEmail]) await deleteUserByEmailOrId(email);
  });

  function req(method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `better-auth.session_token=${opts.cookie}`;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return sessionRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
    );
  }

  it("owner PUTs Everyone + a named user, then GETs them back with resolved names", async () => {
    const put = await req("PUT", "/s_own/shares", {
      cookie: aliceCookie,
      body: {
        shares: [
          { granteeUserId: null, permission: "view" },
          { granteeUserId: bobId, permission: "edit" },
        ],
      },
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { shares: ShareRow[] };
    expect(body.shares).toHaveLength(2);
    const everyone = body.shares.find((s) => s.granteeUserId === null);
    expect(everyone?.granteeName).toBe("Everyone");
    expect(everyone?.permission).toBe("view");
    const bob = body.shares.find((s) => s.granteeUserId === bobId);
    expect(bob?.granteeName).toBe(bobEmail);
    expect(bob?.permission).toBe("edit");

    const got = (await (await req("GET", "/s_own/shares", { cookie: aliceCookie })).json()) as { shares: ShareRow[] };
    expect(got.shares).toHaveLength(2);
  });

  it("a second PUT replaces the set (a grant not listed is removed)", async () => {
    await req("PUT", "/s_own/shares", {
      cookie: aliceCookie,
      body: { shares: [{ granteeUserId: bobId, permission: "view" }] },
    });
    const got = (await (await req("GET", "/s_own/shares", { cookie: aliceCookie })).json()) as { shares: ShareRow[] };
    expect(got.shares.map((s) => s.granteeUserId)).toEqual([bobId]);
    expect(got.shares[0]?.permission).toBe("view");
  });

  it("an edit grantee reads the session but managing shares is owner-only → 403", async () => {
    await req("PUT", "/s_own/shares", {
      cookie: aliceCookie,
      body: { shares: [{ granteeUserId: bobId, permission: "edit" }] },
    });
    expect((await req("GET", "/s_own/shares", { cookie: bobCookie })).status).toBe(403);
    expect((await req("PUT", "/s_own/shares", { cookie: bobCookie, body: { shares: [] } })).status).toBe(403);
  });

  it("a session not visible to the caller is 404 (no existence leak)", async () => {
    await req("PUT", "/s_own/shares", { cookie: aliceCookie, body: { shares: [] } }); // private again
    expect((await req("GET", "/s_own/shares", { cookie: carolCookie })).status).toBe(404);
  });

  it("PUT with an unknown grantee → 400", async () => {
    const res = await req("PUT", "/s_own/shares", {
      cookie: aliceCookie,
      body: { shares: [{ granteeUserId: crypto.randomUUID(), permission: "view" }] },
    });
    expect(res.status).toBe(400);
  });

  it("a machine bearer token is refused even for its own session (cookie-only) → 403", async () => {
    expect((await req("GET", "/s_own/shares", { bearer: sessionKeyForOwn })).status).toBe(403);
  });
});
