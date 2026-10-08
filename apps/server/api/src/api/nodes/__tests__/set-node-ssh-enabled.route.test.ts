import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * `PUT /api/nodes/:id/ssh-enabled` (spec 4.3) — the per-node SSH capability
 * gate, opt-in and off by default.
 *
 * OWNER-only (`gate.canManage`, with the seeded-`local` admin exception), the
 * same gate as maintenance, delete and re-share — deliberately NOT the
 * `nodeCanConfigure` gate an `edit` grantee holds. The act is what decides it:
 * flipping this on lets the plane dial out of and serve keys from an OS
 * account this machine owns; a grantee may restart the agent or read its log,
 * but widening what SSH can do from someone else's machine is not theirs.
 *
 * The route performs no write and records no audit itself — `setNodeSshEnabled`
 * is the one change-site (row + audit, and from Task 7 the push), so this file
 * asserts the ROUTE wired the acting human into that row.
 */
describe("node ssh-enabled route", () => {
  const pw = "ssh-enabled-1";
  const ownerEmail = `sh-owner-${crypto.randomUUID()}@subshell.local`;
  const editorEmail = `sh-editor-${crypto.randomUUID()}@subshell.local`;
  const otherEmail = `sh-other-${crypto.randomUUID()}@subshell.local`;
  const adminEmail = `sh-admin-${crypto.randomUUID()}@subshell.local`;
  let ownerId: string;
  let editorId: string;
  let ownerCookie: string;
  let editorCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  const NODE = `n-sh-${crypto.randomUUID()}`;

  async function mkUser(email: string, role: "user" | "admin" = "user"): Promise<string> {
    return await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role,
    });
  }

  /** Every `node.ssh_enabled.update` row this file's node has collected, id-keyed. */
  async function sshAudit(): Promise<Map<string, { actorUserId: string | null; metadataJson: string | null }>> {
    const rows = await db
      .selectFrom("auditEvents")
      .select(["id", "actorUserId", "metadataJson"])
      .where("targetId", "=", NODE)
      .where("action", "=", "node.ssh_enabled.update")
      .execute();
    return new Map(rows.map((r) => [r.id, { actorUserId: r.actorUserId, metadataJson: r.metadataJson }]));
  }

  function put(nodeId: string, cookie: string, on: boolean) {
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${nodeId}/ssh-enabled`, {
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
    // Leave the shared `local` row exactly as found: every file in this
    // package gets its own database, but a flipped host gate still reads as
    // the fleet default if a later test in THIS file's process re-reads it.
    await db
      .updateTable("nodes")
      .set({ sshEnabled: 0, sshEnabledAt: null } as never)
      .where("id", "=", LOCAL_NODE_ID)
      .execute();
    for (const email of [ownerEmail, editorEmail, otherEmail, adminEmail]) await deleteUserByEmailOrId(email);
  });

  it("the owner turns it on, and the answer is the node view carrying the flag", async () => {
    const res = await put(NODE, ownerCookie, true);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { sshEnabled: boolean };
    expect(view.sshEnabled).toBe(true);
  });

  it("names the acting human and carries ONLY {on} in the audit row", async () => {
    // The ROUTE is the only place `actorUserId: user.id` is wired in — the
    // service takes it as an argument, so a regression to a null actor passes
    // every test of the service alone.
    await put(NODE, ownerCookie, false);
    const before = await sshAudit();

    expect((await put(NODE, ownerCookie, true)).status).toBe(200);
    // Keyed on which row is NEW rather than on "the latest": rows share a
    // millisecond stamp and their ids are unordered, so a newest-first read
    // cannot name this act's row.
    const added = [...(await sshAudit())].filter(([id]) => !before.has(id));
    expect(added).toHaveLength(1);
    expect(added[0][1].actorUserId).toBe(ownerId);
    // The metadata is the STRING `"{\"on\":true}"`: the flag and nothing else
    // — no key material, no config values (spec 4.3; audit never carries secrets).
    expect(added[0][1].metadataJson).toBe('{"on":true}');
  });

  it("turning it off lands on the row and the view", async () => {
    const res = await put(NODE, ownerCookie, false);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sshEnabled: boolean }).sshEnabled).toBe(false);
  });

  it("an edit grantee is refused — it is not their machine to widen", async () => {
    // Deliberately NOT `nodeCanConfigure`: a grantee may re-check and read
    // logs; enabling SSH through someone else's OS account is a different act.
    expect((await put(NODE, editorCookie, true)).status).toBe(403);
  });

  it("a stranger gets 404, never 403 — an invisible node stays invisible", async () => {
    expect((await put(NODE, otherCookie, true)).status).toBe(404);
  });

  it("answers 404 for an unknown node", async () => {
    expect((await put(`n-missing-${crypto.randomUUID()}`, ownerCookie, true)).status).toBe(404);
  });

  it("an admin is refused on a node they do not own, and allowed on `local`", async () => {
    // The admin boost is instance-wide EDIT, never ownership: `canManage` is
    // the real owner, plus admins on the seeded host alone.
    expect((await put(NODE, adminCookie, true)).status).toBe(403);
    // A member sees `local` through the seeded Everyone/edit grant but holds
    // no management there — refused, not invisible (a node on the page must
    // not answer "not found").
    expect((await put(LOCAL_NODE_ID, otherCookie, true)).status).toBe(403);
    // Unlike maintenance, this flip stops nothing, so ON is safe to test on
    // the shared host row; `afterAll` restores it.
    const res = await put(LOCAL_NODE_ID, adminCookie, true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sshEnabled: boolean }).sshEnabled).toBe(true);
  });
});
