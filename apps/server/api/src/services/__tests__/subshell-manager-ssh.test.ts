import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshConfigPath } from "@internal/pane-runtime";
import type { SshConnectionSnapshotWire } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { FakeNodeLauncher, nodeOnline } from "@/services/__tests__/helpers/node-fakes.js";
import { prepareLocalPlugins } from "@/services/nodes/local-plugins.js";
import { subshellSshConfigPath } from "@/services/nodes/subshell-paths.js";
import { EMPTY_PRESET } from "@/services/preset-definition.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";

/**
 * The manager's ssh launch plumbing (Task 7): what `createSubshell` does with
 * the ssh service's composed facts, and which row fact the delete sweep reads.
 *
 * The composition itself (`composeSshLaunch`) and its call from the HTTP
 * surface are pinned elsewhere (`ssh-launch.service.test.ts`,
 * `api/ssh/__tests__/ssh-routes.test.ts`). This file pins the three manager
 * promises: the `presetFlags` launch preset is a FRESH object (EMPTY_PRESET
 * is shared and frozen — a mutation there would leak ssh flags into every
 * later presetless launch), the composed ssh member and the merged pane env
 * reach the {@link LaunchPlan} untouched, and `subshells.ssh` (migration
 * 0048's JSON column) is the snapshot's home.
 *
 * The delete-path half pins the kind fact: `row.ssh !== null`, NOT
 * `row.harnessId === "ssh"` — a hand-built row that names the ssh harness
 * without a snapshot gets no config cleanup, and a snapshot on any harness
 * row gets it.
 */

const OWNER = "u-ssh-plumb";
const testDir = mkdtempSync(join(tmpdir(), "subshell-mgr-ssh-"));
let subshellsRepo: SubshellsRepository;
const created: string[] = [];

const SNAPSHOT: SshConnectionSnapshotWire = {
  alias: "work",
  host: "example.test",
  user: null,
  port: 22,
  identityFiles: [],
  certificateFiles: [],
  authAgentSocket: null,
  knownHostsFiles: [],
  hostKeyAlias: null,
  proxyJumps: [],
  proxyCommand: null,
  forwards: null,
  tunnels: null,
  localCommands: null,
  remoteCommand: null,
  sendEnv: null,
  setEnv: null,
  escapes: null,
};

/** A live socket so the AGENT branch of `#planMcp` has `ready` facts to read. */
function plumbOnline(): () => void {
  return nodeOnline("node-plumb");
}

function mkManager(): { manager: SubshellManagerService; launcher: FakeNodeLauncher } {
  const launcher = new FakeNodeLauncher(testDir);
  const manager = new SubshellManagerService({
    subshells: subshellsRepo,
    presets: new PresetsRepository(db),
    launcher,
    tokens: { issue: async () => "subshell_stub", revoke: async () => {} },
    audit: async () => {},
  });
  return { manager, launcher };
}

beforeAll(async () => {
  await runMigrations();
  await prepareLocalPlugins();
  subshellsRepo = new SubshellsRepository(db);
});

afterAll(async () => {
  for (const id of created) await subshellsRepo.delete(id).catch(() => {});
  rmSync(testDir, { recursive: true, force: true });
});

describe("createSubshell ssh plumbing", () => {
  it("threads the composed ssh member, the flag preset and the extra pane env into the LaunchPlan, and writes the snapshot column", async () => {
    const id = crypto.randomUUID();
    created.push(id);
    const { manager, launcher } = mkManager();
    const configPath = buildSshConfigPath("/home/plumb/.subshell", id);
    const flags = ["-F", configPath, "-p", "22", "--", "example.test"];
    const off = plumbOnline();
    const created_ = await manager.createSubshell({
      subshellId: id,
      userId: OWNER,
      harnessId: "ssh",
      presetId: null,
      workingDir: tmpdir(),
      nodeId: "node-plumb",
      ssh: { configPath, fileContent: "Host *\n", snapshot: SNAPSHOT },
      presetFlags: flags,
      extraPaneEnv: { SSH_AUTH_SOCK: "/run/user/501/sock" },
    });
    off();
    expect(created_.id).toBe(id); // the caller's pre-assigned id IS the row id

    const plan = launcher.plans[0];
    expect(plan?.ssh).toEqual({ configPath, fileContent: "Host *\n" }); // the snapshot itself stays off the wire member
    expect(plan?.preset.flags).toEqual(flags);
    expect(plan?.subshellEnv.SSH_AUTH_SOCK).toBe("/run/user/501/sock");
    // The SUBSHELL_* infrastructure env is still there — the ssh pane is a
    // token-holding row (decision 10), just with no MCP registration.
    expect(plan?.subshellEnv.SUBSHELL_ID).toBe(id);
    expect(plan?.mcp).toBeUndefined();

    const row = await subshellsRepo.findById(id);
    expect(JSON.parse(String(row?.ssh))).toEqual(SNAPSHOT);
    expect(row?.harnessId).toBe("ssh");
  });

  it("the flag preset is a fresh object — EMPTY_PRESET is shared and must stay flagless", async () => {
    expect(EMPTY_PRESET.flags).toEqual([]); // frozen, and still empty
    const id = crypto.randomUUID();
    created.push(id);
    const { manager, launcher } = mkManager();
    const off = plumbOnline();
    await manager.createSubshell({
      subshellId: id,
      userId: OWNER,
      harnessId: "ssh",
      presetId: null,
      workingDir: tmpdir(),
      nodeId: "node-plumb",
      ssh: { configPath: buildSshConfigPath("/d", id), fileContent: "x\n", snapshot: SNAPSHOT },
      presetFlags: ["-F", "/d/ssh/x/config", "--", "h"],
    });
    off();
    expect(EMPTY_PRESET.flags).toEqual([]); // untouched by the compose above
    expect(launcher.plans[0]?.preset).not.toBe(EMPTY_PRESET);
  });

  it("an ordinary launch grows nothing: no ssh member, no SSH_AUTH_SOCK, NULL snapshot", async () => {
    const id = crypto.randomUUID();
    created.push(id);
    const { manager, launcher } = mkManager();
    await manager.createSubshell({
      subshellId: id,
      userId: OWNER,
      harnessId: "terminal",
      presetId: null,
      workingDir: tmpdir(),
    });
    const plan = launcher.plans[0];
    expect(plan?.ssh).toBeUndefined();
    expect(plan?.subshellEnv.SSH_AUTH_SOCK).toBeUndefined();
    const row = await subshellsRepo.findById(id);
    expect(row?.ssh).toBeNull(); // the column is the kind fact: NULL = not an ssh pane
  });

  it("a null agent socket adds no SSH_AUTH_SOCK (only a named socket rides)", async () => {
    const id = crypto.randomUUID();
    created.push(id);
    const { manager, launcher } = mkManager();
    const off = plumbOnline();
    await manager.createSubshell({
      subshellId: id,
      userId: OWNER,
      harnessId: "ssh",
      presetId: null,
      workingDir: tmpdir(),
      nodeId: "node-plumb",
      ssh: { configPath: buildSshConfigPath("/d", id), fileContent: "x\n", snapshot: SNAPSHOT },
      presetFlags: ["--", "h"],
    });
    off();
    expect(launcher.plans[0]?.subshellEnv.SSH_AUTH_SOCK).toBeUndefined();
  });
});

describe("deleteSubshell reads the row's ssh COLUMN as the kind fact", () => {
  it("a LOCAL row with a snapshot gets the config path removed — whatever its harness id claims", async () => {
    const id = crypto.randomUUID();
    created.push(id);
    await subshellsRepo.create({
      id,
      userId: OWNER,
      // NOT "ssh": the column, not the id, says the pane owned a config.
      harnessId: "terminal",
      name: "snapshot row",
      workingDir: tmpdir(),
      tmuxSocket: null,
      status: "terminated",
      alive: 0,
      nodeId: LOCAL_NODE_ID,
      ssh: JSON.stringify(SNAPSHOT),
    });
    const { manager, launcher } = mkManager();
    expect(await manager.deleteSubshell(OWNER, id)).toBe(true);
    expect(launcher.removedPaths.at(-1)).toEqual([launcher.logPath(id), subshellSshConfigPath(id)]);
  });

  it("an AGENT row with a snapshot passes the kind flag through subshellArtifacts", async () => {
    const nodeId = "node-ssh-del";
    const off = nodeOnline(nodeId, []);
    const id = crypto.randomUUID();
    created.push(id);
    await subshellsRepo.create({
      id,
      userId: OWNER,
      harnessId: "ssh",
      name: "remote ssh pane",
      workingDir: tmpdir(),
      tmuxSocket: "subshell-x",
      status: "terminated",
      alive: 0,
      nodeId,
      ssh: JSON.stringify(SNAPSHOT),
    });
    const { manager, launcher } = mkManager();
    expect(await manager.deleteSubshell(OWNER, id)).toBe(true);
    // The ssh config rides the triple at the node-derived path (fake mirrors
    // RemoteLauncher's composition from its `/node-data` facts).
    expect(launcher.removedPaths.at(-1)).toEqual([
      launcher.logPath(id),
      `/node-data/mcp/${id}.json`,
      `/node-data/subshells/${id}.meta.json`,
      buildSshConfigPath("/node-data", id),
    ]);
    off();
  });

  it("a row that merely NAMES the ssh harness but holds no snapshot is not an ssh pane (the re-point's negative arm)", async () => {
    const id = crypto.randomUUID();
    created.push(id);
    await subshellsRepo.create({
      id,
      userId: OWNER,
      harnessId: "ssh",
      name: "harness-only row",
      workingDir: tmpdir(),
      tmuxSocket: null,
      status: "terminated",
      alive: 0,
      nodeId: LOCAL_NODE_ID,
      ssh: null,
    });
    const { manager, launcher } = mkManager();
    expect(await manager.deleteSubshell(OWNER, id)).toBe(true);
    expect(launcher.removedPaths.at(-1)).toEqual([launcher.logPath(id)]); // no config path
  });
});
