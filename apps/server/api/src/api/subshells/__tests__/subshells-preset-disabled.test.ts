import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { presetRoutes } from "@/api/presets.route.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getRequestlessContext } from "@/lib/context.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { FakeNodeLauncher } from "@/services/__tests__/helpers/node-fakes.js";
import { seedPreset } from "@/services/__tests__/helpers/seed-preset.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";
import { attachScriptedNode, ok, statDirEcho } from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * A disabled preset refuses launch (spec 2026-10-24). The refusal is asked at
 * every door that starts a pane: the create gate answers 409 naming the row
 * (a disabled preset EXISTS, so it is not the 404 of a missing one), the
 * restart gate refuses to revive or swap onto one before the manager can kill
 * anything, and the manager carries the same checks as the backstop for
 * direct calls and races.
 *
 * The wire contract is the create family's: the refusal's own code
 * (`preset_disabled`) rides the thrown error like `preset_harness_mismatch`
 * does, and the body's `code` is the one the global handler maps from the
 * status — 409 → EXISTS_ERROR, exactly as every sibling 409 on this route.
 * The service-level test below pins the thrown code itself.
 *
 * Runs like `subshells-cross-agent.test.ts`: a scripted node answers the
 * machine half, so the 200 and the restart legs prove the real create and
 * restart routes, and the refusal legs prove the gates fire BEFORE anything
 * reaches a machine (that create runs with no node attached at all).
 */

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes).use(presetRoutes);

const nodes = new NodesRepository(db);
const presets = new PresetsRepository(db);
const subshells = new SubshellsRepository(db);

/** The create pair plus what a restart asks the machine: the kill, then the spawn. */
const LIFECYCLE = { stat_dir: statDirEcho, launch: ok, kill: ok, input: ok };

describe("launching a disabled preset (spec 2026-10-24)", () => {
  const ownerEmail = `pd-owner-${crypto.randomUUID()}@subshell.local`;
  const pw = "pd-pass-1";
  let ownerId = "";
  let ownerCookie = "";
  let node = "";
  const createdSubshellIds: string[] = [];
  const presetIds: string[] = [];

  async function makePreset(name: string, enabled: 0 | 1): Promise<string> {
    const id = await seedPreset(presets, { userId: ownerId, harnessId: "claude-code", name, enabled });
    presetIds.push(id);
    return id;
  }

  async function createPane(headers: Headers, body: Record<string, unknown>): Promise<Response> {
    return app.fetch(
      new Request("http://localhost:3080/api/subshells", { method: "POST", headers, body: JSON.stringify(body) }),
    );
  }
  const cookieHeaders = () =>
    new Headers({ "content-type": "application/json", cookie: `better-auth.session_token=${ownerCookie}` });
  const patchPreset = (id: string, enabled: boolean) =>
    app.fetch(
      new Request(`http://localhost:3080/api/presets/${id}`, {
        method: "PATCH",
        headers: cookieHeaders(),
        body: JSON.stringify({ enabled }),
      }),
    );

  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    ownerId = await new UsersRepository(db).createUser({
      email: ownerEmail,
      name: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    node = crypto.randomUUID();
    await nodes.create({ id: node, ownerUserId: ownerId, name: `pd-${node.slice(0, 8)}`, kind: "agent" });
    await nodes.applyInventory(
      node,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    await nodes.deleteById(node);
    for (const id of presetIds) await db.deleteFrom("presets").where("id", "=", id).execute();
    await deleteUserByEmailOrId(ownerEmail);
  });

  it("refuses the launch while disabled, and the real PATCH frees the SAME create", async () => {
    const name = `pd-launch-${crypto.randomUUID().slice(0, 8)}`;
    const presetId = await makePreset(name, 0);
    // No scripted node is attached: the refusal is the plane's own, so it must
    // answer before the machine is ever asked. The create path checks the
    // preset before resolving any node, and an offline machine would not
    // change this answer.
    const refused = await createPane(cookieHeaders(), {
      harnessId: "claude-code",
      presetId,
      workingDir: "/srv/work/pd",
      nodeId: node,
    });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { code: string; message: string };
    expect(body.message).toBe(`Preset "${name}" is disabled`);
    // The family contract: the thrown code is internal (see the service test),
    // the wire code is what the handler maps from 409 — same as the lockdown
    // and harness-shape 409s on this route.
    expect(body.code).toBe("EXISTS_ERROR");

    expect((await patchPreset(presetId, true)).status).toBe(200);
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const launched = await createPane(cookieHeaders(), {
        harnessId: "claude-code",
        presetId,
        workingDir: "/srv/work/pd",
        nodeId: node,
      });
      expect(launched.status).toBe(200);
      const { id } = (await launched.json()) as { id: string };
      createdSubshellIds.push(id);
      expect((await subshells.findById(id))?.presetId).toBe(presetId);
    } finally {
      sim.detach();
    }
  });

  it("the thrown refusal carries the coded preset_disabled, like its siblings carry theirs", async () => {
    const presetId = await makePreset(`pd-code-${crypto.randomUUID().slice(0, 8)}`, 0);
    const service = getRequestlessContext().services.subshells;
    const err = (await service
      .createSubshell({
        userId: ownerId,
        harnessId: "claude-code",
        presetId,
        workingDir: "/srv/work/pd",
        machineActor: false,
        crossAgent: false,
      })
      .catch((thrown: unknown) => thrown)) as { code?: string; status?: number };
    expect(err.code).toBe("preset_disabled");
    expect(err.status).toBe(409);
  });

  it("a restart refuses a preset disabled since launch: the live pane and the row are untouched", async () => {
    const name = `pd-restart-${crypto.randomUUID().slice(0, 8)}`;
    const presetId = await makePreset(name, 1);
    const otherName = `pd-swap-${crypto.randomUUID().slice(0, 8)}`;
    const otherId = await makePreset(otherName, 0);
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const launched = await createPane(cookieHeaders(), {
        harnessId: "claude-code",
        presetId,
        workingDir: "/srv/work/pd",
        nodeId: node,
      });
      expect(launched.status).toBe(200);
      const { id } = (await launched.json()) as { id: string };
      createdSubshellIds.push(id);

      expect((await patchPreset(presetId, false)).status).toBe(200);
      const refused = await app.fetch(
        new Request(`http://localhost:3080/api/subshells/${id}/restart`, { method: "POST", headers: cookieHeaders() }),
      );
      expect(refused.status).toBe(409);
      // NAME-FREE like every other restart-path refusal: an edit grantee can
      // restart a pane whose owner's preset they cannot see, so the refusal
      // says what to fix without disclosing which row it is.
      expect(((await refused.json()) as { message: string }).message).toBe(
        "Preset is disabled. Re-enable it in the dashboard before restarting this subshell.",
      );
      const row = await subshells.findById(id);
      expect(row?.alive).toBe(1);
      expect(row?.presetId).toBe(presetId);

      // Swapping ONTO a disabled preset is refused the same way, and the swap
      // writes nothing: the row keeps the preset it had (spec 2026-09-23 §2
      // ordering — the refusal stays on this side of the manager).
      const swapped = await app.fetch(
        new Request(`http://localhost:3080/api/subshells/${id}/restart`, {
          method: "POST",
          headers: cookieHeaders(),
          body: JSON.stringify({ presetId: otherId }),
        }),
      );
      expect(swapped.status).toBe(409);
      expect(((await swapped.json()) as { message: string }).message).toContain("is disabled");
      expect((await subshells.findById(id))?.presetId).toBe(presetId);
    } finally {
      await patchPreset(presetId, true);
      sim.detach();
    }
  });

  it("the manager's own backstop refuses a restart onto a disabled preset before any kill", async () => {
    // Direct manager calls skip the service gate, so the manager carries the
    // same check (the sibling of its access-removal throw). A terminal preset
    // + FakeNodeLauncher keeps this off every real machine, as in
    // `preset-sharing.test.ts`.
    const terminalPreset = await seedPreset(presets, {
      userId: ownerId,
      harnessId: "terminal",
      name: `pd-mgr-${crypto.randomUUID().slice(0, 8)}`,
    });
    presetIds.push(terminalPreset);
    const launcher = new FakeNodeLauncher("/tmp");
    const manager = new SubshellManagerService({
      subshells,
      presets,
      launcher,
      tokens: { issue: async () => "test-key", revoke: async () => {} },
      audit: async () => {},
      notify: async () => {},
    });
    const created = await manager.createSubshell({
      userId: ownerId,
      harnessId: "terminal",
      presetId: terminalPreset,
      workingDir: "/tmp",
    });
    try {
      await presets.update(terminalPreset, { enabled: 0 });
      const plain = await manager.restartSubshell(ownerId, created.id).catch((thrown: unknown) => thrown);
      expect(plain).toBeInstanceOf(Error);
      expect((plain as Error).message).toBe(
        "Preset is disabled. Re-enable it in the dashboard before restarting this subshell.",
      );
      const swap = await manager
        .restartSubshell(ownerId, created.id, terminalPreset)
        .catch((thrown: unknown) => thrown);
      expect((swap as Error).message).toContain("Preset is disabled");
      // The refusal lands before the kill: the restart never stopped the pane.
      expect(launcher.kills).toHaveLength(0);
      expect(launcher.plans).toHaveLength(1);
    } finally {
      await subshells.delete(created.id);
    }
  });
});
