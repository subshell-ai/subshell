import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { NODE_KIND_RUNTIME } from "@/db/types/nodes.db-types.js";
import { reconcileSshRuntimeSessionsAtBoot } from "../session-settle.js";
import { SshRuntimeSessionsRepository } from "../sessions.repository.js";

/**
 * The boot sweep (review I1: `reconcileAtBoot` had ZERO callers tree-wide, so
 * after a plane restart `opening`/`active` rows read active forever, the
 * hidden runtime node rows stayed online, and the quota mirror counted dead
 * rows until an 8-session exhaustion with no remedy).
 *
 * This is the test that proves the sweep RUNS and DOES the thing: rows become
 * `lost` with `closedAt`, the runtime nodes go `offline`, terminal rows are
 * untouched, and the boot entry point returns what it swept. The wiring half
 * (the call from `index.ts`'s boot sequence) is read by the composition test
 * below it; this file executes the sweep against the migrated test database.
 */

const repo = new SshRuntimeSessionsRepository(db);
const nodes = new NodesRepository(db);

const cleanup: string[] = [];

interface Fixture {
  connectingNodeId: string;
  runtimeNodeId: string;
  sessionId: string;
}

async function mkPair(status: "opening" | "active" | "lost" | "closed"): Promise<Fixture> {
  const connectingNodeId = crypto.randomUUID();
  const runtimeNodeId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  cleanup.push(sessionId, runtimeNodeId, connectingNodeId);
  await nodes.create({
    id: connectingNodeId,
    ownerUserId: "boot-test-owner",
    name: `bt-${sessionId.slice(0, 8)}`,
    kind: "agent",
    status: "online",
  });
  await nodes.create({
    id: runtimeNodeId,
    ownerUserId: "boot-test-owner",
    name: `bt-rt-${sessionId.slice(0, 8)}`,
    kind: NODE_KIND_RUNTIME,
    status: "online",
  });
  await repo.create({
    id: sessionId,
    ownerUserId: "boot-test-owner",
    connectingNodeId,
    runtimeNodeId,
    alias: "bt",
    host: "127.0.0.1",
    port: 22,
    user: null,
    status,
  });
  return { connectingNodeId, runtimeNodeId, sessionId };
}

beforeAll(async () => {
  await ensureMigratedTestDb();
});

afterAll(async () => {
  for (const id of cleanup) {
    await db
      .deleteFrom("sshRuntimeSessions")
      .where("id", "=", id)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom("nodes")
      .where("id", "=", id)
      .execute()
      .catch(() => {});
  }
});

describe("reconcileSshRuntimeSessionsAtBoot (the I1 sweep, executed)", () => {
  test("stale opening/active rows become lost with closedAt; terminal rows are untouched", async () => {
    const staleOpening = await mkPair("opening");
    const staleActive = await mkPair("active");
    const wasLost = await mkPair("lost");
    const wasClosed = await mkPair("closed");

    const swept = await reconcileSshRuntimeSessionsAtBoot();

    // Returned exactly the stale pair (the sweep reports what it swept).
    expect(new Set(swept)).toEqual(new Set([staleOpening.sessionId, staleActive.sessionId]));

    for (const f of [staleOpening, staleActive]) {
      const row = await repo.findById(f.sessionId);
      expect(row?.status).toBe("lost");
      expect(row?.closedAt).not.toBeNull(); // design §6: the terminal stamp, not a silent rewrite
      const node = await nodes.findById(f.runtimeNodeId);
      expect(node?.status).toBe("offline"); // the hidden runtime row stops reading online
    }

    for (const f of [wasLost, wasClosed]) {
      const row = await repo.findById(f.sessionId);
      expect(row?.status).toBe(f.sessionId === wasLost.sessionId ? "lost" : "closed");
      // A terminal session's runtime row belongs to the transition that made
      // it terminal; the boot sweep must not reach back for it.
      const node = await nodes.findById(f.runtimeNodeId);
      expect(node?.status).toBe("online");
    }
  });

  test("a second boot sweep finds nothing (the sweep converges; never rewrites the swept)", async () => {
    // Same fixtures as the first test are already settled; the sweep is a
    // no-op now, which is what pins "terminal states are final".
    const swept = await reconcileSshRuntimeSessionsAtBoot();
    expect(swept).toEqual([]);
  });

  test("the connecting node's DELETE leaves the session row with a NULL ref (migration 0049's SET NULL, review M1: history outlives the machine)", async () => {
    const f = await mkPair("active");
    // Sweep it first so the row is terminal (the same posture a deleted
    // machine's history ends in; deleting a node with a live session is the
    // disconnect path's business, not this fixture's).
    await reconcileSshRuntimeSessionsAtBoot();
    await db.deleteFrom("nodes").where("id", "=", f.connectingNodeId).execute();
    const row = await repo.findById(f.sessionId);
    expect(row).toBeDefined();
    expect(row?.connectingNodeId).toBeNull(); // the connecting row is gone; the history is not
    expect(row?.status).toBe("lost");
    // The hidden runtime row (a different row) survives its own owner-node
    // delete untouched: it cascades from the SESSION's runtime ref, not from
    // the connecting machine.
    expect(await nodes.findById(f.runtimeNodeId)).toBeDefined();
  });
});

/**
 * The boot wiring (the review's other half: "never wired into server boot").
 * Read as a composition guard: the entry module imports the sweep and calls
 * it inside `bootServer`. A dropped call would otherwise be invisible to
 * every other test here.
 */
describe("the boot sequence calls the sweep (composition, review I1)", () => {
  test("index.ts imports reconcileSshRuntimeSessionsAtBoot and awaits it in bootServer", async () => {
    const source = await Bun.file(`${import.meta.dir}/../../../index.ts`).text();
    expect(source).toMatch(/reconcileSshRuntimeSessionsAtBoot/);
    // Called inside bootServer's body (after the migrations, the sweep reads
    // tables that migration 0049 creates); a top-level call would read the DB
    // before boot migrated it.
    const bootStart = source.indexOf("async function bootServer");
    expect(bootStart).toBeGreaterThan(-1);
    const callAt = source.indexOf("reconcileSshRuntimeSessionsAtBoot()", bootStart);
    expect(callAt).toBeGreaterThan(bootStart);
    // ...AFTER the migrations (the comment above promises it; a reorder above
    // runMigrations would warn-only skip the sweep against missing tables).
    expect(callAt).toBeGreaterThan(source.indexOf("await runMigrations()", bootStart));
    // ...and BEFORE the HTTP listener (review N-E): a session opening in the
    // window between `listen` and the sweep would have its fresh row marked
    // lost and its runtime node left offline until the next settle.
    const listenerAt = source.indexOf("await startServer(", bootStart);
    expect(listenerAt).toBeGreaterThan(callAt);
  });
});
