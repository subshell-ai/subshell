import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

/**
 * The refusals BEFORE the body opens are what this pins: they cannot become a
 * stream frame, so each has to be a real status. The order matters too — an
 * unknown plugin or one with no update path is a caller-input answer (404/400)
 * whether or not the node is reachable, while a live socket is only demanded
 * once there is something to run. A successful run streams NDJSON; the local
 * runner and the per-node claim are covered by
 * `harness-update.service.test.ts`, and the card's fetch loop by its own
 * suite. This file never executes a vendor's installer.
 */

const pw = "harness-update-route-1";
const ownerEmail = `hu-owner-${crypto.randomUUID()}@subshell.local`;
const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
const nodes = new NodesRepository(db);
let ownerToken: string;
let agentNode: string;
let ownerId: string;

/** POST the update route; a token authenticates, an omission does not. */
function post(nodeId: string, pluginId: string, token?: string) {
  const path = `/api/nodes/${nodeId}/harnesses/${pluginId}/update`;
  return app.fetch(
    token
      ? authedRequest(path, token, { method: "POST" })
      : new Request(`http://localhost:3080${path}`, { method: "POST" }),
  );
}

beforeAll(async () => {
  await setupAuthTables();
  ownerId = await new UsersRepository(db).createUser({
    email: ownerEmail,
    name: ownerEmail,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  ownerToken = await signIn(ownerEmail, pw);
  agentNode = crypto.randomUUID();
  // Offline on purpose: the projection is what the route demands before it
  // opens a stream, and a node with no socket cannot run the command.
  await nodes.create({ id: agentNode, ownerUserId: ownerId, name: "hu-node", kind: "agent", status: "offline" });
});

afterAll(async () => {
  await nodes.deleteById(agentNode);
  await deleteUserByEmailOrId(ownerEmail);
});

describe("POST /api/nodes/:id/harnesses/:pluginId/update refusals", () => {
  it("refuses a caller with no session", async () => {
    const res = await post(agentNode, "claude-code");
    expect(res.status).toBe(401);
  });

  it("refuses an unknown plugin before asking whether the node is live", async () => {
    const res = await post(agentNode, "not-a-plugin", ownerToken);
    expect(res.status).toBe(404);
  });

  it("refuses a harness with no update path", async () => {
    // A plain shell drives no CLI; the manifest declares neither install nor
    // update, so there is nothing to run and the offline node is irrelevant.
    const res = await post(agentNode, "terminal", ownerToken);
    expect(res.status).toBe(400);
  });

  it("refuses a viewer grantee: updating a machine's tools is a configure act", async () => {
    const viewerEmail = `hu-viewer-${crypto.randomUUID()}@subshell.local`;
    const viewerId = await new UsersRepository(db).createUser({
      email: viewerEmail,
      name: viewerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    const shares = new NodeSharesRepository(db);
    await shares.replaceForNode(agentNode, [{ granteeUserId: viewerId, permission: "view" }], ownerId);
    try {
      const viewerToken = await signIn(viewerEmail, pw);
      const res = await post(agentNode, "claude-code", viewerToken);
      expect(res.status).toBe(403);
    } finally {
      await shares.replaceForNode(agentNode, [], ownerId);
      await deleteUserByEmailOrId(viewerEmail);
    }
  });

  it("refuses an offline node once a run is possible", async () => {
    const res = await post(agentNode, "claude-code", ownerToken);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "NODE_OFFLINE" });
  });
});
