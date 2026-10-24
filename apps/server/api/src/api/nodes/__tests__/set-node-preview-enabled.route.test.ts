import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { nodesRoutes } from "@/api/nodes/index.js";
import { systemKeysRoutes } from "@/api/system-keys.route.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * `PUT /api/nodes/:id/views-enabled` (pane-preview spec Task 3): the
 * per-node preview switch, opt-in and off by default, cloned from the SSH
 * capability route it sits beside.
 *
 * OWNER-only (`gate.canManage`, with the seeded-`local` admin exception), the
 * same gate as SSH and maintenance: a grantee may restart the agent or read
 * its log, but deciding whether this machine's pane content may be watched is
 * not theirs.
 *
 * The route performs no write and records no audit itself. `setPreviewEnabled`
 * is the one change-site (row + audit + push), so this file asserts the ROUTE
 * wired the acting human into that row.
 */
describe("node preview-enabled route", () => {
  const pw = "preview-enabled-1";
  const ownerEmail = `pv-owner-${crypto.randomUUID()}@subshell.local`;
  const editorEmail = `pv-editor-${crypto.randomUUID()}@subshell.local`;
  const otherEmail = `pv-other-${crypto.randomUUID()}@subshell.local`;
  const adminEmail = `pv-admin-${crypto.randomUUID()}@subshell.local`;
  let ownerId: string;
  let editorId: string;
  let ownerCookie: string;
  let editorCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  const NODE = `n-pv-${crypto.randomUUID()}`;
  const createdKeyIds: string[] = [];
  const subshells = new SubshellsRepository(db);
  const KEYED = `s-pv-key-${crypto.randomUUID()}`;

  async function mkUser(email: string, role: "user" | "admin" = "user"): Promise<string> {
    return await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role,
    });
  }

  /** Every `node.preview_enabled.update` row this file's node has collected, id-keyed. */
  async function previewAudit(): Promise<Map<string, { actorUserId: string | null; metadataJson: string | null }>> {
    const rows = await db
      .selectFrom("auditEvents")
      .select(["id", "actorUserId", "metadataJson"])
      .where("targetId", "=", NODE)
      .where("action", "=", "node.preview_enabled.update")
      .execute();
    return new Map(rows.map((r) => [r.id, { actorUserId: r.actorUserId, metadataJson: r.metadataJson }]));
  }

  function put(nodeId: string, cookie: string | undefined, on: boolean, bearer?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cookie) headers.cookie = `better-auth.session_token=${cookie}`;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${nodeId}/views-enabled`, {
        method: "PUT",
        headers,
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
    // Leave the shared `local` row exactly as found: every file in this
    // package gets its own database, but a flipped host switch still reads as
    // the fleet default if a later test in THIS file's process re-reads it.
    await db
      .updateTable("nodes")
      .set({ previewEnabled: 0, previewEnabledAt: null } as never)
      .where("id", "=", LOCAL_NODE_ID)
      .execute();
    for (const id of createdKeyIds) {
      await systemKeysRoutes.fetch(authDelete(id));
    }
    for (const email of [ownerEmail, editorEmail, otherEmail, adminEmail]) await deleteUserByEmailOrId(email);
  });

  function authDelete(id: string): Request {
    return new Request(`http://localhost:3080/api/system-keys/${id}`, {
      method: "DELETE",
      headers: { cookie: `better-auth.session_token=${adminCookie}` },
    });
  }

  it("reads OFF before anyone has flipped it (no row = no history = off)", async () => {
    const res = await nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${NODE}`, {
        headers: { cookie: `better-auth.session_token=${ownerCookie}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { viewsEnabled: boolean }).viewsEnabled).toBe(false);
  });

  it("the owner turns it on, and the answer is the node view carrying the flag", async () => {
    const res = await put(NODE, ownerCookie, true);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { viewsEnabled: boolean };
    expect(view.viewsEnabled).toBe(true);
  });

  it("names the acting human and carries ONLY {on} in the audit row", async () => {
    // The ROUTE is the only place `actorUserId` is wired in: the service
    // takes it as an argument, so a regression to a null actor passes every
    // test of the service alone.
    await put(NODE, ownerCookie, false);
    const before = await previewAudit();

    expect((await put(NODE, ownerCookie, true)).status).toBe(200);
    // Keyed on which row is NEW rather than on "the latest": rows share a
    // millisecond stamp and their ids are unordered, so a newest-first read
    // cannot name this act's row.
    const added = [...(await previewAudit())].filter(([id]) => !before.has(id));
    expect(added).toHaveLength(1);
    expect(added[0][1].actorUserId).toBe(ownerId);
    // The metadata is the STRING `"{\"on\":true}"`: the flag and nothing else
    // (audit never carries secrets).
    expect(added[0][1].metadataJson).toBe('{"on":true}');
  });

  it("turning it off lands on the row and the view", async () => {
    const res = await put(NODE, ownerCookie, false);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { viewsEnabled: boolean }).viewsEnabled).toBe(false);
  });

  it("an edit grantee is refused: it is not their machine to widen", async () => {
    // Deliberately NOT `nodeCanConfigure`: a grantee may re-check and read
    // logs; deciding whether someone may watch this machine's panes is a
    // different act.
    expect((await put(NODE, editorCookie, true)).status).toBe(403);
  });

  it("a system key scoped to SSH cannot flip preview: the grants are separate", async () => {
    // The catalog split this task had to make: reusing `nodes:ssh` would let
    // every ssh-scoped key flip preview. A key minted with the SSH grant and
    // without `nodes:preview` is refused at the permission layer, before any
    // gate reads the row.
    const auditsBefore = (await previewAudit()).size;
    const created = await systemKeysRoutes.fetch(
      new Request("http://localhost:3080/api/system-keys", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${adminCookie}` },
        body: JSON.stringify({ name: `pv-pin-${crypto.randomUUID().slice(0, 8)}`, permissions: ["nodes:ssh"] }),
      }),
    );
    expect(created.status).toBe(200);
    const { key, id } = (await created.json()) as { key: string; id: string };
    createdKeyIds.push(id);

    const res = await nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${NODE}/views-enabled`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ on: true }),
      }),
    );
    expect(res.status).toBe(403);
    // The scoped-key refusal comes from the authGuard's onBeforeHandle as a
    // plain-text HttpError body, not the route's JSON error shape - the route
    // never ran. The grant it names is the point.
    expect(await res.text()).toContain("nodes:preview");
    // The refusal is real: the audit trail did not grow.
    expect((await previewAudit()).size).toBe(auditsBefore);
  });

  it("refuses a valid bearer credential outright", async () => {
    // Machine credentials never manage a machine. The key is a LIVE one
    // belonging to the node's own owner, so this 403 is `nodeManagementGuard`
    // classifying the actor, not authentication failing, which a bogus string
    // would not have distinguished. It is also the only cell here that pins
    // the guard's MOUNT: a scoped key is refused one layer earlier, by
    // authGuard's grant check, so dropping `.use(nodeManagementGuard)` from
    // the route would let authGuard resolve a pane's token as its OWNER, flip
    // `canManage` on the owner's own node, and leave every other test in this
    // file green.
    //
    // Minted inside the test rather than in `beforeAll`, the maintenance
    // precedent's discipline: terminating a subshell revokes its token, so
    // this test owns its key end to end.
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
    const auditsBefore = (await previewAudit()).size;

    const res = await put(NODE, undefined, true, key);
    expect(res.status).toBe(403);
    // The refusal names the guard, not the preview grant: a pane token
    // carries no node permission map at all, so it never reaches the
    // `nodes:preview` check the scoped-key cell above pins. (The guard
    // answers with a plain-text HttpError, the same shape the scoped-key
    // refusal has; the route's JSON error never ran.)
    expect(await res.text()).toContain("cannot manage nodes");
    // The refusal is real: the row did not move.
    expect((await previewAudit()).size).toBe(auditsBefore);
  });

  it("a stranger gets 404, never 403: an invisible node stays invisible", async () => {
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
    // no management there: refused, not invisible (a node on the page must
    // not answer "not found").
    expect((await put(LOCAL_NODE_ID, otherCookie, true)).status).toBe(403);
    // Like SSH and unlike maintenance, this flip stops nothing, so ON is safe
    // to test on the shared host row; `afterAll` restores it.
    const res = await put(LOCAL_NODE_ID, adminCookie, true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { viewsEnabled: boolean }).viewsEnabled).toBe(true);
  });
});
