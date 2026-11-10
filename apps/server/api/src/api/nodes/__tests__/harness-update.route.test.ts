import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authDatabase } from "@/modules/auth/database.js";
import { issueSubshellToken } from "@/modules/subshells/tokens.js";
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
const adminEmail = `hu-admin-${crypto.randomUUID()}@subshell.local`;
let adminToken: string;
let bearerSubshellId = "";
let bearerKeyId: string | undefined;
let bearerKey = "";

/** POST the update route; a token authenticates, an omission does not. */
function post(nodeId: string, pluginId: string, token?: string) {
  const path = `/api/nodes/${nodeId}/harnesses/${pluginId}/update`;
  return app.fetch(
    token
      ? authedRequest(path, token, { method: "POST" })
      : new Request(`http://localhost:3080${path}`, { method: "POST" }),
  );
}

/** POST carrying a machine bearer instead of a browser cookie. */
function postBearer(nodeId: string, pluginId: string, key: string) {
  return app.fetch(
    new Request(`http://localhost:3080/api/nodes/${nodeId}/harnesses/${pluginId}/update`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    }),
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
  await new UsersRepository(db).createUser({
    email: adminEmail,
    name: adminEmail,
    passwordHash: await hashPassword(pw),
    role: "admin",
  });
  adminToken = await signIn(adminEmail, pw);
  bearerSubshellId = `hu_s_${crypto.randomUUID().slice(0, 8)}`;
  await new SubshellsRepository(db).create({
    id: bearerSubshellId,
    userId: ownerId,
    presetId: "p",
    harnessId: "claude-code",
    name: bearerSubshellId,
    workingDir: "/tmp",
    tmuxSocket: null,
  });
  bearerKey = await issueSubshellToken(bearerSubshellId, ownerId);
  bearerKeyId = (await new SubshellsRepository(db).findById(bearerSubshellId))?.apiKeyId ?? undefined;
  agentNode = crypto.randomUUID();
  // Offline on purpose: the projection is what the route demands before it
  // opens a stream, and a node with no socket cannot run the command.
  await nodes.create({ id: agentNode, ownerUserId: ownerId, name: "hu-node", kind: "agent", status: "offline" });
});

afterAll(async () => {
  if (bearerSubshellId) await db.deleteFrom("subshells").where("id", "=", bearerSubshellId).execute();
  if (bearerKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [bearerKeyId]);
  await nodes.deleteById(agentNode);
  await deleteUserByEmailOrId(ownerEmail);
  await deleteUserByEmailOrId(adminEmail);
});

describe("POST /api/nodes/:id/harnesses/:pluginId/update refusals", () => {
  it("refuses a caller with no session", async () => {
    const res = await post(agentNode, "claude-code");
    expect(res.status).toBe(401);
  });

  it("refuses a machine bearer: harness updates are browser sessions", async () => {
    // The same rule `/api/nodes/:id/update` carries: a key is a machine
    // credential, not a person pressing a button.
    const res = await postBearer(agentNode, "claude-code", bearerKey);
    expect(res.status).toBe(403);
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

describe("POST .../update on the control-plane host", () => {
  it("refuses a non-admin: the server's own shell line is an admin act", async () => {
    // The seeded local node gives Everyone/edit, so `nodeCanConfigure` alone
    // let any member run the installer line in the server process.
    const res = await post("local", "claude-code", ownerToken);
    expect(res.status).toBe(403);
  });

  it("lets an admin reach the local refusals", async () => {
    // `terminal` has no update path, so a 400 proves the admin passed the
    // local gate without starting a vendor command.
    const res = await post("local", "terminal", adminToken);
    expect(res.status).toBe(400);
  });
});
