import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * GET /api/subshells/:id/log onto an OFFLINE agent node (spec §5.6): the tail
 * read rides the node's RemoteLauncher, which rejects `NodeRpcError("offline")`
 * — the service maps it with the established `rethrowUnlessNodeOffline` pattern
 * (create/restart precedent) onto the structured 409 NODE_OFFLINE. Unmapped,
 * every UI poll of the "why did it exit" tail would 500 AND log a server error
 * line, so the offline answer is pinned here at the HTTP surface.
 */

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

describe("GET /api/subshells/:id/log onto an offline node (spec §5.6)", () => {
  const pw = "logoff-pass-1";
  const email = `logoff-${crypto.randomUUID()}@subshell.local`;
  let userId: string;
  let cookie: string;
  const nodeId = crypto.randomUUID();
  const subshellId = crypto.randomUUID();

  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests(); // the node must have NO live connection
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    cookie = await signIn(email, pw);
    await new NodesRepository(db).create({ id: nodeId, ownerUserId: userId, name: `logoff-${nodeId}`, kind: "agent" });
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "logoff-row",
      workingDir: "/tmp",
      tmuxSocket: `logoff-sock-${subshellId}`,
      nodeId,
    });
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    await new NodesRepository(db).deleteById(nodeId);
    await deleteUserByEmailOrId(email);
  });

  it("answers the structured 409 NODE_OFFLINE — not a 500 the UI polls into the server log", async () => {
    const res = await app.fetch(authedRequest(`/api/subshells/${subshellId}/log`, cookie));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; statusCode: number; message: string };
    expect(body.code).toBe("NODE_OFFLINE");
    expect(body.statusCode).toBe(409);
    expect(body.message).toMatch(/node/i);
  });
});
