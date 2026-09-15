import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { subshellRoutes } from "@/api/subshells/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

type ShareRow = { id: string; granteeUserId: string | null; granteeName: string | null; permission: string };

/**
 * GET/PUT /api/subshells/:id/shares — the owner's sharing control (spec
 * 2026-08-31 §4). Owner-only (edit grantees get 403), cookie-only (a machine
 * token gets 403 even for its own subshell), invisible subshells 404, and an
 * unknown grantee on PUT is a 400.
 */
describe("/api/subshells/:id/shares", () => {
  const pw = "share-crud-1";
  const aliceEmail = `sc-alice-${crypto.randomUUID()}@subshell.local`;
  const bobEmail = `sc-bob-${crypto.randomUUID()}@subshell.local`;
  const carolEmail = `sc-carol-${crypto.randomUUID()}@subshell.local`;
  /** Bob's chosen display name, deliberately unlike his address. */
  const bobName = "Bob Ortiz";
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let aliceCookie: string;
  let bobCookie: string;
  let carolCookie: string;
  let subshellKeyForOwn: string;
  const created = ["s_own"];
  const createdKeys: string[] = [];

  /**
   * `name` defaults to the EMAIL for callers that do not care, but the two
   * grantees below deliberately differ: Bob has a real display name, Carol
   * has none. `displayNamesByIds` resolves
   * `COALESCE(NULLIF(name, ''), email)`, and with every fixture mirroring its
   * email into its name both halves of that expression return the same
   * string — so the branch that prefers a chosen name and the branch that
   * falls back to the address become indistinguishable.
   */
  async function mkUser(email: string, name = email): Promise<string> {
    return await new UsersRepository(db).createUser({
      email,
      name,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
  }

  beforeAll(async () => {
    await setupAuthTables();
    aliceId = await mkUser(aliceEmail);
    bobId = await mkUser(bobEmail, bobName);
    // Carol has NO display name — the fallback case.
    carolId = await mkUser(carolEmail, "");
    aliceCookie = await signIn(aliceEmail, pw);
    bobCookie = await signIn(bobEmail, pw);
    carolCookie = await signIn(carolEmail, pw);

    await new SubshellsRepository(db).create({
      id: "s_own",
      userId: aliceId,
      presetId: "p",
      harnessId: "claude-code",
      name: "s_own",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    // A real subshell bearer key for s_own — proves cookie-only enforcement.
    subshellKeyForOwn = await issueSubshellToken("s_own", aliceId);
    const row = await new SubshellsRepository(db).findById("s_own");
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
  });

  afterAll(async () => {
    for (const kid of createdKeys) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const id of created) await db.deleteFrom("subshells").where("id", "=", id).execute();
    for (const email of [aliceEmail, bobEmail, carolEmail]) await deleteUserByEmailOrId(email);
  });

  function req(method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `better-auth.session_token=${opts.cookie}`;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return subshellRoutes.fetch(
      new Request(`http://localhost:3080/api/subshells${path}`, {
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
    // The chosen name, NOT the address: a grantee row is what the owner reads
    // to decide whether the right person is on the list.
    expect(bob?.granteeName).toBe(bobName);
    expect(bob?.granteeName).not.toBe(bobEmail);
    expect(bob?.permission).toBe("edit");

    const got = (await (await req("GET", "/s_own/shares", { cookie: aliceCookie })).json()) as { shares: ShareRow[] };
    expect(got.shares).toHaveLength(2);
  });

  it("falls back to the email for a grantee with no display name", async () => {
    // The other half of `COALESCE(NULLIF(name, ''), email)`. Without a fixture
    // whose name is empty, nothing here would fail if the fallback were
    // dropped.
    const put = await req("PUT", "/s_own/shares", {
      cookie: aliceCookie,
      body: { shares: [{ granteeUserId: carolId, permission: "view" }] },
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { shares: ShareRow[] };
    expect(body.shares.find((s) => s.granteeUserId === carolId)?.granteeName).toBe(carolEmail);
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

  it("an edit grantee reads the subshell but managing shares is owner-only → 403", async () => {
    await req("PUT", "/s_own/shares", {
      cookie: aliceCookie,
      body: { shares: [{ granteeUserId: bobId, permission: "edit" }] },
    });
    expect((await req("GET", "/s_own/shares", { cookie: bobCookie })).status).toBe(403);
    expect((await req("PUT", "/s_own/shares", { cookie: bobCookie, body: { shares: [] } })).status).toBe(403);
  });

  it("a subshell not visible to the caller is 404 (no existence leak)", async () => {
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

  it("a machine bearer token is refused even for its own subshell (cookie-only) → 403", async () => {
    expect((await req("GET", "/s_own/shares", { bearer: subshellKeyForOwn })).status).toBe(403);
  });
});
