import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sessionRoutes } from "@/api/sessions/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The phase-1 create-session nodeId contract (spec 2026-08-31 §3): `nodeId`
 * is accepted but only the local node launches. Omitted or "local" → today's
 * behavior verbatim; ANY other value → 409 NODE_LAUNCH_NOT_READY, thrown by
 * the route BEFORE profile/service work (the guard is the whole phase-1
 * contract — nothing else about the node is validated).
 */

const app = new Elysia().use(errorHandlerPlugin).use(sessionRoutes);

describe("POST /api/sessions nodeId guard (phase 1)", () => {
  const pw = "cnode-pass-1";
  const email = `cnode-${crypto.randomUUID()}@mote.local`;
  let userId: string;
  let cookie: string;
  let agentNodeId: string;
  const createdSessionIds: string[] = [];
  const createdNodeIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
    agentNodeId = crypto.randomUUID();
    await new NodesRepository(db).create({
      id: agentNodeId,
      ownerUserId: userId,
      name: `cnode-${agentNodeId}`,
      kind: "agent",
      status: "offline",
    });
    createdNodeIds.push(agentNodeId);
  });

  afterAll(async () => {
    for (const id of createdSessionIds) await db.deleteFrom("sessions").where("id", "=", id).execute();
    for (const id of createdNodeIds) await new NodesRepository(db).deleteById(id);
    await deleteUserByEmailOrId(email);
  });

  function post(body: Record<string, unknown>) {
    return app.fetch(
      new Request("http://localhost:3080/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${cookie}` },
        body: JSON.stringify(body),
      }),
    );
  }

  // A bogus profileId keeps the launch far away: the guard must be the ONLY
  // thing under test. Without it, create reaches the service and 404s on the
  // profile (unchanged behavior for local/omitted).
  const base = { profileId: "no-such-profile", workingDir: "/tmp" };

  it("omitted nodeId → unchanged behavior (404 Profile not found, NOT the 409 guard)", async () => {
    const res = await post(base);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toBe("Profile not found");
  });

  it('nodeId "local" → byte-identical to omitted (same 404 path)', async () => {
    const res = await post({ ...base, nodeId: "local" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toBe("Profile not found");
  });

  it("any other nodeId → 409 NODE_LAUNCH_NOT_READY with the phase-2 message, before profile validation", async () => {
    const res = await post({ ...base, nodeId: agentNodeId });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string; statusCode: number };
    expect(body.code).toBe("NODE_LAUNCH_NOT_READY");
    expect(body.message).toBe("Remote launch arrives in phase 2");
    expect(body.statusCode).toBe(409);
  });

  it("GET /api/sessions/:id echoes nodeId (row default is 'local')", async () => {
    const id = `s_cnode_${crypto.randomUUID().slice(0, 8)}`;
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "cnode-view",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    createdSessionIds.push(id);
    const res = await app.fetch(
      new Request(`http://localhost:3080/api/sessions/${id}`, {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { nodeId: string }).nodeId).toBe("local");
  });
});
