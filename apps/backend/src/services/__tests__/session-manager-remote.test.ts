import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as sessionNameLockedMigration from "@/db/migrations/0011-session-name-locked.js";
import * as sessionHarnessIdMigration from "@/db/migrations/0013-session-harness-id.js";
import * as sessionNotificationsMigration from "@/db/migrations/0014-session-notifications.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import type { Database } from "@/db/types/index.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { seedProfile } from "@/services/__tests__/helpers/seed-profile.js";
import type { LaunchPlan, NodeLauncher } from "@/services/nodes/node-launcher.js";
import {
  attachConnection,
  detachConnection,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import { SessionManagerService, type SessionTokenProvider } from "@/services/session-manager.service.js";

/**
 * Per-node launcher routing in the manager (spec §6.3/§6.6): createSession
 * resolves its launcher from the node id, agent rows get the pure remote MCP
 * plan + node-side `MOTE_DATA_DIR`, offline nodes throw the offline-flavored
 * error, and views stamp `nodeOffline` from the live-connection registry.
 * A scripted {@link FakeLauncher} stands in for every node (the constructor
 * launcher is the TEST override and wins for all nodes), while one describe
 * runs WITHOUT it to exercise the real RemoteLauncher's offline behavior.
 */

/** Records launches; everything else answers the way a healthy node would. */
class FakeLauncher implements NodeLauncher {
  readonly plans: LaunchPlan[] = [];
  readonly kills: string[] = [];
  revokes = 0;

  async validateWorkingDir(raw: string): Promise<string> {
    return raw;
  }
  async resolveBinary(): Promise<string | null> {
    return "/bin/stub";
  }
  async launch(plan: LaunchPlan): Promise<void> {
    this.plans.push(plan);
  }
  async terminate(): Promise<void> {}
  async killSession(_socket: string, id: string): Promise<void> {
    this.kills.push(id);
  }
  async hasSession(): Promise<boolean> {
    return true;
  }
  async paneExitCode(): Promise<number | null> {
    return null;
  }
  async paneTitle(): Promise<{ title: string; command: string } | null> {
    return null;
  }
  async capture(): Promise<string> {
    return "";
  }
  async resize(): Promise<void> {}
  async sendInput(): Promise<void> {}
  async pressEnter(): Promise<void> {}
  async deliverPrompt(): Promise<boolean> {
    return false;
  }
  logPath(id: string): string {
    return join(testDir, `${id}.log`);
  }
  async readLogTail(): Promise<{ lines: string[]; truncated: boolean }> {
    return { lines: [], truncated: false };
  }
  async readLog(): Promise<{ bytes: Uint8Array; next: number }> {
    return { bytes: new Uint8Array(0), next: 0 };
  }
  async tailStart(): Promise<() => void> {
    return () => {};
  }
  async canResume(): Promise<boolean> {
    return false;
  }
  async writeArtifact(id: string): Promise<string> {
    return id;
  }
  async removeArtifacts(): Promise<void> {}
}

const testDir = mkdtempSync(join(tmpdir(), "mote-rmgr-"));
let dbHandle: Kysely<Database>;
let profilesRepo: ProfilesRepository;
let sessionsRepo: SessionsRepository;
let profileId: string;
let _issued = 0;
const tokens: SessionTokenProvider = {
  issue: async () => {
    _issued++;
    return "mote_stub";
  },
  revoke: async () => {},
};

/** Put a node "online" with `ready` facts; returns the detach closure. */
function nodeOnline(nodeId: string, capabilities: string[]): () => void {
  const ws: NodeSocket = { send: () => {}, close: () => {} };
  const conn = attachConnection(nodeId, ws);
  conn.agent = {
    dataDir: "/node-data",
    capabilities,
    hostname: "rmgr",
    agentVersion: "1.0.0",
    executablePath: "/usr/bin/mote-agent",
  };
  return () => detachConnection(nodeId, ws);
}

beforeAll(async () => {
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
  profilesRepo = new ProfilesRepository(dbHandle);
  sessionsRepo = new SessionsRepository(dbHandle);
  profileId = await seedProfile(profilesRepo);
});

afterAll(async () => {
  resetNodeRegistryForTests();
  await dbHandle.destroy().catch(() => {});
  rmSync(testDir, { recursive: true, force: true });
});

describe("manager createSession on an agent node (test launcher wins for all nodes)", () => {
  it("routes the launch through the node's launcher, persists nodeId, ships the remote MCP plan + node MOTE_DATA_DIR", async () => {
    const fake = new FakeLauncher();
    const manager = new SessionManagerService({
      sessions: sessionsRepo,
      profiles: profilesRepo,
      launcher: fake,
      tokens,
      audit: async () => {},
    });
    const nodeId = "rmgr-node-a";
    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      const created = await manager.createSession({
        userId: "u1",
        profileId,
        workingDir: "/tmp",
        name: "remote-create",
        nodeId,
      });
      const row = await sessionsRepo.findById(created.id);
      expect(row?.nodeId).toBe(nodeId);

      expect(fake.plans).toHaveLength(1);
      const plan = fake.plans[0];
      // Pure plan: the config ships inline with the launch command — no local
      // file was written, and the path is composed from the node's own dataDir.
      expect(plan.mcpConfigPath).toBe(`/node-data/mcp/${created.id}.json`);
      expect(plan.mcp).toBeDefined();
      expect(plan.mcp?.fileContent).toContain("/usr/bin/mote-agent");
      expect(plan.mcp?.fileContent).toContain('"mcp"');
      // sessionMcpEnv bakes the BACKEND's SESSION_DATA_DIR — meaningless on
      // the node; the manager must override it with the agent's dataDir.
      expect(plan.moteEnv.MOTE_DATA_DIR).toBe("/node-data");
      expect(plan.moteEnv.MOTE_API_KEY).toBe("mote_stub");

      await sessionsRepo.delete(created.id);
    } finally {
      off();
    }
  });

  it('an agent without the "mcp" capability launches with NO registration at all', async () => {
    const fake = new FakeLauncher();
    const manager = new SessionManagerService({
      sessions: sessionsRepo,
      profiles: profilesRepo,
      launcher: fake,
      tokens,
      audit: async () => {},
    });
    const nodeId = "rmgr-node-b";
    const off = nodeOnline(nodeId, []);
    try {
      const created = await manager.createSession({ userId: "u1", profileId, workingDir: "/tmp", nodeId });
      expect(fake.plans).toHaveLength(1);
      expect(fake.plans[0].mcp).toBeUndefined();
      expect(fake.plans[0].mcpConfigPath).toBeUndefined();
      await sessionsRepo.delete(created.id);
    } finally {
      off();
    }
  });

  it("the node drops offline between resolution and compose → offline-flavored throw + full rollback (row terminated, launch never sent)", async () => {
    const fake = new FakeLauncher();
    const manager = new SessionManagerService({
      sessions: sessionsRepo,
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
      .createSession({ userId: "u1", profileId, workingDir: "/tmp", nodeId })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRpcError);
    expect((err as NodeRpcError).code).toBe("offline");
    expect(fake.plans).toHaveLength(0);
    const row = (await sessionsRepo.listByUser("u1")).find((r) => r.nodeId === nodeId);
    expect(row?.status).toBe("terminated");
  });
});

describe("manager restartSession on an offline agent row (real launcher path)", () => {
  it("revive throws the offline-flavored error and rolls the parked row back (mapping to 409 is the service's)", async () => {
    // NO injected launcher: the manager must resolve the real per-node
    // RemoteLauncher for row.nodeId, which answers with NodeRpcError("offline").
    const manager = new SessionManagerService({
      sessions: sessionsRepo,
      profiles: profilesRepo,
      tokens,
      audit: async () => {},
    });
    const nodeId = "rmgr-node-offline";
    const id = crypto.randomUUID();
    await sessionsRepo.create({
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
    const err = await manager.restartSession("u1", id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRpcError);
    expect((err as NodeRpcError).code).toBe("offline");
    // Parked row rolled back to terminated (unchanged rollback shape).
    const row = await sessionsRepo.findById(id);
    expect(row?.status).toBe("terminated");
  });
});

describe("nodeOffline on views (spec §5.6)", () => {
  it("agent rows carry nodeOffline while their node has no live connection; local rows never do", async () => {
    const fake = new FakeLauncher();
    const manager = new SessionManagerService({
      sessions: sessionsRepo,
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
      await sessionsRepo.create({
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

    const views = await manager.toViews(await sessionsRepo.listByUser("u1"));
    const byId = new Map(views.map((v) => [v.id, v]));
    expect(byId.get(localId)?.nodeOffline).toBe(false);
    expect(byId.get(agentId)?.nodeOffline).toBe(true);

    const off = nodeOnline(nodeId, ["mcp"]);
    try {
      const online = await manager.toViews(await sessionsRepo.listByUser("u1"));
      expect(new Map(online.map((v) => [v.id, v])).get(agentId)?.nodeOffline).toBe(false);
      const single = await manager.getSession("u1", agentId);
      expect(single?.nodeOffline).toBe(false);
    } finally {
      off();
    }
    const singleOffline = await manager.getSession("u1", agentId);
    expect(singleOffline?.nodeOffline).toBe(true);
  });
});
