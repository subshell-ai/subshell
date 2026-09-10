import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
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
import { openSqliteDatabase } from "@/db/open-database.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { Database } from "@/db/types/index.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { FakeNodeLauncher, nodeOnline } from "@/services/__tests__/helpers/node-fakes.js";
import { seedProfile } from "@/services/__tests__/helpers/seed-profile.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import { SubshellManagerService, type SubshellTokenProvider } from "@/services/subshell-manager.service.js";

/**
 * Per-node launcher routing in the manager (spec §6.3/§6.6): createSubshell
 * resolves its launcher from the node id, agent rows get the pure remote MCP
 * plan + node-side `SUBSHELL_DATA_DIR`, offline nodes throw the offline-flavored
 * error, and views stamp `nodeOffline` from the live-connection registry.
 * A scripted {@link FakeNodeLauncher} stands in for every node (the
 * constructor launcher is the TEST override and wins for all nodes), while one
 * describe runs WITHOUT it to exercise the real RemoteLauncher's offline
 * behavior.
 */

const testDir = mkdtempSync(join(tmpdir(), "subshell-rmgr-"));
let dbHandle: Kysely<Database>;
let profilesRepo: ProfilesRepository;
let subshellsRepo: SubshellsRepository;
let profileId: string;
let _issued = 0;
const tokens: SubshellTokenProvider = {
  issue: async () => {
    _issued++;
    return "subshell_stub";
  },
  revoke: async () => {},
};

beforeAll(async () => {
  // TWO databases are in play and only one is this file's. The manager's
  // directory-allowlist check (`assertDirAllowed`) does not read the private
  // `:memory:` handle below; it goes through the process's requestless
  // context, i.e. the shared test-mode DB every non-request code path opens.
  // That graph's schema comes from the boot migrator, so the honest setup is
  // the boot migrator itself: journal-backed and idempotent, and exactly the
  // code the shipped server runs. Without this call the file's launch-path
  // tests passed only when some earlier test file had happened to migrate
  // the shared DB in the same process, green in the full suite, red in any
  // narrower run.
  await runMigrations();
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
  await sharingMigration.up(dbHandle); // 0019 renames session_shares
  await subshellRenameMigration.up(dbHandle); // renamed schema the code sees
  profilesRepo = new ProfilesRepository(dbHandle);
  subshellsRepo = new SubshellsRepository(dbHandle);
  profileId = await seedProfile(profilesRepo);
});

afterAll(async () => {
  resetNodeRegistryForTests();
  await dbHandle.destroy().catch(() => {});
  rmSync(testDir, { recursive: true, force: true });
});

describe("manager createSubshell on an agent node (test launcher wins for all nodes)", () => {
  it("routes the launch through the node's launcher, persists nodeId, ships the remote MCP plan + node SUBSHELL_DATA_DIR", async () => {
    const fake = new FakeNodeLauncher(testDir);
    const manager = new SubshellManagerService({
      subshells: subshellsRepo,
      profiles: profilesRepo,
      launcher: fake,
      tokens,
      audit: async () => {},
    });
    const nodeId = "rmgr-node-a";
    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      const created = await manager.createSubshell({
        userId: "u1",
        profileId,
        workingDir: "/tmp",
        name: "remote-create",
        nodeId,
      });
      const row = await subshellsRepo.findById(created.id);
      expect(row?.nodeId).toBe(nodeId);

      expect(fake.plans).toHaveLength(1);
      const plan = fake.plans[0];
      // Pure plan: the config ships inline with the launch command — no local
      // file was written, and the path is composed from the node's own dataDir.
      expect(plan.mcpConfigPath).toBe(`/node-data/mcp/${created.id}.json`);
      expect(plan.mcp).toBeDefined();
      expect(plan.mcp?.fileContent).toContain("/usr/bin/subshell");
      expect(plan.mcp?.fileContent).toContain('"mcp"');
      // subshellMcpEnv bakes the BACKEND's SUBSHELL_SERVER_DATA_DIR — meaningless on
      // the node; the manager must override it with the agent's dataDir.
      expect(plan.subshellEnv.SUBSHELL_DATA_DIR).toBe("/node-data");
      expect(plan.subshellEnv.SUBSHELL_API_KEY).toBe("subshell_stub");

      await subshellsRepo.delete(created.id);
    } finally {
      off();
    }
  });

  it('an agent without the "mcp" capability launches with NO registration at all', async () => {
    const fake = new FakeNodeLauncher(testDir);
    const manager = new SubshellManagerService({
      subshells: subshellsRepo,
      profiles: profilesRepo,
      launcher: fake,
      tokens,
      audit: async () => {},
    });
    const nodeId = "rmgr-node-b";
    const off = nodeOnline(nodeId, []);
    try {
      const created = await manager.createSubshell({ userId: "u1", profileId, workingDir: "/tmp", nodeId });
      expect(fake.plans).toHaveLength(1);
      expect(fake.plans[0].mcp).toBeUndefined();
      expect(fake.plans[0].mcpConfigPath).toBeUndefined();
      await subshellsRepo.delete(created.id);
    } finally {
      off();
    }
  });

  it("the node drops offline between resolution and compose → offline-flavored throw + full rollback (row terminated, launch never sent)", async () => {
    const fake = new FakeNodeLauncher(testDir);
    const manager = new SubshellManagerService({
      subshells: subshellsRepo,
      profiles: profilesRepo,
      launcher: fake,
      tokens,
      audit: async () => {},
    });
    const nodeId = "rmgr-node-c";
    // Class assertion, not the message text: the create-path offline throw here
    // is the manager's own #planMcp guard (`NodeRpcError("offline")`), the RPC
    // twin of the RemoteLauncher's NoLiveConnectionError.
    const err = await manager
      .createSubshell({ userId: "u1", profileId, workingDir: "/tmp", nodeId })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRpcError);
    expect((err as NodeRpcError).code).toBe("offline");
    expect(fake.plans).toHaveLength(0);
    const row = (await subshellsRepo.listByUser("u1")).find((r) => r.nodeId === nodeId);
    expect(row?.status).toBe("terminated");
  });
});

describe("manager restartSubshell on an offline agent row (real launcher path)", () => {
  it("revive throws the offline-flavored error and rolls the parked row back (mapping to 409 is the service's)", async () => {
    // NO injected launcher: the manager must resolve the real per-node
    // RemoteLauncher for row.nodeId, which answers with NodeRpcError("offline").
    const manager = new SubshellManagerService({
      subshells: subshellsRepo,
      profiles: profilesRepo,
      tokens,
      audit: async () => {},
    });
    const nodeId = "rmgr-node-offline";
    const id = crypto.randomUUID();
    await subshellsRepo.create({
      id,
      userId: "u1",
      profileId,
      harnessId: "claude-code",
      name: "parked-agent",
      workingDir: "/tmp",
      tmuxSocket: `sock-${id}`,
      nodeId,
      alive: 0,
      status: "running",
    });
    const err = await manager.restartSubshell("u1", id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRpcError);
    expect((err as NodeRpcError).code).toBe("offline");
    // Parked row rolled back to terminated (unchanged rollback shape).
    const row = await subshellsRepo.findById(id);
    expect(row?.status).toBe("terminated");
  });
});

describe("nodeOffline on views (spec §5.6)", () => {
  it("agent rows carry nodeOffline while their node has no live connection; local rows never do", async () => {
    const fake = new FakeNodeLauncher(testDir);
    const manager = new SubshellManagerService({
      subshells: subshellsRepo,
      profiles: profilesRepo,
      launcher: fake,
      tokens,
      audit: async () => {},
    });
    const nodeId = "rmgr-node-view";
    const localId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    for (const [id, node] of [
      [localId, LOCAL_NODE_ID],
      [agentId, nodeId],
    ] as const) {
      await subshellsRepo.create({
        id,
        userId: "u1",
        profileId,
        harnessId: "claude-code",
        name: `v-${id.slice(0, 4)}`,
        workingDir: "/tmp",
        tmuxSocket: `sock-${id}`,
        nodeId: node,
      });
    }

    const views = await manager.toViews(await subshellsRepo.listByUser("u1"));
    const byId = new Map(views.map((v) => [v.id, v]));
    expect(byId.get(localId)?.nodeOffline).toBe(false);
    expect(byId.get(agentId)?.nodeOffline).toBe(true);

    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      const online = await manager.toViews(await subshellsRepo.listByUser("u1"));
      expect(new Map(online.map((v) => [v.id, v])).get(agentId)?.nodeOffline).toBe(false);
      const single = await manager.getSubshell("u1", agentId);
      expect(single?.nodeOffline).toBe(false);
    } finally {
      off();
    }
    const singleOffline = await manager.getSubshell("u1", agentId);
    expect(singleOffline?.nodeOffline).toBe(true);
  });
});
