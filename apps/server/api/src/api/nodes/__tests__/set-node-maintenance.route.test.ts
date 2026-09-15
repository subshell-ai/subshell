import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok } from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * `PUT /api/nodes/:id/maintenance` (spec 2026-09-14 §5.4) — the browser half
 * of a flag the machine can also set for itself.
 *
 * OWNER-only (`gate.canManage`, with the seeded-`local` admin exception), on
 * the same gate as delete and re-share rather than the `nodeCanConfigure` one
 * the service verbs use. The reason is what the act does: it stops subshells
 * belonging to everyone the node was shared with, including people the owner
 * cannot see, so it is not a grantee's decision to make about someone else's
 * machine.
 *
 * The count the confirmation needs (`runningSubshells`) rides the node detail
 * for managers only — the people who can flip it are the only people who need
 * to know what it would cost.
 */
describe("node maintenance route", () => {
  const pw = "maintenance-1";
  const ownerEmail = `mt-owner-${crypto.randomUUID()}@subshell.local`;
  const editorEmail = `mt-editor-${crypto.randomUUID()}@subshell.local`;
  const otherEmail = `mt-other-${crypto.randomUUID()}@subshell.local`;
  const adminEmail = `mt-admin-${crypto.randomUUID()}@subshell.local`;
  let ownerId: string;
  let editorId: string;
  let otherId: string;
  let ownerCookie: string;
  let editorCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  const NODE = `n-mt-${crypto.randomUUID()}`;
  const subshells = new SubshellsRepository(db);
  const KEYED = `s-mt-key-${crypto.randomUUID()}`;

  async function mkUser(email: string, role: "user" | "admin" = "user"): Promise<string> {
    return await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role,
    });
  }

  /**
   * A running row on the test node, owned by whoever is named.
   *
   * `tmuxSocket: null` on purpose — the terminate path only reaches a launcher
   * for a row that has one, so these retire through the bookkeeping half
   * (status, token, audit) without needing a tmux server on the test host.
   *
   * @param tmuxSocket - a path here is what routes the kill through the row's
   *   launcher, which is the only way a refusal can be produced at all
   */
  async function seedRunning(id: string, userId: string, tmuxSocket: string | null = null): Promise<void> {
    await db
      .insertInto("subshells")
      .values({
        id,
        userId,
        name: id,
        harnessId: "claude-code",
        workingDir: "/tmp",
        tmuxSocket,
        nodeId: NODE,
        status: "running",
        alive: 1,
      } as never)
      .execute();
  }

  /** Every `node.maintenance.update` row this file's node has collected, id-keyed. */
  async function maintenanceAudit(): Promise<Map<string, { actorUserId: string | null; meta: { source?: string } }>> {
    const rows = await db
      .selectFrom("auditEvents")
      .select(["id", "actorUserId", "metadataJson"])
      .where("targetId", "=", NODE)
      .where("action", "=", "node.maintenance.update")
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        { actorUserId: r.actorUserId, meta: JSON.parse(r.metadataJson ?? "null") as { source?: string } },
      ]),
    );
  }

  function put(nodeId: string, cookie: string | undefined, on: boolean, bearer?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cookie) headers.cookie = `better-auth.session_token=${cookie}`;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${nodeId}/maintenance`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ on }),
      }),
    );
  }

  function get(nodeId: string, cookie: string) {
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${nodeId}`, {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
  }

  beforeAll(async () => {
    await setupAuthTables();
    ownerId = await mkUser(ownerEmail);
    editorId = await mkUser(editorEmail);
    otherId = await mkUser(otherEmail);
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
    await db.deleteFrom("subshells").where("nodeId", "=", NODE).execute();
    await db.deleteFrom("subshells").where("id", "=", KEYED).execute();
    await db.deleteFrom("nodes").where("id", "=", NODE).execute();
    await db
      .updateTable("nodes")
      .set({ maintenance: 0, maintenanceAt: null, maintenanceSource: null } as never)
      .where("id", "=", LOCAL_NODE_ID)
      .execute();
    for (const email of [ownerEmail, editorEmail, otherEmail, adminEmail]) await deleteUserByEmailOrId(email);
  });

  it("the owner turns it on, and the answer is the node view carrying the flag", async () => {
    const res = await put(NODE, ownerCookie, true);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { maintenance: boolean; maintenanceSource: string; canLaunch: boolean };
    expect(view.maintenance).toBe(true);
    expect(view.maintenanceSource).toBe("plane");
    // The whole point of the flag: this viewer owns the node and still cannot
    // launch on it.
    expect(view.canLaunch).toBe(false);
  });

  it("stops every running subshell on the node, including other people's", async () => {
    await put(NODE, ownerCookie, false);
    const mine = `s-mt-${crypto.randomUUID()}`;
    const theirs = `s-mt-${crypto.randomUUID()}`;
    await seedRunning(mine, ownerId);
    // A node share lets a grantee launch here, and their subshell stays
    // invisible to the node's owner — who nonetheless stops it. That is the
    // exposure the confirmation exists to state, so it must be real.
    await seedRunning(theirs, otherId);

    const res = await put(NODE, ownerCookie, true);
    expect(res.status).toBe(200);
    expect((await subshells.findById(mine))?.status).toBe("terminated");
    expect((await subshells.findById(theirs))?.status).toBe("terminated");
  });

  it("turning it off stops nothing and resurrects nothing", async () => {
    const res = await put(NODE, ownerCookie, false);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { maintenance: boolean; canLaunch: boolean };
    expect(view.maintenance).toBe(false);
    expect(view.canLaunch).toBe(true);
  });

  it("an edit grantee is refused — it is not their machine to take out of service", async () => {
    // Deliberately NOT `nodeCanConfigure`: an edit grantee may re-check and
    // read logs, but stopping everyone else's work on a machine they do not
    // own is a different act.
    expect((await put(NODE, editorCookie, true)).status).toBe(403);
  });

  it("a stranger gets 404, never 403 — an invisible node stays invisible", async () => {
    expect((await put(NODE, otherCookie, true)).status).toBe(404);
  });

  it("an admin is refused on a node they do not own, and allowed on `local`", async () => {
    // The admin boost is instance-wide EDIT, never ownership: `canManage` is
    // the real owner, plus admins on the seeded host alone.
    expect((await put(NODE, adminCookie, true)).status).toBe(403);
    // Deliberately the OFF direction on the host. Every file in this package
    // shares one database, and turning maintenance ON for `local` would stop
    // every running subshell in it — including other suites' fixtures, whose
    // tokens it would revoke. (That is not hypothetical: it retired this
    // file's own bearer fixture before the assertion below was reordered.)
    // Off proves the gate and touches nothing.
    const res = await put(LOCAL_NODE_ID, adminCookie, false);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { maintenance: boolean }).maintenance).toBe(false);
  });

  it("refuses a valid bearer credential outright", async () => {
    // Machine credentials never manage a machine, and the key is a LIVE one
    // belonging to the node's own owner — so a 403 here is the cookie rule
    // refusing rather than authentication failing, which a bogus string would
    // not have distinguished.
    //
    // Minted inside the test rather than in `beforeAll`: terminating a
    // subshell revokes its token, and this suite terminates things.
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
    expect((await put(NODE, undefined, true, key)).status).toBe(403);
  });

  it("answers 404 for an unknown node", async () => {
    expect((await put(`n-missing-${crypto.randomUUID()}`, ownerCookie, true)).status).toBe(404);
  });

  it("is idempotent: turning it on twice stops nothing the second time", async () => {
    await put(NODE, ownerCookie, false);
    const id = `s-mt-${crypto.randomUUID()}`;
    await seedRunning(id, ownerId);

    const first = (await (await put(NODE, ownerCookie, true)).json()) as { stopped?: string[] };
    const second = (await (await put(NODE, ownerCookie, true)).json()) as { stopped?: string[] };
    expect(first.stopped).toEqual([id]);
    // The flag is written before the sweep, so a second call finds nothing
    // left to stop rather than racing the first over the same rows.
    expect(second.stopped).toEqual([]);
  });

  it("names the acting human and the plane in the audit row", async () => {
    // The ROUTE is the only place `actorUserId: user.id` and `source: "plane"`
    // are wired together — the service takes both as arguments, so a
    // regression to a null actor (or to `"node"`, which would read as the
    // machine having done this to itself) passes every test of the service.
    await put(NODE, ownerCookie, false);
    const before = await maintenanceAudit();
    expect((await put(NODE, ownerCookie, true)).status).toBe(200);

    // Keyed on which row is NEW rather than on "the latest": rows share a
    // millisecond stamp and their ids are unordered nanoids, so a
    // newest-first read cannot name this act's row.
    const added = [...(await maintenanceAudit())].filter(([id]) => !before.has(id));
    expect(added).toHaveLength(1);
    expect(added[0][1].actorUserId).toBe(ownerId);
    expect(added[0][1].meta.source).toBe("plane");
  });

  it("carries the running count for a manager, and withholds it from everyone else", async () => {
    await put(NODE, ownerCookie, false);
    const id = `s-mt-${crypto.randomUUID()}`;
    await seedRunning(id, otherId);

    const asOwner = (await (await get(NODE, ownerCookie)).json()) as { runningSubshells?: number };
    // Counted across owners: the confirmation promises to stop everything
    // here, so a number that omitted other people's work would understate it.
    expect(asOwner.runningSubshells).toBe(1);

    // An `edit` grantee can configure this node but cannot flip the switch, so
    // the cost of flipping it is not their business — and the count would tell
    // them how much invisible work sits on a machine they do not own.
    const asEditor = (await (await get(NODE, editorCookie)).json()) as { runningSubshells?: number };
    expect(asEditor.runningSubshells).toBeUndefined();
  });

  // Last in the file: it leaves a live scripted connection and an unkilled row
  // on the node, and detaching in a `finally` is only half of that promise.
  it("reports a refused kill as failed, and never counts it among the stopped", async () => {
    await put(NODE, ownerCookie, false);
    const stubborn = `s-mt-${crypto.randomUUID()}`;
    const willing = `s-mt-${crypto.randomUUID()}`;
    // A socket is what routes the kill to the node at all; without one the
    // row retires through bookkeeping alone and no refusal is reachable.
    await seedRunning(stubborn, ownerId, `/tmp/sock-${stubborn}`);
    await seedRunning(willing, ownerId, `/tmp/sock-${willing}`);
    const scripted = attachScriptedNode(NODE, {
      kill: (cmd) =>
        cmd.type === "kill" && cmd.subshellId === stubborn ? new Error("tmux: pane is unkillable") : undefined,
      set_maintenance: ok,
    });
    try {
      const res = await put(NODE, ownerCookie, true);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { stopped: string[]; failed?: string[] };
      expect(body.failed).toEqual([stubborn]);
      // The one assertion the whole field exists for: a refused kill counted
      // as stopped sends someone away from a machine still running the pane.
      expect(body.stopped).not.toContain(stubborn);
      expect(body.stopped).toContain(willing);
      expect((await subshells.findById(stubborn))?.status).toBe("running");
      expect((await subshells.findById(willing))?.status).toBe("terminated");
    } finally {
      scripted.detach();
    }
  });
});
