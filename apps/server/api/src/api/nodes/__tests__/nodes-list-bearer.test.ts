import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { nodesRoutes } from "@/api/nodes/index.js";
import { systemKeysRoutes } from "@/api/system-keys.route.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { authDatabase } from "@/modules/auth/database.js";
import { ensureSystemUser } from "@/modules/auth/system-user.js";
import { ensureLocalNode } from "@/modules/nodes/seed-local.js";
import { issueSubshellToken } from "@/modules/subshells/tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

/**
 * `GET /api/nodes` for a bearer actor (spec 2026-09-25 MCP DX): the machine
 * consumer the cookie-only phase deferred to arrived, and its door is
 * DISCLOSURE-ONLY. The bearer set is the same candidate source
 * `resolveLaunchNode` step 3 uses for every actor
 * (`NodesRepository.findAccessible`, no admin boost): the account's own agent
 * machines plus those SHARED with it, `local` included through its
 * Everyone/edit grant (operator ruling 2026-11-10 — a pane token holds the
 * node authority its account holds), so a pane token can see and pick among
 * machines it may actually launch on, with `canLaunch`/`access` honest for
 * that actor class. A private foreign node stays absent.
 *
 * Mirrors the shape and rigor of `subshells-list-visibility.test.ts`: a REAL
 * pane token mints the bearer, enumerate-ok pairs with act-denied, and every
 * invisibility is an ABSENCE, never a 403. The last bearer class is pinned
 * too: a SYSTEM key resolves as the `system` service user, which owns the
 * seeded `local` row and is a member of every Everyone grant.
 */
describe("GET /api/nodes bearer visibility (enumerate-ok / act-denied)", () => {
  const pw = "nodes-bearer-1";
  const bobEmail = `nb-bob-${crypto.randomUUID()}@subshell.local`;
  const aliceEmail = `nb-alice-${crypto.randomUUID()}@subshell.local`;
  const adminEmail = `nb-admin-${crypto.randomUUID()}@subshell.local`;
  let bobId: string;
  let aliceId: string;
  let adminId: string;
  let bobCookie: string;
  let adminCookie: string;
  /** A REAL subshell bearer key: Bob's pane's MCP token, the machine credential under test. */
  let bobSubshellKey: string;
  /** The same door with an admin behind it — the list must stay unboosted. */
  let adminSubshellKey: string;
  let systemId: string;

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

  let bobNode: string; // Bob's OWN agent node: `owner` for the bearer
  let alicePrivate: string; // unshared foreign node: absent, never 403
  let aliceNamed: string; // shared to Bob by name (edit): visible to the bearer
  let aliceEveryone: string; // shared to Everyone (view): visible to the bearer

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
    const admin = await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    adminId = admin;
    bobCookie = await signIn(bobEmail, pw);
    adminCookie = await signIn(adminEmail, pw);
    systemId = await ensureSystemUser();
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

    // The same for the admin: the list's NO-BOOST rule is only observable
    // through an admin token, and the system key below has a different
    // principal.
    const adminSid = `nb_s_admin_${crypto.randomUUID().slice(0, 8)}`;
    await new SubshellsRepository(db).create({
      id: adminSid,
      userId: adminId,
      presetId: "p",
      harnessId: "claude-code",
      name: adminSid,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    createdSubshellIds.push(adminSid);
    adminSubshellKey = await issueSubshellToken(adminSid, adminId);
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
    ownerLabel?: string;
    harnesses: { harnessId: string; installed: boolean; update?: { command: string } }[];
  };

  it("validates node search length and select filters", async () => {
    for (const [params, expected] of [
      [{ q: "x".repeat(128) }, 200],
      [{ q: "x".repeat(129) }, 400],
      [{ q: "🦊".repeat(65) }, 400],
      [{ status: "broken" }, 400],
      [{ access: "admin" }, 400],
    ] as const) {
      const response = await app.fetch(authedRequest(`/api/nodes?${new URLSearchParams(params)}`, bobCookie));
      expect(response.status).toBe(expected);
    }
  });

  it("combines search, status and access over the bearer's owned-and-shared set", async () => {
    const list = async (params: Record<string, string>, bearer = false) => {
      const response = await app.fetch(
        new Request(`http://localhost/api/nodes?${new URLSearchParams(params)}`, {
          headers: bearer
            ? { authorization: `Bearer ${bobSubshellKey}` }
            : { cookie: `better-auth.session_token=${bobCookie}` },
        }),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { nodes: Row[] }).nodes.map((n) => n.id);
    };
    expect(await list({ q: " NB-OWN- ", status: "offline", access: "yours" })).toEqual([bobNode]);
    expect(await list({ q: "nb-own-", status: "online" })).toEqual([]);
    expect(await list({ q: "nb-", access: "shared" })).toEqual(expect.arrayContaining([aliceNamed, aliceEveryone]));
    // The account's own rows plus the machines shared with it; the admin
    // boost adds nothing for a bearer.
    expect(await list({ q: "nb-", access: "shared" }, true)).toEqual(
      expect.arrayContaining([aliceNamed, aliceEveryone]),
    );
    expect(await list({ q: "nb-priv-" })).toEqual([]);
    const invalid = await app.fetch(authedRequest("/api/nodes?status=broken", bobCookie));
    expect(invalid.status).toBe(400);
  });

  it("enumerate-ok: the token sees its account's owned AND shared agent machines, honestly rendered", async () => {
    expect(bobSubshellKey.startsWith("subshell_")).toBe(true);
    const res = await bearerList(bobSubshellKey);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { nodes: Row[] }).nodes;
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Owned plus granted: the token acts as Bob's account (operator ruling
    // 2026-11-10). `local` rides its Everyone/edit grant, exactly as it does
    // on Bob's own Nodes page.
    expect(byId.get(bobNode)?.access).toBe("owner");
    expect(byId.get(aliceNamed)?.access).toBe("edit");
    expect(byId.get(aliceEveryone)?.access).toBe("view");
    expect(byId.get(bobNode)?.canLaunch).toBe(true);
    expect(byId.get(aliceNamed)?.canLaunch).toBe(true);
    expect(byId.get(aliceEveryone)?.canLaunch).toBe(true);
    expect(byId.get("local")?.access).toBe("edit");
    expect(byId.get("local")?.canLaunch).toBe(true);
    const row = byId.get(bobNode);
    expect(row?.status).toBe("offline");
    // The payload the MCP picker needs: canLaunch and the per-harness rows.
    expect(row?.harnesses.length).toBeGreaterThan(0);
    expect(row?.harnesses.every((h) => typeof h.harnessId === "string" && typeof h.installed === "boolean")).toBe(true);
    // The list is disclosure-only: a machine credential that may not run the
    // update route (no `nodes:configure`) does not receive its shell line.
    expect(row?.harnesses.every((h) => h.update === undefined)).toBe(true);
    // Owner labels are an admin fact on the browser arm; a bearer payload
    // carries none, even for an owned row.
    expect(row?.ownerLabel).toBeUndefined();
  });

  it("visibility boundary: shares widen the bearer set; `local` rides its Everyone grant; private rows stay out", async () => {
    const rows = ((await (await bearerList(bobSubshellKey)).json()) as { nodes: Row[] }).nodes;
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(alicePrivate)).toBe(false); // unshared foreign node
    expect(ids.has(aliceNamed)).toBe(true); // Bob's named `edit` grant
    expect(ids.has(aliceEveryone)).toBe(true); // the Everyone grant
    expect(ids.has("local")).toBe(true); // Everyone/edit, same as the human's list
  });

  it("removing local's Everyone row drops it from the bearer set (the switch's visibility half)", async () => {
    const before = ((await (await bearerList(bobSubshellKey)).json()) as { nodes: Row[] }).nodes;
    expect(before.map((r) => r.id)).toContain(LOCAL_NODE_ID);
    await nodeShares.replaceForNode(LOCAL_NODE_ID, [], systemId);
    try {
      // access "none" is an ABSENCE, not a 403: the same rule hides it from
      // the account's browser list and from the launch picker.
      const after = ((await (await bearerList(bobSubshellKey)).json()) as { nodes: Row[] }).nodes;
      expect(after.map((r) => r.id)).not.toContain(LOCAL_NODE_ID);
    } finally {
      await nodeShares.replaceForNode(LOCAL_NODE_ID, [{ granteeUserId: null, permission: "edit" }], systemId);
    }
  });

  it("an admin's token reads the NON-BOOSTED set: private nodes stay out and a view grant stays view", async () => {
    const rows = ((await (await bearerList(adminSubshellKey)).json()) as { nodes: Row[] }).nodes;
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The cookie admin arm (findAllMachines + boosted edit) is browser-only.
    expect(byId.has(alicePrivate)).toBe(false);
    expect(byId.has(aliceNamed)).toBe(false); // the grant names Bob, not the admin
    expect(byId.get(aliceEveryone)?.access).toBe("view"); // not the boosted edit
    expect(byId.has("local")).toBe(true);
    expect([...byId.values()].every((r) => r.ownerLabel === undefined)).toBe(true);
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
  // key's referenceId, not the admin who minted it). That user OWNS the seeded
  // `local` row and is a member of every Everyone grant, so its set is the
  // control-plane host plus any Everyone-shared agent machine; a private row
  // (Bob's node, Alice's private node) stays absent.
  it("a system key sees the system-owned `local` row plus Everyone-shared machines", async () => {
    const created = await systemKeysRoutes.fetch(
      authedRequest("/api/system-keys", adminCookie, {
        method: "POST",
        body: JSON.stringify({ name: "nb-pin", permissions: ["nodes:read"] }),
      }),
    );
    expect(created.status).toBe(200);
    const { key, id } = (await created.json()) as { key: string; id: string };
    createdKeyIds.push(id);

    const res = await bearerList(key);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { nodes: Row[] }).nodes;
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Honest rendering for this actor class: the system user owns `local`, and
    // the owner reading is what `nodeCanLaunchOn` applies to it.
    expect(byId.get("local")?.access).toBe("owner");
    expect(byId.has(bobNode)).toBe(false);
    expect(byId.has(alicePrivate)).toBe(false);
    // The Everyone grant includes the system account (a membership assert:
    // concurrent suites may add their own Everyone rows to this shared DB).
    expect(byId.has(aliceEveryone)).toBe(true);
  });

  it("cookie behavior is unchanged: grants still widen the human's list exactly as before", async () => {
    const rows = ((await (await cookieList(bobCookie)).json()) as { nodes: Row[] }).nodes;
    const byId = new Map(rows.map((r) => [r.id, r.access]));
    // Own + named grant + Everyone grant + the seeded `local` all ride the
    // cookie list; Alice's private row stays invisible to the human too.
    // (A membership assert, not an exact set: suites run concurrently against
    // one shared DB, and another suite's Everyone grant or share may
    // legitimately be in this list.)
    expect(byId.get(bobNode)).toBe("owner");
    expect(byId.get(aliceNamed)).toBe("edit");
    expect(byId.get(aliceEveryone)).toBe("view");
    expect(byId.get("local")).toBeDefined();
    expect(byId.has(alicePrivate)).toBe(false);
  });
});
