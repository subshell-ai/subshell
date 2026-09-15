import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { NotificationsRepository } from "@/db/repositories/notifications.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { reconcileMaintenance, setNodeMaintenance } from "@/services/nodes/maintenance.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { __setSenderForTests, type PushSender } from "@/services/notify.service.js";

/**
 * `setNodeMaintenance` — the act itself (spec 2026-09-14 §5.2).
 *
 * The three properties that are easy to get wrong and expensive to get wrong:
 *
 * - it stops EVERY owner's subshells on that node, using each row's own
 *   `userId` (the terminate path is owner-keyed, so an actor-keyed loop would
 *   silently skip everybody but the person who clicked);
 * - the people whose work it stopped are TOLD, which is the whole reason
 *   `terminateForMaintenance` exists beside the deliberately-silent
 *   `terminateSubshell`;
 * - it works on an OFFLINE node, retiring rows `killUnverified` rather than
 *   refusing, because "take this machine out of service" must not depend on
 *   the machine answering.
 */

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const subs = new NotificationsRepository(db);

const pw = "maint-pass-1";
const emails: string[] = [];
const nodeIds: string[] = [];
let ownerId: string;
let otherId: string;

/** Push bodies captured per endpoint, so a notification can be attributed to its owner. */
let pushes: { endpoint: string; body: string }[] = [];
const capture: PushSender = async (sub, payload) => {
  pushes.push({ endpoint: sub.endpoint, body: (JSON.parse(payload) as { body: string }).body });
  return { statusCode: 201 };
};

async function mkUser(): Promise<string> {
  const email = `maint-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
}

/** An enrolled agent node with no live socket — every command on it fails offline. */
async function mkNode(ownerUserId: string): Promise<string> {
  const id = crypto.randomUUID();
  nodeIds.push(id);
  await nodes.create({ id, ownerUserId, name: `maint-${id.slice(0, 8)}`, kind: "agent", status: "online" });
  return id;
}

/** A running subshell on `nodeId`, owned by `userId`, with its bell on. */
async function mkSubshell(userId: string, nodeId: string): Promise<string> {
  const id = crypto.randomUUID();
  await subshells.create({
    id,
    userId,
    presetId: null,
    harnessId: "claude-code",
    name: `s-${id.slice(0, 8)}`,
    workingDir: "/tmp",
    tmuxSocket: `/tmp/sock-${id}`,
    nodeId,
    alive: 1,
    notify: 1,
    startedAt: new Date().toISOString(),
    lastOutputAt: new Date().toISOString(),
  });
  return id;
}

/** Audit rows for one target, newest last. */
async function auditFor(targetId: string, action: string): Promise<{ actorUserId: string | null; meta: unknown }[]> {
  const rows = await db
    .selectFrom("auditEvents")
    .select(["actorUserId", "metadataJson"])
    .where("targetId", "=", targetId)
    .where("action", "=", action)
    .orderBy("createdAt", "asc")
    .execute();
  return rows.map((r) => ({ actorUserId: r.actorUserId, meta: JSON.parse(r.metadataJson ?? "null") }));
}

/**
 * Let the void-fired pushes land. `terminateForMaintenance` fires its
 * notification without awaiting — a slow sink must not hold up a node's whole
 * maintenance window — so a test that reads `pushes` immediately is reading
 * before the send, not after a missing one.
 */
const settle = () => new Promise((r) => setTimeout(r, 25));

beforeAll(async () => {
  await setupAuthTables();
  ownerId = await mkUser();
  otherId = await mkUser();
  __setSenderForTests(capture);
  // Each owner has one browser subscribed, so a push is attributable.
  await subs.upsertForUser(ownerId, `https://push.test/${ownerId}`, "p256dh-a", "auth-a");
  await subs.upsertForUser(otherId, `https://push.test/${otherId}`, "p256dh-b", "auth-b");
});

beforeEach(() => {
  pushes = [];
});

afterAll(async () => {
  __setSenderForTests(null);
  resetNodeRegistryForTests();
  for (const id of nodeIds) await nodes.deleteById(id);
  for (const email of emails) await deleteUserByEmailOrId(email);
});

describe("setNodeMaintenance — turning it on", () => {
  it("stops every owner's subshells on the node, with each row's own id, and tells them", async () => {
    const nodeId = await mkNode(ownerId);
    // The node's OWNER and someone they shared it with: any node share lets a
    // grantee launch here, and those subshells are private to the grantee —
    // so this is precisely the work a node owner cannot see and stops anyway.
    const mine = await mkSubshell(ownerId, nodeId);
    const theirs = await mkSubshell(otherId, nodeId);
    const changedAt = new Date().toISOString();

    const { stopped } = await setNodeMaintenance({
      nodeId,
      on: true,
      changedAt,
      source: "plane",
      actorUserId: ownerId,
    });

    expect(stopped.sort()).toEqual([mine, theirs].sort());
    await settle();
    expect((await subshells.findById(mine))?.status).toBe("terminated");
    expect((await subshells.findById(theirs))?.status).toBe("terminated");

    // Each owner heard about it, in the words that name the cause. Without
    // the per-row push a grantee finds a dead pane and no account of why.
    expect(pushes.sort((a, b) => a.endpoint.localeCompare(b.endpoint))).toEqual(
      [
        { endpoint: `https://push.test/${ownerId}`, body: "Stopped for node maintenance" },
        { endpoint: `https://push.test/${otherId}`, body: "Stopped for node maintenance" },
      ].sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    );
  });

  it("writes the flag, the stamp and the source", async () => {
    const nodeId = await mkNode(ownerId);
    const changedAt = "2026-09-14T10:00:00.000Z";
    await setNodeMaintenance({ nodeId, on: true, changedAt, source: "plane", actorUserId: ownerId });
    const row = await nodes.findById(nodeId);
    expect(row?.maintenance).toBe(1);
    expect(row?.maintenanceAt).toBe(changedAt);
    expect(row?.maintenanceSource).toBe("plane");
  });

  it("retires rows on an OFFLINE node, unverified — the machine never had to answer", async () => {
    const nodeId = await mkNode(ownerId);
    const id = await mkSubshell(ownerId, nodeId);
    await setNodeMaintenance({
      nodeId,
      on: true,
      changedAt: new Date().toISOString(),
      source: "plane",
      actorUserId: ownerId,
    });
    expect((await subshells.findById(id))?.status).toBe("terminated");
    // The kill could not be confirmed, and the row is retired regardless
    // (spec §5.6). The node's reconnect census kills whatever survived.
    const terminations = await auditFor(id, "subshell.terminate");
    expect(terminations).toHaveLength(1);
    expect((terminations[0].meta as { killUnverified?: boolean }).killUnverified).toBe(true);
  });

  it("audits the act once, naming what it stopped", async () => {
    const nodeId = await mkNode(ownerId);
    const id = await mkSubshell(ownerId, nodeId);
    const changedAt = "2026-09-14T11:00:00.000Z";
    await setNodeMaintenance({ nodeId, on: true, changedAt, source: "plane", actorUserId: ownerId });
    const rows = await auditFor(nodeId, "node.maintenance.update");
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(ownerId);
    expect(rows[0].meta).toEqual({ on: true, source: "plane", stopped: [id], changedAt });
  });

  it("records no actor when the MACHINE decided", async () => {
    const nodeId = await mkNode(ownerId);
    await setNodeMaintenance({
      nodeId,
      on: true,
      changedAt: "2026-09-14T12:00:00.000Z",
      source: "node",
      actorUserId: null,
    });
    const rows = await auditFor(nodeId, "node.maintenance.update");
    expect(rows[0].actorUserId).toBeNull();
    expect((rows[0].meta as { source: string }).source).toBe("node");
  });

  it("is idempotent: a second run finds nothing left to stop", async () => {
    const nodeId = await mkNode(ownerId);
    await mkSubshell(ownerId, nodeId);
    const first = await setNodeMaintenance({
      nodeId,
      on: true,
      changedAt: "2026-09-14T13:00:00.000Z",
      source: "plane",
      actorUserId: ownerId,
    });
    expect(first.stopped).toHaveLength(1);
    await settle();
    pushes = [];
    const second = await setNodeMaintenance({
      nodeId,
      on: true,
      changedAt: "2026-09-14T13:00:01.000Z",
      source: "plane",
      actorUserId: ownerId,
    });
    // The flag was already set and the rows already retired, so there is
    // nothing to stop and nobody to disturb a second time.
    expect(second.stopped).toEqual([]);
    await settle();
    expect(pushes).toEqual([]);
    expect(await auditFor(nodeId, "node.maintenance.update")).toHaveLength(2);
  });
});

describe("NodesRepository.create mirrors the column defaults", () => {
  it("a new node launches, with no stamp and no source", async () => {
    // The insert is typed and complete, so a read-back never has to guess —
    // and the value it mirrors is the one migration 0031 defaults to, which
    // is what keeps a fresh enrollment out of a window nobody opened.
    const id = crypto.randomUUID();
    nodeIds.push(id);
    const row = await nodes.create({ id, ownerUserId: ownerId, name: `mirror-${id.slice(0, 8)}`, kind: "agent" });
    expect(row.maintenance).toBe(0);
    expect(row.maintenanceAt).toBeNull();
    expect(row.maintenanceSource).toBeNull();
  });
});

describe("reconcileMaintenance — the hook body", () => {
  it("ADOPTS a newer node report: writes the row, stops what was running, records the node as the source", async () => {
    const nodeId = await mkNode(ownerId);
    const id = await mkSubshell(ownerId, nodeId);
    // Somebody ran `subshell maintenance on --yes` at the keyboard.
    await reconcileMaintenance(nodeId, { on: true, changedAt: "2026-09-14T16:00:00.000Z" });
    const row = await nodes.findById(nodeId);
    expect(row?.maintenance).toBe(1);
    expect(row?.maintenanceAt).toBe("2026-09-14T16:00:00.000Z");
    expect(row?.maintenanceSource).toBe("node");
    // The effects are void-fired so they cannot stall the socket's frame
    // queue; the flag itself is written before the hook returns.
    await settle();
    expect((await subshells.findById(id))?.status).toBe("terminated");
    const rows = await auditFor(nodeId, "node.maintenance.update");
    expect(rows[0].actorUserId).toBeNull();
    expect(rows[0].meta).toEqual({
      on: true,
      source: "node",
      stopped: [id],
      changedAt: "2026-09-14T16:00:00.000Z",
    });
  });

  it("CLAMPS a future-dated machine clock, so a skewed node cannot outrank the plane forever", async () => {
    const nodeId = await mkNode(ownerId);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await reconcileMaintenance(nodeId, { on: true, changedAt: future });
    const stored = (await nodes.findById(nodeId))?.maintenanceAt ?? "";
    expect(Date.parse(stored)).toBeLessThan(Date.parse(future));
    await settle();
  });

  it("leaves the row alone when the PLANE's value is newer, and when the two agree", async () => {
    const nodeId = await mkNode(ownerId);
    await setNodeMaintenance({
      nodeId,
      on: true,
      changedAt: "2026-09-14T18:00:00.000Z",
      source: "plane",
      actorUserId: ownerId,
    });
    // Older report: the plane stands and the node is told (best-effort, so
    // nothing here observes the push — only that the row did not move).
    await reconcileMaintenance(nodeId, { on: false, changedAt: "2026-09-14T17:00:00.000Z" });
    expect((await nodes.findById(nodeId))?.maintenanceSource).toBe("plane");
    expect((await nodes.findById(nodeId))?.maintenanceAt).toBe("2026-09-14T18:00:00.000Z");
    // Equal stamps: the steady state after any reconcile, and a no-op.
    await reconcileMaintenance(nodeId, { on: true, changedAt: "2026-09-14T18:00:00.000Z" });
    expect((await nodes.findById(nodeId))?.maintenanceAt).toBe("2026-09-14T18:00:00.000Z");
    // One flip, one audit row — a reconcile that decided nothing records nothing.
    expect(await auditFor(nodeId, "node.maintenance.update")).toHaveLength(1);
  });

  it("does nothing for a node that is not enrolled here", async () => {
    await expect(
      reconcileMaintenance("not-a-node", { on: true, changedAt: new Date().toISOString() }),
    ).resolves.toBeUndefined();
  });
});

describe("setNodeMaintenance — turning it off, and `local`", () => {
  it("clears the flag and stops nothing", async () => {
    const nodeId = await mkNode(ownerId);
    const id = await mkSubshell(ownerId, nodeId);
    const { stopped } = await setNodeMaintenance({
      nodeId,
      on: false,
      changedAt: "2026-09-14T14:00:00.000Z",
      source: "plane",
      actorUserId: ownerId,
    });
    expect(stopped).toEqual([]);
    expect((await nodes.findById(nodeId))?.maintenance).toBe(0);
    // Ending a window never touches panes — only entering one does.
    expect((await subshells.findById(id))?.status).toBe("running");
  });

  it("works on `local`, where there is no machine to push to", async () => {
    // The control-plane host has no agent socket and no mirror file, so the
    // push is skipped rather than failing — which is the difference between
    // a clean act and a warn line on every flip of the host's own switch.
    await nodes.create({ id: LOCAL_NODE_ID, ownerUserId: ownerId, name: "Server", kind: "local" }).catch(() => {});
    const before = await nodes.findById(LOCAL_NODE_ID);
    const changedAt = "2026-09-14T15:00:00.000Z";
    await setNodeMaintenance({ nodeId: LOCAL_NODE_ID, on: true, changedAt, source: "plane", actorUserId: ownerId });
    expect((await nodes.findById(LOCAL_NODE_ID))?.maintenance).toBe(1);
    // Restore whatever the shared test DB had, so no later suite inherits a
    // control-plane host that refuses every launch.
    await setNodeMaintenance({
      nodeId: LOCAL_NODE_ID,
      on: before?.maintenance === 1,
      changedAt: before?.maintenanceAt ?? new Date().toISOString(),
      source: "plane",
      actorUserId: ownerId,
    });
    expect((await nodes.findById(LOCAL_NODE_ID))?.maintenance).toBe(before?.maintenance ?? 0);
  });
});
