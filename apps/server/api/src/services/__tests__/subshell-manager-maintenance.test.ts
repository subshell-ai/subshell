import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendErrorCodes } from "@internal/backend-errors";
import { NODE_RESULT_MAINTENANCE } from "@internal/subshell-protocol";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as sessionNameLockedMigration from "@/db/migrations/0011-session-name-locked.js";
import * as sessionHarnessIdMigration from "@/db/migrations/0013-session-harness-id.js";
import * as sessionNotificationsMigration from "@/db/migrations/0014-session-notifications.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as presetsMigration from "@/db/migrations/0027-presets.js";
import * as pushUrgencyMigration from "@/db/migrations/0035-subshell-push-urgency.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { Database } from "@/db/types/index.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import { FakeNodeLauncher, nodeOnline } from "@/services/__tests__/helpers/node-fakes.js";
import { seedPreset } from "@/services/__tests__/helpers/seed-preset.js";
import type { LaunchPlan } from "@/services/nodes/node-launcher.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import type { NotifyKind } from "@/services/notify.service.js";
import { SubshellManagerService, type SubshellTokenProvider } from "@/services/subshell-manager.service.js";

/**
 * The manager's two maintenance-shaped guards (spec 2026-09-14 §5.1).
 *
 * Both are about the same hazard from opposite ends: a node that is refusing
 * work must not end up running a pane anyway. One closes the window a create
 * leaves open between writing its row and spawning (a bulk retire landing in
 * between would strand a live pane under a row nothing sweeps); the other
 * stops the auto-restart sweep from quietly respawning, minutes later, what
 * the window just stopped.
 *
 * TWO databases are in play, as in `subshell-manager-remote.test.ts`: this
 * file's private handle holds the subshell rows, while the NODE row is read
 * through the process-wide requestless context — the same split
 * `assertDirAllowed` already lives with.
 */

const testDir = mkdtempSync(join(tmpdir(), "subshell-maint-"));
let dbHandle: Kysely<Database>;
let presetsRepo: PresetsRepository;
let subshellsRepo: SubshellsRepository;
let presetId: string;
const sharedNodes = new NodesRepository(db);
const nodeIds: string[] = [];

const tokens: SubshellTokenProvider = {
  issue: async () => "subshell_stub",
  revoke: async () => {},
};

/** A launcher that runs `duringLaunch` once the pane is notionally up — the race. */
class RacingLauncher extends FakeNodeLauncher {
  constructor(
    dir: string,
    private readonly duringLaunch: (plan: LaunchPlan) => Promise<void>,
  ) {
    super(dir);
  }
  override async launch(plan: LaunchPlan): Promise<void> {
    await super.launch(plan);
    await this.duringLaunch(plan);
  }
}

function makeManager(
  launcher: FakeNodeLauncher,
  notify: (subshellId: string, kind: NotifyKind) => Promise<void> = async () => {},
): SubshellManagerService {
  return new SubshellManagerService({
    subshells: subshellsRepo,
    presets: presetsRepo,
    launcher,
    tokens,
    audit: async () => {},
    notify,
  });
}

/** A node row in the SHARED graph (what the guards read), in or out of a window. */
async function sharedNode(maintenance: boolean): Promise<string> {
  const id = `maint-${crypto.randomUUID()}`;
  nodeIds.push(id);
  await sharedNodes.create({ id, ownerUserId: "u1", name: id, kind: "agent", status: "online" });
  // Fresh inventory is what passes the per-node harness gate, which sits
  // AFTER the maintenance guard in `maybeAutoRestart`. Without it every case
  // here would defer for the harness reason and the guard under test would
  // never be the thing that answered.
  await sharedNodes.applyInventory(
    id,
    JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
  );
  if (maintenance) {
    await sharedNodes.setMaintenance(id, { on: true, changedAt: new Date().toISOString(), source: "plane" });
  }
  return id;
}

/** A LIVE row (`running`, `alive: 1`) opted into auto-restart — what a death arrives on. */
async function liveRow(nodeId: string): Promise<SubshellTable> {
  const id = crypto.randomUUID();
  await subshellsRepo.create({
    id,
    userId: "u1",
    presetId,
    harnessId: "claude-code",
    name: "live",
    workingDir: "/tmp",
    tmuxSocket: `/tmp/sock-${id}`,
    nodeId,
    alive: 1,
    restartOnExit: 1,
    startedAt: new Date().toISOString(),
    lastOutputAt: new Date().toISOString(),
  });
  return (await subshellsRepo.findById(id)) as SubshellTable;
}

/** A parked row (`running`, `alive: 0`) opted into auto-restart — what the sweep hands the guard. */
async function parkedRow(nodeId: string): Promise<SubshellTable> {
  const id = crypto.randomUUID();
  await subshellsRepo.create({
    id,
    userId: "u1",
    presetId,
    harnessId: "claude-code",
    name: "parked",
    workingDir: "/tmp",
    tmuxSocket: `/tmp/sock-${id}`,
    nodeId,
    alive: 0,
    restartOnExit: 1,
    startedAt: new Date().toISOString(),
    lastOutputAt: new Date().toISOString(),
  });
  return (await subshellsRepo.findById(id)) as SubshellTable;
}

beforeAll(async () => {
  // The guards read the process-wide graph, whose schema comes from the boot
  // migrator — the same reasoning `subshell-manager-remote.test.ts` records.
  await runMigrations();
  // Seeds the built-in plugin store, which is the instance half of the
  // harness gate (`enabledHarnessPlugins`); the node half is the inventory
  // stamped in `sharedNode`.
  await setupAuthTables();
  dbHandle = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(dbHandle);
  await operatorUxMigration.up(dbHandle);
  await remoteOpsMigration.up(dbHandle);
  await profileDefaultFlagMigration.up(dbHandle);
  await sessionNameLockedMigration.up(dbHandle);
  await sessionHarnessIdMigration.up(dbHandle);
  await sessionNotificationsMigration.up(dbHandle);
  await nodesMigration.up(dbHandle);
  await sharingMigration.up(dbHandle);
  await subshellRenameMigration.up(dbHandle);
  await presetsMigration.up(dbHandle);
  await pushUrgencyMigration.up(dbHandle); // last_push_urgency — #reviveRow clears it on revival (spec 2026-09-23)
  presetsRepo = new PresetsRepository(dbHandle);
  subshellsRepo = new SubshellsRepository(dbHandle);
  presetId = await seedPreset(presetsRepo);
});

afterAll(async () => {
  resetNodeRegistryForTests();
  for (const id of nodeIds) await sharedNodes.deleteById(id);
  await dbHandle.destroy().catch(() => {});
  rmSync(testDir, { recursive: true, force: true });
});

describe("createSubshell — the post-spawn re-read", () => {
  it("kills the pane and throws when the row was retired mid-launch", async () => {
    const nodeId = await sharedNode(false);
    // Exactly what a maintenance window does to a row that was already
    // `running` when it opened: retire it. Here it lands between the row
    // write and the manager's return.
    const fake = new RacingLauncher(testDir, async (plan) => {
      await subshellsRepo.markTerminated(plan.id, new Date().toISOString());
    });
    const manager = makeManager(fake);
    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      // A 409 rather than a 500: losing this race is a legitimate concurrent
      // act, and a caller told "internal server error" would report a bug
      // instead of retrying. The reason is deliberately unnamed — this path
      // cannot tell a maintenance flip from an ordinary terminate.
      const raced = await manager
        .createSubshell({ userId: "u1", harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId })
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect((raced as { code?: string }).code).toBe(BackendErrorCodes.SUBSHELL_STOPPED_WHILE_STARTING);
      expect((raced as { statusCode?: number }).statusCode).toBe(409);
      expect((raced as Error).message).toMatch(/stopped while it was starting/i);
      // Without the re-read this pane would still be alive, under a
      // `terminated` row the reconcile sweep never walks.
      expect(fake.kills).toHaveLength(1);
      expect((await subshellsRepo.findById(fake.kills[0]))?.status).toBe("terminated");
    } finally {
      off();
    }
  });

  it("returns normally when nothing retired the row", async () => {
    const nodeId = await sharedNode(false);
    const fake = new FakeNodeLauncher(testDir);
    const manager = makeManager(fake);
    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      const created = await manager.createSubshell({
        userId: "u1",
        harnessId: "claude-code",
        presetId,
        workingDir: "/tmp",
        nodeId,
      });
      expect(fake.kills).toEqual([]);
      expect((await subshellsRepo.findById(created.id))?.status).toBe("running");
      await subshellsRepo.delete(created.id);
    } finally {
      off();
    }
  });
});

describe("auto-restart while the node is in maintenance", () => {
  /** `maybeAutoRestart` is the sweep's own guard; the sweep calls it privately. */
  const attempt = (manager: SubshellManagerService, row: SubshellTable): Promise<boolean> =>
    (manager as unknown as { maybeAutoRestart(r: SubshellTable): Promise<boolean> }).maybeAutoRestart(row);

  it("defers rather than respawning what the window stopped", async () => {
    const nodeId = await sharedNode(true);
    const fake = new FakeNodeLauncher(testDir);
    const manager = makeManager(fake);
    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      expect(await attempt(manager, await parkedRow(nodeId))).toBe(false);
      // Nothing was launched — which is the whole point: a sweep firing here
      // would undo the stop silently, minutes later, on a machine somebody is
      // standing at.
      expect(fake.plans).toEqual([]);
    } finally {
      off();
    }
  });

  it("restarts again once the window ends — deferred, never given up on", async () => {
    const nodeId = await sharedNode(false);
    const fake = new FakeNodeLauncher(testDir);
    const manager = makeManager(fake);
    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      const row = await parkedRow(nodeId);
      expect(await attempt(manager, row)).toBe(true);
      expect(fake.plans).toHaveLength(1);
      expect((await subshellsRepo.findById(row.id))?.alive).toBe(1);
    } finally {
      off();
    }
  });
});

describe("a node refusing a launch", () => {
  it("propagates the agent's VERBATIM refusal, so the service boundary can map it", async () => {
    // The mapping is by `detail` equality against the wire constant — the
    // sentence `NodeRpcError` wraps it in is for a log line, not a decision.
    // If the manager rewrote or swallowed this the 409 would silently become
    // the 500 it used to be.
    const nodeId = await sharedNode(false);
    const fake = new FakeNodeLauncher(testDir);
    fake.launchError = new NodeRpcError(
      "failed",
      `node "${nodeId}" reported: ${NODE_RESULT_MAINTENANCE}`,
      nodeId,
      NODE_RESULT_MAINTENANCE,
    );
    const manager = makeManager(fake);
    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      const err = await manager
        .createSubshell({ userId: "u1", harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(NodeRpcError);
      expect((err as NodeRpcError).code).toBe("failed");
      expect((err as NodeRpcError).detail).toBe(NODE_RESULT_MAINTENANCE);
      // …and the row it had already written is rolled back, as for any other
      // spawn failure.
      expect(fake.kills).toHaveLength(1);
    } finally {
      off();
    }
  });
});

describe("the death push while the node is in maintenance", () => {
  /** Every `(subshellId, kind)` the manager fired, in order. */
  const recorder = (): { calls: [string, NotifyKind][]; notify: (id: string, kind: NotifyKind) => Promise<void> } => {
    const calls: [string, NotifyKind][] = [];
    return {
      calls,
      notify: async (id, kind) => {
        calls.push([id, kind]);
      },
    };
  };

  it("says `maintenance`, never the `crashed` that promises a restart", async () => {
    // The agent sends its `maintenance` event BEFORE the `exit` frames the
    // window causes (spec §4.3), so the flag is already on the row when the
    // death lands here. Reporting that death as a crash would promise an
    // auto-restart that the guard two lines below is at this very moment
    // refusing to make — and the node's own maintenance loop would then push
    // a SECOND time about the same subshell.
    const nodeId = await sharedNode(true);
    const fake = new FakeNodeLauncher(testDir);
    const sink = recorder();
    const manager = makeManager(fake, sink.notify);
    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      const row = await liveRow(nodeId);
      await manager.applyRemoteExit(nodeId, row.id, 0, new Date().toISOString());
      expect(sink.calls).toEqual([[row.id, "maintenance"]]);
    } finally {
      off();
    }
  });

  it("keeps the ordinary kinds on a node nobody took out of service", async () => {
    const nodeId = await sharedNode(false);
    const fake = new FakeNodeLauncher(testDir);
    const sink = recorder();
    const manager = makeManager(fake, sink.notify);
    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      const row = await liveRow(nodeId);
      await manager.applyRemoteExit(nodeId, row.id, 1, new Date().toISOString());
      // `crashed` is the honest word here for the reason it is the wrong one
      // above: the sweep WILL pick this parked row up and respawn it, and on
      // a node in maintenance the guard two describes up refuses to.
      expect(sink.calls).toEqual([[row.id, "crashed"]]);
    } finally {
      off();
    }
  });
});
