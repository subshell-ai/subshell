import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { nodesRoutes } from "@/api/nodes/index.js";
import { subshellRoutes } from "@/api/subshells/index.js";
/**
 * The transfer door's load-bearing invariant, enforced where it is actually
 * minted (security pass on #495, cold round): a pane token's system-permission
 * ceiling may arrive only from a credential the pane's OWNER holds. The route
 * note in `transfer-node.route.test.ts` states the invariant; this file drives
 * the real restart route with a THIRD-PARTY system key on a pane shared to it
 * (an Everyone `edit` row — the mainstream sharing act), which is the one
 * production path that used to bake the caller key's grants (including
 * `nodes:transfer`) into the human's re-minted token. The `restartSubshell`
 * service wrapper must pass the caller's grants only when the caller IS the
 * row's owner; a stranger's restart re-mints with no ceiling at all.
 *
 * Same cross-stack fixture as `restart-prompt.route.test.ts`: a scripted agent
 * answers the real RemoteLauncher, and the relaunched pane's freshly minted
 * token is read off the `launch` frame's `subshellEnv` — the same secret the
 * harness bakes, so the escalation is proven end to end, not inferred from
 * metadata.
 */
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getApiKeyMetadata } from "@/modules/auth/apikey-store.js";
import { getAuth } from "@/modules/auth/auth.js";
import { authDatabase } from "@/modules/auth/database.js";
import { systemKeyPermissions } from "@/modules/auth/system-key-permissions.js";
import { ensureSystemUser } from "@/modules/auth/system-user.js";
import { resetNodeRegistryForTests } from "@/modules/nodes/node-registry.js";
import { ensureLocalNode } from "@/modules/nodes/seed-local.js";
import { attachScriptedNode, restartLifecycleHandlers } from "@/testing/scripted-node.js";
import { seedPreset } from "@/testing/seed-preset.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes).use(nodesRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

describe("a stranger system key cannot arm a shared pane through restart", () => {
  const emails = {
    victim: `rci-victim-${crypto.randomUUID()}@subshell.local`,
    recipient: `rci-recipient-${crypto.randomUUID()}@subshell.local`,
  };
  const pw = "rci-pass-1";
  let victimId: string;
  let victimCookie: string;
  let recipientId: string;
  let systemUserId: string;

  let presetId: string;
  let paneNode: string;
  let transferNode: string;
  let attackerKey: string;
  const createdSubshellIds: string[] = [];
  const createdNodeIds: string[] = [];
  const createdKeyIds: string[] = [];

  /** Bearer POST helper (the attacker drives REST with the key directly). */
  async function bearerPost(path: string, key: string, body?: unknown) {
    return app.fetch(
      new Request(`http://localhost:3080${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    const users = new UsersRepository(db);
    victimId = await users.createUser({
      email: emails.victim,
      name: emails.victim,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    recipientId = await users.createUser({
      email: emails.recipient,
      name: emails.recipient,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    victimCookie = await signIn(emails.victim, pw);
    systemUserId = await ensureSystemUser();

    presetId = await seedPreset(new PresetsRepository(db), { userId: victimId, name: "rci-src" });
    paneNode = crypto.randomUUID();
    await nodes.create({
      id: paneNode,
      ownerUserId: victimId,
      name: `rci-pane-${paneNode.slice(0, 8)}`,
      kind: "agent",
    });
    await nodes.applyInventory(
      paneNode,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
    // A second machine owned by the victim: the escalation's target, kept
    // distinct from the pane's host so the transfer exercises the gate's
    // owner-equality on a plain keyed-less agent row.
    transferNode = crypto.randomUUID();
    await nodes.create({
      id: transferNode,
      ownerUserId: victimId,
      name: `rci-target-${transferNode.slice(0, 8)}`,
      kind: "agent",
      status: "offline",
    });
    createdNodeIds.push(paneNode, transferNode);

    // The automation profile this feature documents: a versioned key that may
    // drive panes AND hand over SYSTEM-owned machines. It must NEVER be able
    // to hand over a HUMAN's machine, directly or by arming one.
    const created = (await getAuth().api.createApiKey({
      body: {
        name: "rci-attacker",
        userId: systemUserId,
        metadata: { kind: "system", permissionVersion: 1, systemPermissions: ["subshells:execute", "nodes:transfer"] },
      },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    attackerKey = created.key;
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    for (const id of createdNodeIds) await nodes.deleteById(id);
    for (const id of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [id]);
    await db.deleteFrom("presets").where("id", "=", presetId).execute();
    for (const email of Object.values(emails)) await deleteUserByEmailOrId(email);
  });

  it("the re-minted token carries no attacker grant, and cannot transfer the victim's node", async () => {
    const sim = attachScriptedNode(paneNode, restartLifecycleHandlers(true));
    try {
      // Victim launches a pane on their own machine, then shares it with
      // Everyone at `edit` — the mainstream act that makes it drivable.
      const createRes = await app.fetch(
        new Request("http://localhost:3080/api/subshells", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `better-auth.session_token=${victimCookie}` },
          body: JSON.stringify({
            harnessId: "claude-code",
            presetId,
            workingDir: "/srv/work/rci",
            nodeId: paneNode,
            name: "rci-pane",
          }),
        }),
      );
      expect(createRes.status).toBe(200);
      const { id: paneId } = (await createRes.json()) as { id: string };
      createdSubshellIds.push(paneId);
      await shares.replaceForSubshell(paneId, [{ granteeUserId: null, permission: "edit" }], victimId);

      // The attacker's key restarts the shared pane. The gate resolves through
      // the Everyone row, so the restart is a legitimate 200 act.
      const restart = await bearerPost(`/api/subshells/${paneId}/restart`, attackerKey);
      expect(restart.status).toBe(200);

      // What the re-mint must NOT have done: graft the caller key's grants
      // onto the human's fresh token. A legacy (no-ceiling) human row restarted
      // by a stranger stays a legacy row.
      const row = await subshells.findById(paneId);
      expect(row?.apiKeyId).toBeTruthy();
      const ceiling = systemKeyPermissions(getApiKeyMetadata(row!.apiKeyId!) ?? null);
      expect(ceiling ?? []).not.toContain("nodes:transfer");

      // End to end: the very token baked into the relaunched pane must not
      // open the transfer door on the victim's other machine.
      const env = sim.cmdsOf("launch").at(-1)?.subshellEnv;
      const paneToken = env?.SUBSHELL_API_KEY;
      expect(paneToken).toBeDefined();
      const transfer = await bearerPost(`/api/nodes/${transferNode}/transfer`, paneToken!, {
        toUserId: recipientId,
        retainAccessAsManager: false,
      });
      expect(transfer.status).toBe(403);
      expect((await nodes.findById(transferNode))?.ownerUserId).toBe(victimId);
    } finally {
      sim.detach();
    }
  });
});
