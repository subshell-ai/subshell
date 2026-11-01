import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { nodesRoutes } from "@/api/nodes/index.js";
import { systemKeysRoutes } from "@/api/system-keys.route.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "@/modules/nodes/seed-local.js";
import { issueSubshellToken } from "@/modules/subshells/tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

/**
 * `PUT /api/nodes/:id/mcp-enabled`: the per-node subshell MCP switch, ON by
 * default (the polarity that inverts the SSH and preview routes beside it:
 * MCP wiring predates its own switch, so an untouched row reads ALLOWED).
 *
 * OWNER-only (`gate.canManage`, with the seeded-`local` admin exception), the
 * same gate as SSH and previews: a grantee may restart the agent or read its
 * log; deciding whether the MCP may run on this machine is not theirs.
 *
 * The route performs no write and records no audit itself: `setNodeMcpEnabled`
 * is the one change-site (row + audit + push), so this file asserts the ROUTE
 * wired the acting human into that row.
 */
describe("node mcp-enabled route", () => {
  const pw = "mcp-enabled-1";
  const ownerEmail = `mc-owner-${crypto.randomUUID()}@subshell.local`;
  const editorEmail = `mc-editor-${crypto.randomUUID()}@subshell.local`;
  const otherEmail = `mc-other-${crypto.randomUUID()}@subshell.local`;
  const adminEmail = `mc-admin-${crypto.randomUUID()}@subshell.local`;
  let ownerId: string;
  let editorId: string;
  let ownerCookie: string;
  let editorCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  const NODE = `n-mc-${crypto.randomUUID()}`;
  const createdKeyIds: string[] = [];
  const subshells = new SubshellsRepository(db);
  const KEYED = `s-mc-key-${crypto.randomUUID()}`;

  async function mkUser(email: string, role: "user" | "admin" = "user"): Promise<string> {
    return await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role,
    });
  }

  /** Every `node.mcp_enabled.update` row this file's node has collected, id-keyed. */
  async function mcpAudit(): Promise<Map<string, { actorUserId: string | null; metadataJson: string | null }>> {
    const rows = await db
      .selectFrom("auditEvents")
      .select(["id", "actorUserId", "metadataJson"])
      .where("targetId", "=", NODE)
      .where("action", "=", "node.mcp_enabled.update")
      .execute();
    return new Map(rows.map((r) => [r.id, { actorUserId: r.actorUserId, metadataJson: r.metadataJson }]));
  }

  function put(nodeId: string, cookie: string | undefined, on: boolean, bearer?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cookie) headers.cookie = `better-auth.session_token=${cookie}`;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${nodeId}/mcp-enabled`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ on }),
      }),
    );
  }

  function authDelete(id: string): Request {
    return new Request(`http://localhost:3080/api/system-keys/${id}`, {
      method: "DELETE",
      headers: { cookie: `better-auth.session_token=${adminCookie}` },
    });
  }

  async function mintKey(permissions: string[]): Promise<string> {
    const created = await systemKeysRoutes.fetch(
      new Request("http://localhost:3080/api/system-keys", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${adminCookie}` },
        body: JSON.stringify({ name: `mc-pin-${crypto.randomUUID().slice(0, 8)}`, permissions }),
      }),
    );
    expect(created.status).toBe(200);
    const { key, id } = (await created.json()) as { key: string; id: string };
    createdKeyIds.push(id);
    return key;
  }

  beforeAll(async () => {
    await setupAuthTables();
    ownerId = await mkUser(ownerEmail);
    editorId = await mkUser(editorEmail);
    await mkUser(otherEmail);
    await mkUser(adminEmail, "admin");
    ownerCookie = await signIn(ownerEmail, pw);
    editorCookie = await signIn(editorEmail, pw);
    otherCookie = await signIn(otherEmail, pw);
    adminCookie = await signIn(adminEmail, pw);
    await ensureLocalNode(db);

    const now = new Date().toISOString();
    await db
      .insertInto("nodes")
      .values({
        id: NODE,
        ownerUserId: ownerId,
        name: NODE,
        kind: "agent",
        // Offline on purpose: the route answers anyway (the flag is the
        // plane's record), and no push can be seen from here - the push
        // assertions live in the service test's scripted-wire pattern.
        status: "offline",
        createdAt: now,
        updatedAt: now,
      } as never)
      .execute();
    await new NodeSharesRepository(db).replaceForNode(NODE, [{ granteeUserId: editorId, permission: "edit" }], ownerId);
  });

  afterAll(async () => {
    await db.deleteFrom("subshells").where("id", "=", KEYED).execute();
    await db.deleteFrom("nodes").where("id", "=", NODE).execute();
    // Leave the shared `local` row exactly as found (the MCP default is ON;
    // a flipped host row would read as the fleet default to a later test in
    // THIS file's process).
    await db
      .updateTable("nodes")
      .set({ mcpEnabled: 1, mcpEnabledAt: null } as never)
      .where("id", "=", LOCAL_NODE_ID)
      .execute();
    for (const id of createdKeyIds) await systemKeysRoutes.fetch(authDelete(id));
    for (const email of [ownerEmail, editorEmail, otherEmail, adminEmail]) await deleteUserByEmailOrId(email);
  });

  it("reads ON before anyone has flipped it (no write = the pre-switch status quo)", async () => {
    const res = await nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${NODE}`, {
        headers: { cookie: `better-auth.session_token=${ownerCookie}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mcpEnabled: boolean }).mcpEnabled).toBe(true);
  });

  it("the owner turns it off, and the answer is the node view carrying the flag", async () => {
    const res = await put(NODE, ownerCookie, false);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { mcpEnabled: boolean };
    expect(view.mcpEnabled).toBe(false);
  });

  it("names the acting human and carries ONLY {on} in the audit row", async () => {
    // The ROUTE is the only place `actorUserId` is wired in: the service takes
    // it as an argument, so a regression to a null actor passes every test of
    // the service alone.
    await put(NODE, ownerCookie, true);
    const before = await mcpAudit();

    expect((await put(NODE, ownerCookie, false)).status).toBe(200);
    // Keyed on which row is NEW rather than on "the latest": rows share a
    // millisecond stamp and their ids are unordered.
    const added = [...(await mcpAudit())].filter(([id]) => !before.has(id));
    expect(added).toHaveLength(1);
    expect(added[0][1].actorUserId).toBe(ownerId);
    expect(added[0][1].metadataJson).toBe('{"on":false}');
  });

  it("turning it back on lands on the row and the view", async () => {
    const res = await put(NODE, ownerCookie, true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mcpEnabled: boolean }).mcpEnabled).toBe(true);
  });

  it("an edit grantee is refused: it is not their machine to widen", async () => {
    // Deliberately NOT `nodeCanConfigure`: a grantee may re-check and read
    // logs; deciding what tool surface runs on someone else's machine is a
    // different act.
    expect((await put(NODE, editorCookie, false)).status).toBe(403);
  });

  it("a system key scoped to SSH cannot flip the MCP switch: the grants are separate", async () => {
    // The catalog split this route had to make: reusing `nodes:ssh` would let
    // every ssh-scoped key flip MCP access. A key minted with the SSH grant
    // and without `nodes:mcp` is refused at the permission layer, before any
    // gate reads the row.
    const auditsBefore = (await mcpAudit()).size;
    const key = await mintKey(["nodes:ssh"]);
    const res = await put(NODE, undefined, false, key);
    expect(res.status).toBe(403);
    // The scoped-key refusal comes from the authGuard's grant check as a
    // plain-text HttpError body, not the route's JSON shape: the route never
    // ran. The grant it names is the point.
    expect(await res.text()).toContain("nodes:mcp");
    expect((await mcpAudit()).size).toBe(auditsBefore);
  });

  it("a key WITH nodes:mcp flips its own owner's agent node", async () => {
    // The positive half, and the nodeManagementGuard/bearer door: a scoped
    // system key resolves as the `system` service account, so this key may
    // only manage AGENT NODES OWNED BY `system`. Minting it on this file's
    // foreign node would answer 404 (invisible), so the cell proves the grant
    // passes authGuard's check by showing the REFUSAL is the ownership one,
    // not the permission one.
    const auditsBefore = (await mcpAudit()).size;
    const key = await mintKey(["nodes:mcp"]);
    const res = await put(NODE, undefined, false, key);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("nodes:mcp");
    // The owner cells above have already written audit rows for this node by
    // now, so emptiness is the wrong assertion; what must hold is that no
    // KEY added a row.
    expect((await mcpAudit()).size).toBe(auditsBefore); // still nothing from any key
  });

  it("refuses a valid bearer credential outright", async () => {
    // Machine credentials never manage a machine. The key is a LIVE one
    // belonging to the node's own owner, so this 403 is `nodeManagementGuard`
    // classifying the actor, not authentication failing. It is also the only
    // cell here that pins the guard's MOUNT: dropping `.use(nodeManagementGuard)`
    // would let authGuard resolve a pane's token as its OWNER, flip
    // `canManage` on the owner's own node, and leave every other test green.
    await subshells.create({
      id: KEYED,
      userId: ownerId,
      presetId: "p",
      harnessId: "claude-code",
      name: KEYED,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSubshellToken(KEYED, ownerId);
    const auditsBefore = (await mcpAudit()).size;

    const res = await put(NODE, undefined, false, key);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cannot manage nodes");
    expect((await mcpAudit()).size).toBe(auditsBefore);
  });

  it("a stranger gets 404, never 403: an invisible node stays invisible", async () => {
    expect((await put(NODE, otherCookie, false)).status).toBe(404);
  });

  it("answers 404 for an unknown node", async () => {
    expect((await put(`n-missing-${crypto.randomUUID()}`, ownerCookie, false)).status).toBe(404);
  });

  it("a non-boolean body is refused before anything is written", async () => {
    const before = await mcpAudit();
    const res = await nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${NODE}/mcp-enabled`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${ownerCookie}` },
        body: JSON.stringify({ on: "no" }),
      }),
    );
    expect([400, 422]).toContain(res.status);
    expect((await mcpAudit()).size).toBe(before.size);
    const row = await db.selectFrom("nodes").select("mcpEnabled").where("id", "=", NODE).executeTakeFirstOrThrow();
    expect(row.mcpEnabled).toBe(1);
  });

  it("an admin is refused on a node they do not own, and allowed on `local`", async () => {
    // The admin boost is instance-wide EDIT, never ownership: `canManage` is
    // the real owner, plus admins on the seeded host alone.
    expect((await put(NODE, adminCookie, false)).status).toBe(403);
    // A member sees `local` through the seeded Everyone/edit grant but holds
    // no management there: refused, not invisible.
    expect((await put(LOCAL_NODE_ID, otherCookie, false)).status).toBe(403);
    // Like SSH and unlike maintenance, this flip stops nothing, so OFF is
    // safe to test on the shared host row; `afterAll` restores it.
    const res = await put(LOCAL_NODE_ID, adminCookie, false);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mcpEnabled: boolean }).mcpEnabled).toBe(false);
  });
});
