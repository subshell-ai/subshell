import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getRequestlessContext } from "@/app/context.js";
import { subscribeLive } from "@/app/live-bus.js";
import { runMigrations } from "@/db/migrate.js";
import type { Repositories } from "@/db/repositories/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import type { SubshellManagerService } from "@/modules/subshells/subshell-manager.service.js";
import { setRestartLeaseForTests } from "@/modules/subshells/subshell-manager.service.js";
import { HELPER_RETIRE_GRACE_MS, SubshellsService } from "@/modules/subshells/subshells.service.js";
import { getLogger } from "@/shared/logger.js";

/**
 * A cross-agent helper that is DONE leaves the sidebar on its own.
 *
 * The tree is status-blind (subshell-tree.ts) and nothing retired rows, so an
 * agent that let its helpers exit or crash without deleting them left leaf
 * entries under the creator forever — eight of them did on 2026-10-27, several
 * still stamped alive: 1 as launch residue. The sweep retires exactly two
 * truthful shapes past the grace: a helper that exited on its own
 * (`running, alive: 0`) and a launch-rollback zombie (`terminated, alive: 1`).
 * It deliberately refuses the cases where "done" is a lie: a deliberate
 * `terminate_subshell` (which zeroes `alive` and KEEPS the history per the
 * shipped guarantee), a row a restart currently owns, and a residue row whose
 * pane may still be running on an unreachable agent node (the census can only
 * reap a pane that still has a row). A running helper (`alive: 1`) is never
 * matched, orphaned or not, and neither is any row an agent did not open.
 */

const OWNER = "u-helper-retire";
const OFFLINE_AGENT = "node-offline-never-connected";
const subshellsRepo = new SubshellsRepository(getRequestlessContext().db);
let service: SubshellsService;
const created: string[] = [];

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

async function seed(over: {
  id: string;
  crossAgent: 0 | 1;
  parentSubshellId?: string | null;
  status?: "running" | "terminated";
  alive?: number;
  endedAt?: string | null;
  nodeId?: string;
}): Promise<void> {
  created.push(over.id);
  await subshellsRepo.create({
    id: over.id,
    userId: OWNER,
    harnessId: "terminal",
    name: "helper row",
    workingDir: "/tmp",
    // Null on purpose: a retired row has no session to kill, and the delete
    // path skips the launcher contact entirely for these.
    tmuxSocket: null,
    nodeId: over.nodeId ?? LOCAL_NODE_ID,
    crossAgent: over.crossAgent,
    parentSubshellId: over.parentSubshellId,
    status: over.status ?? "running",
    alive: over.alive ?? 1,
  });
  // endedAt is a DB-defaulted column the insert shape does not carry (it is
  // death-stamped, never born-set), so the seed patches it like applyDeath or
  // markTerminated would. Passing null explicitly models a manual-restart park.
  if (over.endedAt !== undefined) {
    await subshellsRepo.update(over.id, { endedAt: over.endedAt });
  }
}

/** A creator pane that is alive and recent, so it is never itself a candidate. */
async function seedCreator(): Promise<string> {
  const id = crypto.randomUUID();
  await seed({ id, crossAgent: 0, status: "running", alive: 1 });
  return id;
}

beforeAll(async () => {
  await runMigrations();
  const ctx = getRequestlessContext();
  service = new SubshellsService({ db: ctx.db, log: getLogger(), repos: ctx.repos });
});

afterAll(async () => {
  for (const id of created) {
    await subshellsRepo.delete(id).catch(() => {});
  }
});

describe("retireExpiredHelpers", () => {
  it("retires a helper that exited on its own past the grace, announcing its removal once", async () => {
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 1, parentSubshellId: parent, status: "running", alive: 0, endedAt: ago(40) });

    const deletes: string[] = [];
    const unsubscribe = subscribeLive((event) => {
      if (event.kind === "subshell.deleted" && event.id === id) deletes.push(event.id);
    });
    const retired = await service.retireExpiredHelpers();
    unsubscribe();

    expect(retired).toBe(1);
    expect(await subshellsRepo.findById(id)).toBeUndefined();
    // Exactly one frame, not "at least one": the whole point of routing the
    // sweep through #deleteAndAnnounce is once-per-landed-delete announcing.
    expect(deletes).toEqual([id]);

    // The trail says the system retired it, not the owner.
    const audits = await getRequestlessContext()
      .db.selectFrom("auditEvents")
      .select(["action", "metadataJson"])
      .where("targetId", "=", id)
      .execute();
    const deleteRow = audits.find((a) => a.action === "subshell.delete");
    expect(deleteRow?.metadataJson).toContain("autoRetired");
  });

  it("retires launch residue (terminated yet alive) on a reachable node", async () => {
    // The production 2026-10-27 rows: createSubshell's spawn-failure rollback
    // marked them terminated while alive stayed 1, invisible to every
    // running-gated death path. A deliberate terminate zeroes alive, so the
    // terminated+alive:1 shape is the rollback's alone, and sweeping it is safe.
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 1, parentSubshellId: parent, status: "terminated", alive: 1, endedAt: ago(40) });

    const retired = await service.retireExpiredHelpers();
    expect(retired).toBe(1);
    expect(await subshellsRepo.findById(id)).toBeUndefined();
  });

  it("keeps a deliberately terminated helper: terminate_subshell retains the history", async () => {
    // Regression pin for review M1. A real terminate zeroes alive (its
    // updateIfAlive before markTerminated), so terminated+alive:0 IS the kept
    // transcript the shipped guarantee promises. The sweep must never match it.
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 1, parentSubshellId: parent, status: "terminated", alive: 0, endedAt: ago(180) });

    const retired = await service.retireExpiredHelpers();
    expect(retired).toBe(0);
    const after = await subshellsRepo.findById(id);
    expect(after?.status).toBe("terminated");
    expect(after?.alive).toBe(0);
  });

  it("keeps a dead helper inside the grace (the creator's own window)", async () => {
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 1, parentSubshellId: parent, status: "running", alive: 0, endedAt: ago(5) });

    const retired = await service.retireExpiredHelpers();
    expect(retired).toBe(0);
    expect((await subshellsRepo.findById(id))?.id).toBe(id);
  });

  it("keeps a live helper whose creator is still around", async () => {
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 1, parentSubshellId: parent, status: "running", alive: 1 });

    const retired = await service.retireExpiredHelpers();
    expect(retired).toBe(0);
    expect((await subshellsRepo.findById(id))?.id).toBe(id);
  });

  it("keeps a live helper orphaned by its creator's deletion (never auto-deleted)", async () => {
    // parentSubshellId is null because the creator's row was deleted (the 0060
    // FK SET NULL). The tree already hides it (subshell-tree.ts nests only under
    // a present parent) and MCP still lists it, so the sweep does NOT delete a
    // running pane on the unverifiable guess that it went quiet.
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 1, parentSubshellId: null, status: "running", alive: 1 });

    const retired = await service.retireExpiredHelpers();
    expect(retired).toBe(0);
    expect((await subshellsRepo.findById(id))?.id).toBe(id);
  });

  it("keeps a long-dead row an agent did not open", async () => {
    // The asymmetry is the point: a person's parked pane stays until THEY
    // remove it. Only the cross-agent stamp makes a row self-clearing.
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 0, status: "running", alive: 0, endedAt: ago(600) });

    const retired = await service.retireExpiredHelpers();
    expect(retired).toBe(0);
    expect((await subshellsRepo.findById(id))?.id).toBe(id);
  });

  it("keeps a manual-restart park: alive: 0 with endedAt null is not a death", async () => {
    // parkForRestart writes running/alive:0 with endedAt NULL. A death always
    // stamps endedAt, and the `<= cutoff` comparison can never hold for NULL,
    // so a pane the operator is mid-restart reviving stays out of the set
    // (the predicate states `endedAt is not null` to make that explicit).
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 1, parentSubshellId: parent, status: "running", alive: 0, endedAt: null });

    const retired = await service.retireExpiredHelpers();
    expect(retired).toBe(0);
    expect((await subshellsRepo.findById(id))?.id).toBe(id);
  });

  it("skips residue whose agent node is unreachable (deleting would strand the pane)", async () => {
    // Regression pin for review M3. deleteSubshell swallows an
    // unreachable-node kill, and once the row is gone the reconnect census
    // (which skips rowless panes) can never reap it. An alive:1 residue on an
    // offline agent node must wait for the node to come back.
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    await seed({
      id,
      crossAgent: 1,
      parentSubshellId: parent,
      status: "terminated",
      alive: 1,
      endedAt: ago(40),
      nodeId: OFFLINE_AGENT,
    });

    const retired = await service.retireExpiredHelpers();
    expect(retired).toBe(0);
    expect((await subshellsRepo.findById(id))?.id).toBe(id);
  });

  it("skips a candidate that a manual restart currently owns", async () => {
    // Regression pin for the isRestartInFlight guard. A row the operator just
    // clicked Restart on sits in the process-wide lease (between taking it and
    // parking) while still shaped as a candidate; deleting it then would
    // silently cancel a deliberate user action. The predicate alone does not
    // cover this window, so removing the guard line must fail THIS test.
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 1, parentSubshellId: parent, status: "running", alive: 0, endedAt: ago(40) });
    setRestartLeaseForTests(id, true);
    try {
      const retired = await service.retireExpiredHelpers();
      expect(retired).toBe(0);
      expect((await subshellsRepo.findById(id))?.id).toBe(id);
    } finally {
      setRestartLeaseForTests(id, false);
    }
  });

  it("re-reads each row before deleting, sparing a transcript that turned kept mid-sweep", async () => {
    // Regression pin for review MINOR 1. listRetireableHelpers hands a snapshot;
    // if a candidate is terminated (becoming the kept `terminated, alive: 0`)
    // between being listed and deleted, deciding on the snapshot would eat a
    // history the guarantee says to keep. The sweep re-reads each row and
    // re-asserts the swept shape, so this candidate is spared. Removing either
    // the findById re-read or the isRetireableShape re-check makes the delete
    // fire and this test fail. Deterministic via dependency doubles (no race).
    const candidate = {
      id: crypto.randomUUID(),
      userId: OWNER,
      crossAgent: 1,
      status: "running",
      alive: 0,
      endedAt: ago(40),
      nodeId: LOCAL_NODE_ID,
    } as unknown as SubshellTable;
    // What the row looks like NOW: an agent terminated it (kept shape).
    const kept = { ...candidate, status: "terminated", alive: 0 } as unknown as SubshellTable;

    const deletes: string[] = [];
    const fakeManager = {
      isRestartInFlight: () => false,
      deleteSubshell: (_userId: string, id: string) => {
        deletes.push(id);
        return Promise.resolve(true);
      },
    } as unknown as SubshellManagerService;
    const fakeRepos = {
      subshells: {
        listRetireableHelpers: () => Promise.resolve([candidate]),
        findById: (id: string) => Promise.resolve(id === candidate.id ? kept : undefined),
      },
      subshellShares: { listForSubshells: () => Promise.resolve(new Map()) },
    } as unknown as Repositories;

    const svc = new SubshellsService({
      db: getRequestlessContext().db,
      log: getLogger(),
      repos: fakeRepos,
      manager: fakeManager,
    });
    const retired = await svc.retireExpiredHelpers();

    expect(retired).toBe(0);
    expect(deletes).toEqual([]); // the kept transcript was spared by the re-read
  });

  it("the grace is the exported policy constant, not a number in two places", () => {
    expect(HELPER_RETIRE_GRACE_MS).toBe(30 * 60_000);
  });
});

/**
 * The sweep's atomic claim (SubshellsRepository.deleteIfRetireable), the last
 * line against the residual TOCTOU: the sweep re-reads each row, but a
 * `terminate_subshell` can still land inside `deleteSubshell`'s own multi-await
 * teardown before the row delete. Deleting unconditionally there would eat the
 * just-kept transcript, so the row delete only fires while the row STILL
 * matches a swept shape.
 */
describe("deleteIfRetireable (atomic claim)", () => {
  it("spares a row that a terminate flipped to kept after the sweep listed it", async () => {
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 1, parentSubshellId: parent, status: "running", alive: 0, endedAt: ago(40) });
    // The race: a terminate lands now, moving the row to the kept
    // `terminated, alive: 0` shape (markTerminated leaves alive untouched at 0).
    await subshellsRepo.markTerminated(id, new Date().toISOString());

    const claimed = await subshellsRepo.deleteIfRetireable(id);
    expect(claimed).toBe(0);
    expect((await subshellsRepo.findById(id))?.status).toBe("terminated"); // transcript survives
  });

  it("deletes a row that still matches a swept shape", async () => {
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    await seed({ id, crossAgent: 1, parentSubshellId: parent, status: "running", alive: 0, endedAt: ago(40) });

    const claimed = await subshellsRepo.deleteIfRetireable(id);
    expect(claimed).toBe(1);
    expect(await subshellsRepo.findById(id)).toBeUndefined();
  });

  it("spares a row a revive brought back to life", async () => {
    const parent = await seedCreator();
    const id = crypto.randomUUID();
    // A live row is never a swept shape; the claim must not touch it even
    // though the sweep may have listed it moments before a revive completed.
    await seed({ id, crossAgent: 1, parentSubshellId: parent, status: "running", alive: 1 });

    const claimed = await subshellsRepo.deleteIfRetireable(id);
    expect(claimed).toBe(0);
    expect((await subshellsRepo.findById(id))?.id).toBe(id);
  });
});
