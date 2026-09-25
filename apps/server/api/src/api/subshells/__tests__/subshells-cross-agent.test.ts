import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";

/**
 * The cross-agent provenance flag (operator ask 2026-09-25): a create that
 * arrives on a PANE'S OWN bearer token — the MCP `create_subshell` door — is
 * an agent opening a sibling to talk to, not a human starting a session. The
 * row is stamped `crossAgent` (written once, never rewritten), and its bell
 * defaults OFF: internal cross-agent chatter must not ring a human's devices,
 * and the owner can still turn the bell on from the pane's menu.
 *
 * The route's rule is `actor === "subshell-key"` — a system key is admin
 * automation and is NOT stamped, but the strict bearer rule (the system user
 * owns no agent node and no presets) refuses its launch onto one long before
 * any stamp, and a green local launch here would spawn real tmux (the leak
 * class apps/server/api/AGENTS.md records); the human/pane pair below are the
 * doors that can actually answer, and the third shares the human door's
 * value (`false`) by construction.
 */
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { seedPreset } from "@/services/__tests__/helpers/seed-preset.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok, statDirEcho } from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);

describe("POST /api/subshells: cross-agent provenance (2026-09-25)", () => {
  const ownerEmail = `xag-owner-${crypto.randomUUID()}@subshell.local`;
  const pw = "xag-pass-1";
  let ownerId: string;
  let ownerCookie: string;
  let presetId: string;
  let node: string;
  const createdIds: string[] = [];

  // The create pair, plus what a RESTART asks the machine: the kill of the
  // old tree before the revive, and the fresh spawn.
  const LIFECYCLE = { stat_dir: statDirEcho, launch: ok, kill: ok, input: ok };

  async function create(headers: Headers): Promise<Response> {
    return app.fetch(
      new Request("http://localhost:3080/api/subshells", {
        method: "POST",
        headers,
        body: JSON.stringify({
          harnessId: "claude-code",
          presetId,
          workingDir: "/srv/work/xag",
          nodeId: node,
          name: "xag-probe",
        }),
      }),
    );
  }

  const cookieHeaders = () =>
    new Headers({ "content-type": "application/json", cookie: `better-auth.session_token=${ownerCookie}` });

  /** Read back the two facts the flag decides, straight from the row. */
  async function rowFacts(id: string) {
    const row = await subshells.findById(id);
    return { crossAgent: row?.crossAgent, notify: row?.notify };
  }

  /** The GET view for the owner — the field the rail and the MCP read. */
  async function viewFacts(id: string) {
    const res = await app.fetch(new Request(`http://localhost:3080/api/subshells/${id}`, { headers: cookieHeaders() }));
    expect(res.status).toBe(200);
    return (await res.json()) as { crossAgent: boolean; notify: boolean };
  }

  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    const users = new UsersRepository(db);
    ownerId = await users.createUser({
      email: ownerEmail,
      name: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    presetId = await seedPreset(new PresetsRepository(db), { userId: ownerId, name: "xag-preset" });
    node = crypto.randomUUID();
    await nodes.create({ id: node, ownerUserId: ownerId, name: `xag-${node.slice(0, 8)}`, kind: "agent" });
    await nodes.applyInventory(
      node,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    await nodes.deleteById(node);
    await db.deleteFrom("presets").where("id", "=", presetId).execute();
    await deleteUserByEmailOrId(ownerEmail);
  });

  it("a cookie launch is human: crossAgent 0, bell on, and the view says so", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const res = await create(cookieHeaders());
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };
      createdIds.push(id);
      expect(await rowFacts(id)).toEqual({ crossAgent: 0, notify: 1 });
      expect(await viewFacts(id)).toMatchObject({ crossAgent: false, notify: true });
    } finally {
      sim.detach();
    }
  });

  it("a launch on a PANE'S OWN token is cross-agent: crossAgent 1, bell off", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      // The spawning pane needs a row and a token of its own first — a human
      // launch of the parent is the honest starting state.
      const parent = await create(cookieHeaders());
      expect(parent.status).toBe(200);
      const parentId = ((await parent.json()) as { id: string }).id;
      createdIds.push(parentId);
      const key = await issueSubshellToken(parentId, ownerId);

      const res = await create(new Headers({ "content-type": "application/json", authorization: `Bearer ${key}` }));
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };
      createdIds.push(id);
      // The stamp AND the silent default, in one read: this is the pair the
      // operator asked for (internal comms a human should not be rung for).
      expect(await rowFacts(id)).toEqual({ crossAgent: 1, notify: 0 });
      expect(await viewFacts(id)).toMatchObject({ crossAgent: true, notify: false });
    } finally {
      sim.detach();
    }
  });

  it("a restart of a cross-agent row keeps the stamp (it records how the pane was OPENED)", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const parent = await create(cookieHeaders());
      const parentId = ((await parent.json()) as { id: string }).id;
      createdIds.push(parentId);
      const key = await issueSubshellToken(parentId, ownerId);
      const res = await create(new Headers({ "content-type": "application/json", authorization: `Bearer ${key}` }));
      const id = ((await res.json()) as { id: string }).id;
      createdIds.push(id);

      const restarted = await app.fetch(
        new Request(`http://localhost:3080/api/subshells/${id}/restart`, {
          method: "POST",
          headers: cookieHeaders(),
        }),
      );
      expect(restarted.status).toBe(200);
      // Same row, same provenance: a restart is a respawn, not a re-opening.
      expect(await rowFacts(id)).toEqual({ crossAgent: 1, notify: 0 });
      // The bell default is a DEFAULT, not a latch: the owner can still ring
      // for a comms pane, and a restart must not undo their choice.
      await subshells.update(id, { notify: 1 });
      const again = await app.fetch(
        new Request(`http://localhost:3080/api/subshells/${id}/restart`, {
          method: "POST",
          headers: cookieHeaders(),
        }),
      );
      expect(again.status).toBe(200);
      expect(await rowFacts(id)).toEqual({ crossAgent: 1, notify: 1 });
    } finally {
      sim.detach();
    }
  });
});
