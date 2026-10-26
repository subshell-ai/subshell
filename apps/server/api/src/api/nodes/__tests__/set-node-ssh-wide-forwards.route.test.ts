import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "@/modules/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

/**
 * `PUT /api/nodes/:id/ssh-wide-forwards` (spec 2026-10-15 §6) — the per-node
 * wide-bind allowance for SSH port forwards, opt-in and off by default,
 * cloned from the SSH switch down to the gate: owner (`canManage`, admin on
 * `local`), deliberately not the `edit` grantee's door.
 *
 * The route performs no write and records no audit itself —
 * `setNodeSshWideForwards` is the one change-site — so this file asserts the
 * ROUTE wired the acting human into that row.
 */
describe("node ssh-wide-forwards route", () => {
  const pw = "ssh-wide-1";
  const ownerEmail = `wf-owner-${crypto.randomUUID()}@subshell.local`;
  const editorEmail = `wf-editor-${crypto.randomUUID()}@subshell.local`;
  const otherEmail = `wf-other-${crypto.randomUUID()}@subshell.local`;
  const adminEmail = `wf-admin-${crypto.randomUUID()}@subshell.local`;
  let ownerId: string;
  let editorId: string;
  let ownerCookie: string;
  let editorCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  const NODE = `n-wf-${crypto.randomUUID()}`;

  async function mkUser(email: string, role: "user" | "admin" = "user"): Promise<string> {
    return await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role,
    });
  }

  async function wfAudit(): Promise<Map<string, { actorUserId: string | null; metadataJson: string | null }>> {
    const rows = await db
      .selectFrom("auditEvents")
      .select(["id", "actorUserId", "metadataJson"])
      .where("targetId", "=", NODE)
      .where("action", "=", "node.ssh_wide_forwards.update")
      .execute();
    return new Map(rows.map((r) => [r.id, { actorUserId: r.actorUserId, metadataJson: r.metadataJson }]));
  }

  function put(nodeId: string, cookie: string, on: boolean) {
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${nodeId}/ssh-wide-forwards`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${cookie}` },
        body: JSON.stringify({ on }),
      }),
    );
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
        status: "offline",
        createdAt: now,
        updatedAt: now,
      } as never)
      .execute();
    await new NodeSharesRepository(db).replaceForNode(NODE, [{ granteeUserId: editorId, permission: "edit" }], ownerId);
  });

  afterAll(async () => {
    await db.deleteFrom("nodes").where("id", "=", NODE).execute();
    await db
      .updateTable("nodes")
      .set({ sshWideForwards: 0 } as never)
      .where("id", "=", LOCAL_NODE_ID)
      .execute();
    for (const email of [ownerEmail, editorEmail, otherEmail, adminEmail]) await deleteUserByEmailOrId(email);
  });

  it("defaults off: a fresh node's view carries false", async () => {
    const res = await put(NODE, ownerCookie, false);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sshWideForwards: boolean }).sshWideForwards).toBe(false);
  });

  it("the owner turns it on, and the answer is the node view carrying the flag", async () => {
    const res = await put(NODE, ownerCookie, true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sshWideForwards: boolean }).sshWideForwards).toBe(true);
  });

  it("names the acting human and carries ONLY {on} in the audit row", async () => {
    await put(NODE, ownerCookie, false);
    const before = await wfAudit();

    expect((await put(NODE, ownerCookie, true)).status).toBe(200);
    const added = [...(await wfAudit())].filter(([id]) => !before.has(id));
    expect(added).toHaveLength(1);
    expect(added[0][1].actorUserId).toBe(ownerId);
    expect(added[0][1].metadataJson).toBe('{"on":true}');
  });

  it("an edit grantee is refused — it is not their machine to widen", async () => {
    expect((await put(NODE, editorCookie, true)).status).toBe(403);
  });

  it("a stranger gets 404, never 403 — an invisible node stays invisible", async () => {
    expect((await put(NODE, otherCookie, true)).status).toBe(404);
  });

  it("answers 404 for an unknown node", async () => {
    expect((await put(`n-missing-${crypto.randomUUID()}`, ownerCookie, true)).status).toBe(404);
  });

  it("an admin is refused on a node they do not own, and allowed on `local`", async () => {
    expect((await put(NODE, adminCookie, true)).status).toBe(403);
    expect((await put(LOCAL_NODE_ID, otherCookie, true)).status).toBe(403);
    const res = await put(LOCAL_NODE_ID, adminCookie, true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sshWideForwards: boolean }).sshWideForwards).toBe(true);
  });
});
