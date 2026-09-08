import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { NodeHarnessesRepository } from "@/db/repositories/node-harnesses.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { restoreLocalNode } from "@/services/__tests__/helpers/local-node.js";

let seq = 0;
// Salt per file: every test file in one `bun test` invocation shares one process
// (same pid) and its seq restarts at 0, so the bare pid+seq id would collide
// across files (e.g. the nodes owner+name unique index).
const salt = Math.random().toString(36).slice(2, 8);
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

async function mkNode(repo: NodesRepository, ownerUserId: string, name = unique("node")) {
  return repo.create({
    id: unique("n"),
    ownerUserId,
    name,
    kind: "agent",
    status: "offline",
    createdAt: new Date().toISOString(),
  });
}

beforeAll(async () => {
  await runMigrations();
});

// This file re-owns `local` to a fixture user and revokes its Everyone
// share to prove the share row IS the visibility filter. Both mutations are
// invisible to this file and fatal to later ones, which assume the row boot
// seeds — so hand it back exactly as found.
afterAll(restoreLocalNode);

describe("NodesRepository", () => {
  const repo = new NodesRepository(db);

  it("create + findById round-trip", async () => {
    const n = await mkNode(repo, unique("u"));
    const found = await repo.findById(n.id);
    expect(found?.name).toBe(n.name);
    expect(found?.status).toBe("offline");
  });

  it("findAccessible: owner yes, stranger no, view-sharee yes", async () => {
    const owner = unique("u");
    const stranger = unique("u");
    const grantee = unique("u");
    const n = await mkNode(repo, owner);
    expect((await repo.findAccessible(owner)).some((x) => x.id === n.id)).toBe(true);
    expect((await repo.findAccessible(stranger)).some((x) => x.id === n.id)).toBe(false);
    await db
      .insertInto("nodeShares")
      .values({
        id: unique("sh"),
        nodeId: n.id,
        granteeUserId: grantee,
        permission: "view",
        createdBy: owner,
        createdAt: new Date().toISOString(),
      })
      .execute();
    expect((await repo.findAccessible(grantee)).some((x) => x.id === n.id)).toBe(true);
    // Everyone grant reaches any viewer
    await db
      .insertInto("nodeShares")
      .values({
        id: unique("sh"),
        nodeId: n.id,
        granteeUserId: null,
        permission: "view",
        createdBy: owner,
        createdAt: new Date().toISOString(),
      })
      .execute();
    expect((await repo.findAccessible(stranger)).some((x) => x.id === n.id)).toBe(true);
  });

  it("findAccessible: local rides its seeded Everyone share — no share, not visible", async () => {
    // Re-seed the control-plane row (shared temp DB may already carry one).
    await db.deleteFrom("nodes").where("id", "=", LOCAL_NODE_ID).execute();
    const local = await repo.create({
      id: LOCAL_NODE_ID,
      ownerUserId: "system-local-fixture",
      name: "local",
      kind: "local",
      status: "offline",
      createdAt: new Date().toISOString(),
    });
    const viewer = unique("u");
    // (a) the Everyone/edit share (what phase-1 boot seeds) makes local visible
    await db
      .insertInto("nodeShares")
      .values({
        id: unique("sh"),
        nodeId: LOCAL_NODE_ID,
        granteeUserId: null,
        permission: "edit",
        createdBy: local.ownerUserId,
        createdAt: new Date().toISOString(),
      })
      .execute();
    expect((await repo.findAccessible(viewer)).some((x) => x.id === LOCAL_NODE_ID)).toBe(true);
    // (b) the share row IS the filter: revoke it and a non-owner loses local
    await db.deleteFrom("nodeShares").where("nodeId", "=", LOCAL_NODE_ID).execute();
    expect((await repo.findAccessible(viewer)).some((x) => x.id === LOCAL_NODE_ID)).toBe(false);
    // ownership still stands on its own
    expect((await repo.findAccessible(local.ownerUserId)).some((x) => x.id === LOCAL_NODE_ID)).toBe(true);
  });

  it("applyReady stamps identity, JSON-encodes capabilities, flips online", async () => {
    const n = await mkNode(repo, unique("u"));
    const updated = await repo.applyReady(n.id, {
      agentVersion: "0.1.0",
      protocolVersion: 1,
      os: "linux",
      arch: "x64",
      hostname: "box",
      capabilities: ["mcp"],
    });
    expect(updated?.status).toBe("online");
    expect(JSON.parse(updated?.capabilities ?? "[]")).toEqual(["mcp"]);
    expect(updated?.lastSeenAt).not.toBeNull();
  });

  it("setStatus/touch/setApiKeyId/applyInventory round-trip", async () => {
    const n = await mkNode(repo, unique("u"));
    await repo.setStatus(n.id, "online");
    expect((await repo.findById(n.id))?.status).toBe("online");
    await repo.setStatus(n.id, "offline");
    expect((await repo.findById(n.id))?.status).toBe("offline");
    await repo.touch(n.id);
    expect((await repo.findById(n.id))?.lastSeenAt).not.toBeNull();
    await repo.setApiKeyId(n.id, "key-1");
    expect((await repo.findById(n.id))?.apiKeyId).toBe("key-1");
    await repo.applyInventory(n.id, "[]");
    expect((await repo.findById(n.id))?.inventoryJson).toBe("[]");
  });

  it("markStaleAgentsOffline: stale + never-seen flip, fresh + local survive", async () => {
    const owner = unique("u");
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

    const fresh = await mkNode(repo, owner); // online, heartbeat 5 s ago
    await repo.setStatus(fresh.id, "online");
    await repo.touch(fresh.id);

    const stale = await mkNode(repo, owner); // online, heartbeat 10 min ago
    await repo.setStatus(stale.id, "online");
    await db
      .updateTable("nodes")
      .set({ lastSeenAt: iso(600_000) })
      .where("id", "=", stale.id)
      .execute();

    const neverSeen = await mkNode(repo, owner); // online (manually), lastSeenAt NULL
    await repo.setStatus(neverSeen.id, "online");

    const local = await repo.create({
      id: unique("n"),
      ownerUserId: owner,
      name: unique("node"),
      kind: "local",
      status: "online",
    });
    await db
      .updateTable("nodes")
      .set({ lastSeenAt: iso(600_000) })
      .where("id", "=", local.id)
      .execute();

    const alreadyOffline = await mkNode(repo, owner); // offline + stale → not counted
    await db
      .updateTable("nodes")
      .set({ lastSeenAt: iso(600_000) })
      .where("id", "=", alreadyOffline.id)
      .execute();

    const flipped = await repo.markStaleAgentsOffline(iso(45_000));
    expect(flipped).toBeGreaterThanOrEqual(2); // exactly stale + neverSeen (plus any foreign leftovers)

    expect((await repo.findById(fresh.id))?.status).toBe("online");
    expect((await repo.findById(stale.id))?.status).toBe("offline");
    expect((await repo.findById(neverSeen.id))?.status).toBe("offline");
    expect((await repo.findById(local.id))?.status).toBe("online"); // local is never swept
    expect((await repo.findById(alreadyOffline.id))?.status).toBe("offline");

    // Idempotent: a second run finds nothing of ours left to flip.
    const second = await repo.markStaleAgentsOffline(iso(45_000));
    expect(second).toBe(0);

    // Empty exclude array behaves EXACTLY like none — the clause is skipped,
    // not rendered as `not in ()` (which some builders turn into `(1=1)`/no-op
    // or invalid SQL depending on path).
    expect(await repo.markStaleAgentsOffline(iso(45_000), [])).toBe(0);

    // Registry-aware sweep: an excluded node (caller: has a LIVE socket) keeps
    // its `online` projection despite a stale lastSeenAt — a heartbeat-stalled
    // but reachable agent must not desync the DB from the registry.
    const stalledLive = await mkNode(repo, owner);
    await repo.setStatus(stalledLive.id, "online");
    await db
      .updateTable("nodes")
      .set({ lastSeenAt: iso(600_000) })
      .where("id", "=", stalledLive.id)
      .execute();
    await repo.markStaleAgentsOffline(iso(45_000), [stalledLive.id, unique("n")]);
    expect((await repo.findById(stalledLive.id))?.status).toBe("online");

    // Once it drops out of the exclude set (socket gone), the sweep catches it.
    expect(await repo.markStaleAgentsOffline(iso(45_000))).toBe(1);
    expect((await repo.findById(stalledLive.id))?.status).toBe("offline");
  });

  it("deleteById unpins profiles and removes the node; countPinnedProfiles pre-counts", async () => {
    const n = await mkNode(repo, unique("u"));
    const userId = unique("u");
    const now = new Date().toISOString();
    await db
      .insertInto("profiles")
      .values({
        id: unique("p"),
        userId,
        harnessId: "pi",
        name: unique("p"),
        description: "",
        envJson: "{}",
        flagsJson: "[]",
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
        isDefault: 0,
        nodeId: n.id,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    expect(await repo.countPinnedProfiles(n.id)).toBe(1);
    await repo.deleteById(n.id);
    expect(await repo.findById(n.id)).toBeUndefined();
    expect(await repo.countPinnedProfiles(n.id)).toBe(0); // profile survived, unpinned
  });
});

describe("NodeHarnessesRepository", () => {
  const nodes = new NodesRepository(db);
  const harnesses = new NodeHarnessesRepository(db);

  it("setEnabled upserts; enabledStates reads explicit rows only; clearForNode wipes", async () => {
    const n = await mkNode(nodes, unique("u"));
    expect((await harnesses.enabledStates(n.id)).size).toBe(0);
    await harnesses.setEnabled(n.id, "claude-code", true);
    await harnesses.setEnabled(n.id, "hermes", false);
    await harnesses.setEnabled(n.id, "hermes", false); // upsert, not a duplicate
    const states = await harnesses.enabledStates(n.id);
    expect(states.size).toBe(2);
    expect(states.get("claude-code")).toBe(true);
    expect(states.get("hermes")).toBe(false);
    await harnesses.setEnabled(n.id, "claude-code", false);
    expect((await harnesses.enabledStates(n.id)).get("claude-code")).toBe(false);
    await harnesses.clearForNode(n.id);
    expect((await harnesses.enabledStates(n.id)).size).toBe(0);
  });
});
