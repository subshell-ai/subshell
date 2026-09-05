import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * `PUT /api/nodes/:id/allowed-dirs` — OWNER-only by design, not the
 * `nodeCanConfigure` gate the harness toggles use. The reason is the whole
 * point of the endpoint: any node share lets the grantee launch subshells
 * there, so an `edit` grantee who could widen the list would face no
 * restriction at all.
 */
describe("node allowed-dirs route", () => {
  const pw = "allowed-dirs-1";
  const ownerEmail = `ad-owner-${crypto.randomUUID()}@subshell.local`;
  const editorEmail = `ad-editor-${crypto.randomUUID()}@subshell.local`;
  const strangerEmail = `ad-stranger-${crypto.randomUUID()}@subshell.local`;
  let ownerId: string;
  let editorId: string;
  let ownerCookie: string;
  let editorCookie: string;
  let strangerCookie: string;
  const NODE = `n-ad-${crypto.randomUUID()}`;

  async function mkUser(email: string): Promise<string> {
    return await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
  }

  beforeAll(async () => {
    await setupAuthTables();
    ownerId = await mkUser(ownerEmail);
    editorId = await mkUser(editorEmail);
    await mkUser(strangerEmail);
    ownerCookie = await signIn(ownerEmail, pw);
    editorCookie = await signIn(editorEmail, pw);
    strangerCookie = await signIn(strangerEmail, pw);

    const now = new Date().toISOString();
    await db
      .insertInto("nodes")
      .values({
        id: NODE,
        ownerUserId: ownerId,
        name: NODE,
        kind: "agent",
        status: "offline",
        createdAt: now,
        updatedAt: now,
      } as never)
      .execute();
    await new NodeSharesRepository(db).replaceForNode(NODE, [{ granteeUserId: editorId, permission: "edit" }], ownerId);
  });

  afterAll(async () => {
    await db.deleteFrom("nodes").where("id", "=", NODE).execute();
    for (const email of [ownerEmail, editorEmail, strangerEmail]) await deleteUserByEmailOrId(email);
  });

  function put(cookie: string, dirs: string[]) {
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${NODE}/allowed-dirs`, {
        method: "PUT",
        headers: { cookie: `better-auth.session_token=${cookie}`, "content-type": "application/json" },
        body: JSON.stringify({ dirs }),
      }),
    );
  }

  function get(cookie: string) {
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${NODE}`, {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
  }

  it("starts unrestricted — an empty list means no rules, not 'permit nothing'", async () => {
    const view = (await (await get(ownerCookie)).json()) as { allowedDirs: string[] };
    expect(view.allowedDirs).toEqual([]);
  });

  it("the owner sets rules, and the stored (normalized) set comes back", async () => {
    const res = await put(ownerCookie, ["/srv/work/", "/home/theo", "/home/theo/nested"]);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { allowedDirs: string[] };
    // Normalized on the way in: trailing slash gone, the nested entry dropped
    // as already covered, sorted.
    expect(view.allowedDirs).toEqual(["/home/theo", "/srv/work"]);
  });

  it("an edit grantee is refused — the allowlist is not theirs to widen", async () => {
    expect((await put(editorCookie, ["/"])).status).toBe(403);
  });

  it("a stranger gets 404, never 403 — no existence oracle", async () => {
    expect((await put(strangerCookie, ["/tmp"])).status).toBe(404);
  });

  it("everyone who can see the node can READ the rules, so a refusal is explainable", async () => {
    const view = (await (await get(editorCookie)).json()) as { allowedDirs: string[] };
    expect(view.allowedDirs).toEqual(["/home/theo", "/srv/work"]);
  });

  it("rejects an unusable rule rather than silently dropping it", async () => {
    // Dropping it would leave the operator believing a directory is permitted
    // when no rule for it exists.
    const res = await put(ownerCookie, ["/ok", "relative/path"]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("relative/path");
    // ...and the previous rules are untouched by the rejected write.
    const view = (await (await get(ownerCookie)).json()) as { allowedDirs: string[] };
    expect(view.allowedDirs).toEqual(["/home/theo", "/srv/work"]);
  });

  it("rejects a `..` rule — it would look confining without being so", async () => {
    expect((await put(ownerCookie, ["/home/../etc"])).status).toBe(400);
  });

  it("an empty array clears the rules back to unrestricted", async () => {
    const res = await put(ownerCookie, []);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { allowedDirs: string[] }).allowedDirs).toEqual([]);
  });
});
