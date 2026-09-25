import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { systemKeysRoutes } from "@/api/system-keys.route.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * `GET /api/nodes` for a bearer actor (spec 2026-09-25 MCP DX): the machine
 * consumer the cookie-only phase deferred to arrived, and its door is
 * DISCLOSURE-ONLY. The bearer set is the strict owner-only one, the same
 * candidate source `resolveLaunchNode` step 3 uses for machine actors
 * (`NodesRepository.listByOwner`), so a pane token can see and pick among
 * the machines ITS OWNER enrolled, with `canLaunch`/`access` honest for that
 * actor class. Shares never widen the machine, the admin boost never applies,
 * and `local` (owned by the system user) simply is not in a human owner's set.
 *
 * Mirrors the shape and rigor of `subshells-list-visibility.test.ts`: a REAL
 * pane token mints the bearer, enumerate-ok pairs with act-denied, and every
 * invisibility is an ABSENCE, never a 403. The last bearer class is pinned
 * too: a SYSTEM key resolves as the `system` service user, whose owner-only
 * set is exactly the seeded `local` row.
 */
describe("GET /api/nodes bearer visibility (enumerate-ok / act-denied)", () => {
  const pw = "nodes-bearer-1";
  const bobEmail = `nb-bob-${crypto.randomUUID()}@subshell.local`;
  const aliceEmail = `nb-alice-${crypto.randomUUID()}@subshell.local`;
  const adminEmail = `nb-admin-${crypto.randomUUID()}@subshell.local`;
  let bobId: string;
  let aliceId: string;
  let bobCookie: string;
  let adminCookie: string;
  /** A REAL subshell bearer key: Bob's pane's MCP token, the machine credential under test. */
  let bobSubshellKey: string;

  const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
  const nodes = new NodesRepository(db);
  const nodeShares = new NodeSharesRepository(db);
  const createdNodeIds: string[] = [];
  const createdSubshellIds: string[] = [];
  const createdKeyIds: string[] = [];

  async function mkNode(ownerId: string, name: string): Promise<string> {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: ownerId, name, kind: "agent", status: "offline" });
    createdNodeIds.push(id);
    return id;
  }

  let bobNode: string; // Bob's OWN agent node, the one row the bearer may see
  let alicePrivate: string; // unshared foreign node: absent, never 403
  let aliceNamed: string; // shared to Bob by name (edit): absent for bearer
  let aliceEveryone: string; // shared to Everyone (view): absent for bearer

  beforeAll(async () => {
    await setupAuthTables();
    bobId = await new UsersRepository(db).createUser({
      email: bobEmail,
      name: bobEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    aliceId = await new UsersRepository(db).createUser({
      email: aliceEmail,
      name: aliceEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    // Only needed to MINT the system key the last case presents: minting is
    // cookie-admin, and the key then authenticates as the `system` service
    // user, not as this admin.
    await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    bobCookie = await signIn(bobEmail, pw);
    adminCookie = await signIn(adminEmail, pw);
    await ensureLocalNode(db); // the seeded control-plane host row

    bobNode = await mkNode(bobId, `nb-own-${crypto.randomUUID().slice(0, 8)}`);
    alicePrivate = await mkNode(aliceId, `nb-priv-${crypto.randomUUID().slice(0, 8)}`);
    aliceNamed = await mkNode(aliceId, `nb-named-${crypto.randomUUID().slice(0, 8)}`);
    aliceEveryone = await mkNode(aliceId, `nb-all-${crypto.randomUUID().slice(0, 8)}`);
    await nodeShares.replaceForNode(aliceNamed, [{ granteeUserId: bobId, permission: "edit" }], aliceId);
    await nodeShares.replaceForNode(aliceEveryone, [{ granteeUserId: null, permission: "view" }], aliceId);

    // Bob's OWN running subshell + its real MCP bearer key. `issueSubshellToken`
    // records apiKeyId on the row, which is what proves to auth-guard the key
    // is the one minted for THIS subshell and not a self-forged one.
    const sid = `nb_s_${crypto.randomUUID().slice(0, 8)}`;
    await new SubshellsRepository(db).create({
      id: sid,
      userId: bobId,
      presetId: "p",
      harnessId: "claude-code",
      name: sid,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    createdSubshellIds.push(sid);
    bobSubshellKey = await issueSubshellToken(sid, bobId);
  });

  afterAll(async () => {
    for (const kid of createdKeyIds) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const id of createdNodeIds) await nodes.deleteById(id);
    await db.deleteFrom("subshells").where("id", "in", createdSubshellIds).execute();
    for (const email of [bobEmail, aliceEmail, adminEmail]) await deleteUserByEmailOrId(email);
  });

  function bearerList(key: string) {
    return app.fetch(new Request("http://localhost:3080/api/nodes", { headers: { authorization: `Bearer ${key}` } }));
  }
  function cookieList(cookie: string) {
    return app.fetch(
      new Request("http://localhost:3080/api/nodes", {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
  }
  type Row = {
    id: string;
    access: string;
    canLaunch: boolean;
    status: string;
    harnesses: { harnessId: string; installed: boolean }[];
  };

  it("enumerate-ok: the token sees its owner's OWN agent node, honestly rendered", async () => {
    expect(bobSubshellKey.startsWith("subshell_")).toBe(true);
    const res = await bearerList(bobSubshellKey);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { nodes: Row[] }).nodes;
    // The owner-only set is EXACTLY Bob's node: the shares below buy the
    // machine nothing, and `local` belongs to the system user, so a human
    // owner's bearer token never sees it.
    expect(rows.map((r) => r.id)).toEqual([bobNode]);
    const row = rows[0];
    expect(row?.access).toBe("owner");
    expect(row?.status).toBe("offline");
    // The payload the MCP picker needs: canLaunch and the per-harness rows.
    expect(row?.canLaunch).toBe(true);
    expect(row?.harnesses.length).toBeGreaterThan(0);
    expect(row?.harnesses.every((h) => typeof h.harnessId === "string" && typeof h.installed === "boolean")).toBe(true);
  });

  it("invisibility: foreign nodes are ABSENT for the bearer, shares included, never a 403", async () => {
    const rows = ((await (await bearerList(bobSubshellKey)).json()) as { nodes: Row[] }).nodes;
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(alicePrivate)).toBe(false); // unshared foreign node
    expect(ids.has(aliceNamed)).toBe(false); // Bob's OWN named `edit` grant
    expect(ids.has(aliceEveryone)).toBe(false); // the Everyone grant
    expect(ids.has("local")).toBe(false); // system-owned; never a human's listByOwner row
  });

  it("act-denied: the same token is refused on node writes and on the detail route", async () => {
    // The pair that makes the list a disclosure door and not a widening: the
    // read answers, every write and the per-node detail stay cookie-only.
    const rename = await app.fetch(
      new Request(`http://localhost:3080/api/nodes/${bobNode}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${bobSubshellKey}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "machine-renamed" }),
      }),
    );
    expect(rename.status).toBe(403);
    const detail = await app.fetch(
      new Request(`http://localhost:3080/api/nodes/${bobNode}`, {
        headers: { authorization: `Bearer ${bobSubshellKey}` },
      }),
    );
    expect(detail.status).toBe(403);
    // And the rename really did not happen: the 403 is a refusal, not a lie.
    expect((await nodes.findById(bobNode))?.name).not.toBe("machine-renamed");
  });

  // The disclosure decision Task 1's review asked to be pinned: a SYSTEM
  // key's principal is the `system` service user (auth-guard resolves the
  // key's referenceId, not the admin who minted it), and that user owns
  // exactly one node row: the seeded `local`. So the full-access credential
  // sees exactly the control-plane host through this door and nothing else.
  // No human's agent node rides a listByOwner under the system id.
  it("a system key sees exactly the system-owned `local` row", async () => {
    const created = await systemKeysRoutes.fetch(
      authedRequest("/api/system-keys", adminCookie, { method: "POST", body: JSON.stringify({ name: "nb-pin" }) }),
    );
    expect(created.status).toBe(200);
    const { key, id } = (await created.json()) as { key: string; id: string };
    createdKeyIds.push(id);

    const res = await bearerList(key);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { nodes: Row[] }).nodes;
    // EXACTLY one row, and it is `local`: the same exactness argument the
    // first case makes for Bob, nobody else's node is owned by the system
    // user, so no concurrent suite can add a row to this set.
    expect(rows.map((r) => r.id)).toEqual(["local"]);
    // Honest rendering for this actor class: the system user owns the row,
    // and the owner reading is what `nodeCanLaunchOn` will apply to it.
    expect(rows[0]?.access).toBe("owner");
  });

  it("cookie behavior is unchanged: grants still widen the human's list exactly as before", async () => {
    const rows = ((await (await cookieList(bobCookie)).json()) as { nodes: Row[] }).nodes;
    const byId = new Map(rows.map((r) => [r.id, r.access]));
    // Own + named grant + Everyone grant + the seeded `local` all ride the
    // cookie list; Alice's private row stays invisible to the human too.
    // (A membership assert, not an exact set: suites run concurrently against
    // one shared DB, and another suite's Everyone grant may legitimately be
    // in this list. The bearer test above CAN be exact: nobody else's row is
    // owned by Bob.)
    expect(byId.get(bobNode)).toBe("owner");
    expect(byId.get(aliceNamed)).toBe("edit");
    expect(byId.get(aliceEveryone)).toBe("view");
    expect(byId.get("local")).toBeDefined();
    expect(byId.has(alicePrivate)).toBe(false);
  });
});
