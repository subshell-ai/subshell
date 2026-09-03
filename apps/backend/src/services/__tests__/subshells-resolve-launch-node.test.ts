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
 * Dimensions: requested × pinned × share × online × machine-actor. Error
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
  return await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role });
}

async function mkAgent(ownerUserId: string): Promise<string> {
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

const unpin = { nodeId: null } as const;

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
      resolveLaunchNode(
        { userId: ownerId, machineActor: false, requestedNodeId: "no-such-node", profile: unpin },
        deps,
      ),
    );
    expect(statusOf(err)).toBe(404);
  });

  it("foreign private node → 404 (access 'none' ⇔ invisible; never 403 — spec §2)", async () => {
    const node = await mkAgent(otherId);
    const err = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node, profile: unpin }, deps),
    );
    expect(statusOf(err)).toBe(404);
  });

  it("an Everyone VIEW grant launches (nodes rule: any share grants launch)", async () => {
    const node = await mkAgent(otherId);
    await deps.shares.replaceForNode(node, [{ granteeUserId: null, permission: "view" }], otherId);
    const off = online(node);
    try {
      expect(
        await resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node, profile: unpin }, deps),
      ).toEqual({ nodeId: node });
    } finally {
      off();
      await deps.shares.replaceForNode(node, [], otherId);
    }
  });

  it("own agent with no live connection → 409 ApiError NODE_OFFLINE (doNotLog class)", async () => {
    const node = await mkAgent(ownerId);
    const err = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node, profile: unpin }, deps),
    );
    expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_OFFLINE);
    expect((err as ApiError).statusCode).toBe(409);
  });

  it("own agent, online → resolves", async () => {
    const node = await mkAgent(ownerId);
    const off = online(node);
    try {
      expect(
        await resolveLaunchNode({ userId: ownerId, machineActor: false, requestedNodeId: node, profile: unpin }, deps),
      ).toEqual({ nodeId: node });
    } finally {
      off();
    }
  });

  it('explicit "local" as a browser actor → the seeded Everyone/edit grant', async () => {
    expect(
      await resolveLaunchNode(
        { userId: ownerId, machineActor: false, requestedNodeId: LOCAL_NODE_ID, profile: unpin },
        deps,
      ),
    ).toEqual({ nodeId: LOCAL_NODE_ID });
  });

  it("admins hold instance-wide edit: a foreign private online node launches for them", async () => {
    const node = await mkAgent(otherId);
    const off = online(node);
    try {
      expect(
        await resolveLaunchNode({ userId: adminId, machineActor: false, requestedNodeId: node, profile: unpin }, deps),
      ).toEqual({ nodeId: node });
    } finally {
      off();
    }
  });

  it("MACHINE actors get no admin boost and no shares: an admin user's bearer still 404s a foreign node", async () => {
    const node = await mkAgent(otherId);
    const err = await grab(() =>
      resolveLaunchNode({ userId: adminId, machineActor: true, requestedNodeId: node, profile: unpin }, deps),
    );
    expect(statusOf(err)).toBe(404);
  });

  it("MACHINE actor on local → 404 for a regular user; only local's OWNER (the system user) keeps it (leaked harness keys must not spawn control-plane subshells)", async () => {
    const denied = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: true, requestedNodeId: LOCAL_NODE_ID, profile: unpin }, deps),
    );
    expect(statusOf(denied)).toBe(404);
    expect(
      await resolveLaunchNode(
        { userId: systemId, machineActor: true, requestedNodeId: LOCAL_NODE_ID, profile: unpin },
        deps,
      ),
    ).toEqual({ nodeId: LOCAL_NODE_ID });
  });
});

describe("resolveLaunchNode — profile pin (step 2)", () => {
  it("a pinned node that cannot launch ERRORS with the pin message — never silently relocates", async () => {
    const node = await mkAgent(ownerId);
    const err = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: false, profile: { nodeId: node } }, deps),
    );
    expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_OFFLINE);
    expect((err as Error).message).toContain("pinned");
  });

  it("pinned to a gone node → 404 with the pin message", async () => {
    const err = await grab(() =>
      resolveLaunchNode({ userId: ownerId, machineActor: false, profile: { nodeId: "deleted-node" } }, deps),
    );
    expect(statusOf(err)).toBe(404);
    expect((err as Error).message).toContain("pinned");
  });

  it("an explicit body nodeId outranks the pin", async () => {
    const pinned = await mkAgent(ownerId);
    const requested = await mkAgent(ownerId);
    const off = online(requested);
    try {
      expect(
        await resolveLaunchNode(
          { userId: ownerId, machineActor: false, requestedNodeId: requested, profile: { nodeId: pinned } },
          deps,
        ),
      ).toEqual({ nodeId: requested });
    } finally {
      off();
    }
  });

  it("a launchable pin is honored when no node was requested", async () => {
    const node = await mkAgent(ownerId);
    const off = online(node);
    try {
      expect(
        await resolveLaunchNode({ userId: ownerId, machineActor: false, profile: { nodeId: node } }, deps),
      ).toEqual({ nodeId: node });
    } finally {
      off();
    }
  });
});

describe("resolveLaunchNode — implicit local (step 3) and auto-pick (step 4)", () => {
  it("nothing requested/pinned + the local switch ON → local (today's behavior preserved)", async () => {
    expect(await resolveLaunchNode({ userId: ownerId, machineActor: false, profile: unpin }, deps)).toEqual({
      nodeId: LOCAL_NODE_ID,
    });
  });

  it("local switch OFF + no online agents → 400 ApiError NODE_REQUIRED ('pick one')", async () => {
    await deps.shares.replaceForNode(LOCAL_NODE_ID, [], systemId);
    try {
      const err = await grab(() => resolveLaunchNode({ userId: ownerId, machineActor: false, profile: unpin }, deps));
      expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_REQUIRED);
      expect((err as ApiError).statusCode).toBe(400);
      expect((err as Error).message).toMatch(/pick one/i);
    } finally {
      await deps.shares.replaceForNode(LOCAL_NODE_ID, [{ granteeUserId: null, permission: "edit" }], systemId);
    }
  });

  it("local switch OFF + exactly one online agent candidate → auto-picked", async () => {
    const node = await mkAgent(ownerId);
    await deps.shares.replaceForNode(LOCAL_NODE_ID, [], systemId);
    const off = online(node);
    try {
      expect(await resolveLaunchNode({ userId: ownerId, machineActor: false, profile: unpin }, deps)).toEqual({
        nodeId: node,
      });
    } finally {
      off();
      await deps.shares.replaceForNode(LOCAL_NODE_ID, [{ granteeUserId: null, permission: "edit" }], systemId);
    }
  });

  it("local switch OFF + TWO online candidates → still NODE_REQUIRED (spec's single-online auto-pick, read literally)", async () => {
    const a = await mkAgent(ownerId);
    const b = await mkAgent(ownerId);
    await deps.shares.replaceForNode(LOCAL_NODE_ID, [], systemId);
    const offA = online(a);
    const offB = online(b);
    try {
      const err = await grab(() => resolveLaunchNode({ userId: ownerId, machineActor: false, profile: unpin }, deps));
      expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_REQUIRED);
      expect((err as Error).message).toMatch(/multiple/i);
    } finally {
      offA();
      offB();
      await deps.shares.replaceForNode(LOCAL_NODE_ID, [{ granteeUserId: null, permission: "edit" }], systemId);
    }
  });

  it("MACHINE candidates are listByOwner, not findAccessible: a shared online node is never auto-picked for a bearer", async () => {
    const sharedOnline = await mkAgent(otherId);
    await deps.shares.replaceForNode(sharedOnline, [{ granteeUserId: null, permission: "edit" }], otherId);
    const off = online(sharedOnline);
    try {
      const err = await grab(() => resolveLaunchNode({ userId: ownerId, machineActor: true, profile: unpin }, deps));
      expect(apiErr(err).code).toBe(BackendErrorCodes.NODE_REQUIRED);
    } finally {
      off();
      await deps.shares.replaceForNode(sharedOnline, [], otherId);
    }
  });
});
