import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SshPresetsRepository } from "@/db/repositories/ssh-presets.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { SshPresetTable } from "@/db/types/ssh-presets.db-types.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { saveSshPreset } from "@/services/ssh-presets.service.js";
import { attachScriptedNode } from "@/test-helpers/scripted-node.js";

/**
 * The `enabled` switch (0062) through `saveSshPreset`: a created preset is
 * offered (1), and a later save that says nothing about `enabled` keeps what
 * is stored rather than silently re-enabling a disabled preset. The scripted
 * node answers the create's resolve exactly as the shipped agent would; the
 * update cases reuse the stored destination, which skips re-resolution.
 */

const NODE = `n-enabled-${crypto.randomUUID().slice(0, 8)}`;
const CANON = "example.test:22";
let userId: string;
let nodeId: string;
const created = new Set<string>();

const nodes = new NodesRepository(db);
const ssh = new SshPresetsRepository(db);

function body(name: string, destination = "work") {
  return {
    name,
    nodeId,
    destination,
    authentication: "connecting" as const,
    fingerprints: [],
  };
}

beforeAll(async () => {
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email: `ssh-enabled-${crypto.randomUUID()}@example.test`,
    name: "SSH enable tester",
    passwordHash: await hashPassword("Ssh-enabled-test-2026!"),
    role: "user",
  });
  await nodes.create({ id: NODE, ownerUserId: userId, name: NODE, kind: "agent", status: "offline" });
  await nodes.setSshEnabled(NODE, { on: true, changedAt: new Date().toISOString() });
  nodeId = NODE;
  attachScriptedNode(NODE, {
    ssh_resolve_config: (cmd) =>
      cmd.type === "ssh_resolve_config" && cmd.alias === "work"
        ? {
            accepted: true,
            snapshot: {
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
            },
          }
        : { accepted: false, code: "unknown_alias", settings: [] },
  });
});

afterAll(async () => {
  resetNodeRegistryForTests();
  for (const id of created) await ssh.delete(id);
  await db.deleteFrom("nodes").where("id", "=", NODE).execute();
  await deleteUserByEmailOrId(userId);
});

describe("saveSshPreset enabled switch", () => {
  it("creates an SSH preset offered (enabled = 1)", async () => {
    const saved = await saveSshPreset(userId, body("Fresh ssh"));
    expect(saved).not.toHaveProperty("refusal");
    const view = saved as { id: string; enabled: number };
    created.add(view.id);
    expect(view.enabled).toBe(1);
    const row = await ssh.findById(view.id);
    expect(row?.enabled).toBe(1);
  });

  it("keeps a stored disable across a later save that does not mention enabled", async () => {
    const first = (await saveSshPreset(userId, body("Keeps off"))) as { id: string; enabled: number };
    created.add(first.id);
    expect(first.enabled).toBe(1);
    // Disable it the way the future PATCH route will, then save something else.
    await ssh.update(first.id, { enabled: 0 });
    const stored = (await ssh.findById(first.id)) as SshPresetTable;
    const again = (await saveSshPreset(userId, body("Keeps off, edited", CANON), stored)) as {
      id: string;
      enabled: number;
    };
    expect(again.id).toBe(first.id);
    expect(again.enabled).toBe(0);
    expect((await ssh.findById(first.id))?.enabled).toBe(0);
  });
});
