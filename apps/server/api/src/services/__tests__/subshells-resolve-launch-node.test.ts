import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ApiError, BackendErrorCodes } from "@internal/backend-errors";
import { hashPassword } from "better-auth/crypto";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { attachConnection, detachConnection, resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { resolveLaunchNode } from "@/services/subshells.service.js";

/**
 * The §6.6 launch-node resolution matrix, asserted directly against
 * `resolveLaunchNode` (the HTTP half lives in `subshells-create-nodeid.test.ts`).
 * Dimensions: requested × share × online × machine-actor. Error
 * shapes are the contract: absent AND invisible ride the status-carrying 404
 * class (spec §2: 404-not-403 — a 403 here would be a node-id existence
 * oracle); 409 NODE_OFFLINE and 400 NODE_REQUIRED ride `ApiError`
 * (throwApiError).
 */

const deps = {
  nodes: new NodesRepository(db),
  shares: new NodeSharesRepository(db),
  userMeta: new UserMetaRepository(db),
};

const pw = "rl-pass-1";
let ownerId: string;
let otherId: string;
let adminId: string;
let systemId: string;
const emails: string[] = [];
const nodeIds: string[] = [];
/** Fake sockets attached for the online cases, keyed by node id, detached per test. */
function online(nodeId: string, capabilities = ["mcp"]): () => void {
  const ws = { send: () => {}, close: () => {} };
  const conn = attachConnection(nodeId, ws);
  conn.agent = { dataDir: "/node-data", capabilities, hostname: "h", agentVersion: "1.0.0" };
  return () => detachConnection(nodeId, ws);
}

async function mkUser(role: "admin" | "user"): Promise<string> {
  const email = `rl-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({ email, name: email, passwordHash: await hashPassword(pw), role });
}

async function mkNode(ownerUserId: string): Promise<string> {
  const id = crypto.randomUUID();
  nodeIds.push(id);
  await deps.nodes.create({ id, ownerUserId, name: `rl-${id}`, kind: "agent", status: "offline" });
  return id;
}

/** Run `fn`, returning the thrown error instead of failing (shape assertions). */
async function grab(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

const statusOf = (err: unknown): number | undefined => (err as { status?: number })?.status;
const apiErr = (err: unknown): ApiError => {
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
};

beforeAll(async () => {
  await setupAuthTables();
  ownerId = await mkUser("user");
  otherId = await mkUser("user");
  adminId = await mkUser("admin");
  systemId = await ensureSystemUser();
  await ensureLocalNode(db);
});

afterAll(async () => {
  resetNodeRegistryForTests();
  for (const id of nodeIds) await deps.nodes.deleteById(id);
  for (const email of emails) await deleteUserByEmailOrId(email);
});

describe("resolveLaunchNode — explicit nodeId (step 1)", () => {
  it("unknown id → 404 (the status-carrying class; absent and invisible never leak more)", async () => {
    const err = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: "no-such-node" }, deps),
    );
    expect(statusOf(err)).toBe(404);
  });

  it("foreign private node → 404 (access 'none' ⇔ invisible; never 403 — spec §2)", async () => {
    const node = await mkNode(otherId);
    const err = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node }, deps),
    );
    expect(statusOf(err)).toBe(404);
  });

  it("an Everyone VIEW grant launches (nodes rule: any share grants launch)", async () => {
    const node = await mkNode(otherId);
    await deps.shares.replaceForNode(node, [{ granteeUserId: null, permission: "view" }], otherId);
    const off = online(node);
    try {
      expect(await resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node }, deps)).toEqual({
        nodeId: node,
      });
    } finally {
      off();
      await deps.shares.replaceForNode(node, [], otherId);
    }
  });

  it("own agent with no live connection → 409 ApiError NODE_OFFLINE (doNotLog class)", async () => {
    const node = await mkNode(ownerId);
    const err = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node }, deps),
    );
    expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_OFFLINE);
    expect((err as ApiError).statusCode).toBe(409);
  });

  it("own agent, online → resolves", async () => {
    const node = await mkNode(ownerId);
    const off = online(node);
    try {
      expect(await resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node }, deps)).toEqual({
        nodeId: node,
      });
    } finally {
      off();
    }
  });

  it('explicit "local" as a browser actor → the seeded Everyone/edit grant', async () => {
    expect(
      await resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: LOCAL_NODE_ID }, deps),
    ).toEqual({ nodeId: LOCAL_NODE_ID });
  });

  it("admins hold instance-wide edit: a foreign private online node launches for them", async () => {
    const node = await mkNode(otherId);
    const off = online(node);
    try {
      expect(await resolveLaunchNode({ userId: adminId, machineActor: false, requestedNodeId: node }, deps)).toEqual({
        nodeId: node,
      });
    } finally {
      off();
    }
  });

  it("MACHINE actors get no admin boost and no shares: an admin user's bearer still 404s a foreign node", async () => {
    const node = await mkNode(otherId);
    const err = await grab(() =>
      resolveLaunchNode({ userId: adminId, machineActor: true, requestedNodeId: node }, deps),
    );
    expect(statusOf(err)).toBe(404);
  });

  it("MACHINE actor on local → 404 for a regular user; only local's OWNER (the system user) keeps it (leaked harness keys must not spawn control-plane subshells)", async () => {
    const denied = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: true, requestedNodeId: LOCAL_NODE_ID }, deps),
    );
    expect(statusOf(denied)).toBe(404);
    expect(
      await resolveLaunchNode({ userId: systemId, machineActor: true, requestedNodeId: LOCAL_NODE_ID }, deps),
    ).toEqual({ nodeId: LOCAL_NODE_ID });
  });
});

/**
 * Maintenance is a property of the MACHINE, so it applies to every viewer of
 * every node (spec 2026-09-14 decision 1) and it is answered BEFORE liveness
 * and before the share reading — those two send a person to check a network
 * or to ask for a grant, and neither would change anything.
 */
describe("resolveLaunchNode — maintenance", () => {
  it("refuses the node's own OWNER with 409 NODE_IN_MAINTENANCE", async () => {
    const node = await mkNode(ownerId);
    await deps.nodes.setMaintenance(node, { on: true, changedAt: new Date().toISOString(), source: "plane" });
    const off = online(node);
    try {
      const err = await grab(() =>
        resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node }, deps),
      );
      expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_IN_MAINTENANCE);
      expect((err as ApiError).statusCode).toBe(409);
    } finally {
      off();
    }
  });

  it("refuses an ADMIN too — the instance-wide edit boost does not outrank a window", async () => {
    const node = await mkNode(otherId);
    await deps.nodes.setMaintenance(node, { on: true, changedAt: new Date().toISOString(), source: "plane" });
    const off = online(node);
    try {
      const err = await grab(() =>
        resolveLaunchNode({ userId: adminId, machineActor: false, requestedNodeId: node }, deps),
      );
      expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_IN_MAINTENANCE);
    } finally {
      off();
    }
  });

  it("answers maintenance BEFORE offline, so an unreachable machine says the actionable thing", async () => {
    const node = await mkNode(ownerId);
    await deps.nodes.setMaintenance(node, { on: true, changedAt: new Date().toISOString(), source: "plane" });
    // No live socket at all: without the ordering this would be NODE_OFFLINE,
    // sending the owner to check a network rather than to end the window.
    const err = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node }, deps),
    );
    expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_IN_MAINTENANCE);
  });

  it("keeps the 404 first: an INVISIBLE node in maintenance still says nothing about existing", async () => {
    const node = await mkNode(otherId);
    await deps.nodes.setMaintenance(node, { on: true, changedAt: new Date().toISOString(), source: "plane" });
    const err = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node }, deps),
    );
    expect(statusOf(err)).toBe(404);
  });

  it("launches again the moment the window ends", async () => {
    const node = await mkNode(ownerId);
    await deps.nodes.setMaintenance(node, { on: true, changedAt: new Date().toISOString(), source: "plane" });
    await deps.nodes.setMaintenance(node, { on: false, changedAt: new Date().toISOString(), source: "plane" });
    const off = online(node);
    try {
      expect(await resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node }, deps)).toEqual({
        nodeId: node,
      });
    } finally {
      off();
    }
  });

  it("`local` in maintenance refuses an explicit launch and SKIPS the implicit step", async () => {
    const before = await deps.nodes.findById(LOCAL_NODE_ID);
    await deps.nodes.setMaintenance(LOCAL_NODE_ID, {
      on: true,
      changedAt: new Date().toISOString(),
      source: "plane",
    });
    try {
      const explicit = await grab(() =>
        resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: LOCAL_NODE_ID }, deps),
      );
      expect(apiErr(explicit).code).toBe(BackendErrorCodes.NODE_IN_MAINTENANCE);
      // Step 2 declines silently and falls through to step 3, which has
      // nothing to offer — never a silent relocation, never the host itself.
      const implicit = await grab(() => resolveLaunchNode({ userId: ownerId, machineActor: false }, deps));
      expect(apiErr(implicit).code).toBe(BackendErrorCodes.NODE_REQUIRED);
    } finally {
      await deps.nodes.setMaintenance(LOCAL_NODE_ID, {
        on: before?.maintenance === 1,
        changedAt: before?.maintenanceAt ?? new Date().toISOString(),
        source: "plane",
      });
    }
  });
});

/**
 * The admin's `allow_server_subshells` off-switch (operator ask 2026-09-24),
 * shaped on purpose like the maintenance case above and different from it on
 * purpose: this refusal is a SETTINGS fact, not a window, so it carries the
 * same 403 shape the narrowed-host case uses rather than NODE_IN_MAINTENANCE.
 * The flag arrives as a plain option because the resolver is given the
 * setting the way it is given `machineActor` — pre-read, no DB in the rule.
 */
describe("resolveLaunchNode — server switched off as a node", () => {
  it("names `local` explicitly → 403 that names the settings, never shares", async () => {
    const err = await grab(() =>
      resolveLaunchNode(
        { userId: ownerId, machineActor: false, requestedNodeId: LOCAL_NODE_ID, serverAsNodeEnabled: false },
        deps,
      ),
    );
    expect(statusOf(err)).toBe(403);
    expect((err as { code?: string }).code).toBe("node_launch_disabled");
    // The existing 403 blames missing shares; this one must blame the switch,
    // or the reader goes to the sharing dialog and finds nothing to change.
    expect((err as Error).message).toMatch(/switched off/i);
    expect((err as Error).message).not.toMatch(/[Ss]hare/);
  });

  it("implicit launch SKIPS the host and falls to NODE_REQUIRED with nothing else", async () => {
    // Step 2 declines silently, exactly like the maintenance window does —
    // the caller named no node, and step 3 or NODE_REQUIRED answers.
    const err = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: false, serverAsNodeEnabled: false }, deps),
    );
    expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_REQUIRED);
  });

  it("the lone-online-agent auto-pick still answers with the host off", async () => {
    const node = await mkNode(ownerId);
    const off = online(node);
    try {
      expect(
        await resolveLaunchNode({ userId: ownerId, machineActor: false, serverAsNodeEnabled: false }, deps),
      ).toEqual({ nodeId: node });
    } finally {
      off();
    }
  });

  it("an explicit AGENT launch is untouched — the flag is about one machine", async () => {
    const node = await mkNode(ownerId);
    const off = online(node);
    try {
      expect(
        await resolveLaunchNode(
          { userId: ownerId, machineActor: false, requestedNodeId: node, serverAsNodeEnabled: false },
          deps,
        ),
      ).toEqual({ nodeId: node });
    } finally {
      off();
    }
  });

  it("an omitted flag keeps today's host answer — the default is ON", async () => {
    expect(await resolveLaunchNode({ userId: ownerId, machineActor: false }, deps)).toEqual({
      nodeId: LOCAL_NODE_ID,
    });
  });
});

describe("resolveLaunchNode — implicit local (step 2) and auto-pick (step 3)", () => {
  it("nothing requested + the local switch ON → local (today's behavior preserved)", async () => {
    expect(await resolveLaunchNode({ userId: ownerId, machineActor: false }, deps)).toEqual({
      nodeId: LOCAL_NODE_ID,
    });
  });

  it("local switch OFF + no online agents → 400 ApiError NODE_REQUIRED ('pick one')", async () => {
    await deps.shares.replaceForNode(LOCAL_NODE_ID, [], systemId);
    try {
      const err = await grab(() => resolveLaunchNode({ userId: ownerId, machineActor: false }, deps));
      expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_REQUIRED);
      expect((err as ApiError).statusCode).toBe(400);
      expect((err as Error).message).toMatch(/pick one/i);
    } finally {
      await deps.shares.replaceForNode(LOCAL_NODE_ID, [{ granteeUserId: null, permission: "edit" }], systemId);
    }
  });

  it("local switch OFF + exactly one online agent candidate → auto-picked", async () => {
    const node = await mkNode(ownerId);
    await deps.shares.replaceForNode(LOCAL_NODE_ID, [], systemId);
    const off = online(node);
    try {
      expect(await resolveLaunchNode({ userId: ownerId, machineActor: false }, deps)).toEqual({
        nodeId: node,
      });
    } finally {
      off();
      await deps.shares.replaceForNode(LOCAL_NODE_ID, [{ granteeUserId: null, permission: "edit" }], systemId);
    }
  });

  it("local switch OFF + TWO online candidates → still NODE_REQUIRED (spec's single-online auto-pick, read literally)", async () => {
    const a = await mkNode(ownerId);
    const b = await mkNode(ownerId);
    await deps.shares.replaceForNode(LOCAL_NODE_ID, [], systemId);
    const offA = online(a);
    const offB = online(b);
    try {
      const err = await grab(() => resolveLaunchNode({ userId: ownerId, machineActor: false }, deps));
      expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_REQUIRED);
      expect((err as Error).message).toMatch(/multiple/i);
    } finally {
      offA();
      offB();
      await deps.shares.replaceForNode(LOCAL_NODE_ID, [{ granteeUserId: null, permission: "edit" }], systemId);
    }
  });

  it("step 3 never auto-picks a node in maintenance, even as the only online one", async () => {
    // The dangerous case: an implicit launch silently relocating onto a
    // machine whose owner took it out of service. Step 3 never reaches
    // `nodeCanLaunchOn`, so the flag is filtered by hand there.
    const node = await mkNode(ownerId);
    await deps.nodes.setMaintenance(node, { on: true, changedAt: new Date().toISOString(), source: "plane" });
    await deps.shares.replaceForNode(LOCAL_NODE_ID, [], systemId);
    const off = online(node);
    try {
      const err = await grab(() => resolveLaunchNode({ userId: ownerId, machineActor: false }, deps));
      expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_REQUIRED);
    } finally {
      off();
      await deps.shares.replaceForNode(LOCAL_NODE_ID, [{ granteeUserId: null, permission: "edit" }], systemId);
    }
  });

  it("MACHINE candidates are listByOwner, not findAccessible: a shared online node is never auto-picked for a bearer", async () => {
    const sharedOnline = await mkNode(otherId);
    await deps.shares.replaceForNode(sharedOnline, [{ granteeUserId: null, permission: "edit" }], otherId);
    const off = online(sharedOnline);
    try {
      const err = await grab(() => resolveLaunchNode({ userId: ownerId, machineActor: true }, deps));
      expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_REQUIRED);
    } finally {
      off();
      await deps.shares.replaceForNode(sharedOnline, [], otherId);
    }
  });
});
