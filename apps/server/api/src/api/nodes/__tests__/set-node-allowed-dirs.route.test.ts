import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeAllowedDirsRepository } from "@/db/repositories/node-allowed-dirs.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
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
  let ownerAdminCookie: string;
  const adminEmail = `ad-admin-${crypto.randomUUID()}@subshell.local`;
  const NODE = `n-ad-${crypto.randomUUID()}`;

  async function mkUser(email: string): Promise<string> {
    return await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
  }

  beforeAll(async () => {
    await setupAuthTables();
    ownerId = await mkUser(ownerEmail);
    editorId = await mkUser(editorEmail);
    await mkUser(strangerEmail);
    ownerCookie = await signIn(ownerEmail, pw);
    editorCookie = await signIn(editorEmail, pw);
    strangerCookie = await signIn(strangerEmail, pw);
    // `local` is managed by ADMINS (the seeded-node exception), so the
    // resolution cases below need one.
    await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    ownerAdminCookie = await signIn(adminEmail, pw);
    await ensureLocalNode(db);

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
    for (const email of [ownerEmail, editorEmail, strangerEmail, adminEmail]) await deleteUserByEmailOrId(email);
  });

  function putOn(nodeId: string, cookie: string, dirs: string[]) {
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${nodeId}/allowed-dirs`, {
        method: "PUT",
        headers: { cookie: `better-auth.session_token=${cookie}`, "content-type": "application/json" },
        body: JSON.stringify({ dirs }),
      }),
    );
  }

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

  it("stores the node's RESOLVED path, so a rule matches what a launch resolves to", async () => {
    // The bug this pins: a launch candidate is always realpath'd, so a rule
    // stored as typed never matches one reached through a symlink — the owner
    // is refused the directory they just permitted. On macOS the temp dir is
    // itself behind /private, which is exactly the shape of the real case
    // (`/tmp/work`, `/var/run`, a symlinked home).
    const real = realpathSync(mkdtempSync(join(tmpdir(), "subshell-adres-")));
    const link = join(real, "link");
    const target = join(real, "target");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link);
    try {
      // `local` resolves through the LocalLauncher, the same call the launch
      // gate uses.
      const res = await putOn(LOCAL_NODE_ID, ownerAdminCookie, [link]);
      expect(res.status).toBe(200);
      const view = (await res.json()) as { allowedDirs: string[] };
      expect(view.allowedDirs).toEqual([target]);
    } finally {
      await new NodeAllowedDirsRepository(db).clearForNode(LOCAL_NODE_ID);
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("keeps a rule for a directory that does not exist yet, rather than dropping it", async () => {
    // Writing a rule ahead of creating the directory is legitimate, and an
    // offline node cannot resolve anything at all — neither may silently lose
    // the rule, which would leave the operator believing it is in force.
    const missing = join(tmpdir(), `subshell-absent-${crypto.randomUUID()}`);
    const res = await putOn(LOCAL_NODE_ID, ownerAdminCookie, [missing]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { allowedDirs: string[] }).allowedDirs).toEqual([missing]);
    await new NodeAllowedDirsRepository(db).clearForNode(LOCAL_NODE_ID);
  });

  it("refuses a bearer key outright — machine credentials never configure an instance", async () => {
    const res = await nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${NODE}/allowed-dirs`, {
        method: "PUT",
        headers: { authorization: "Bearer subshell_whatever", "content-type": "application/json" },
        body: JSON.stringify({ dirs: ["/tmp"] }),
      }),
    );
    // 401 (key unknown) or 403 (key rejected on an admin surface) — either is
    // a refusal; what must never happen is a 200.
    expect([401, 403]).toContain(res.status);
  });

  it("an admin does NOT get to rewrite a foreign agent node's rules", async () => {
    // Admins hold instance-wide EDIT, and the seeded-`local` exception is
    // exactly that — an exception. On someone else's agent node the rules stay
    // with the real owner, like shares and rename.
    expect((await put(ownerAdminCookie, ["/tmp"])).status).toBe(403);
  });

  it("an empty array clears the rules back to unrestricted", async () => {
    const res = await put(ownerCookie, []);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { allowedDirs: string[] }).allowedDirs).toEqual([]);
  });
});
