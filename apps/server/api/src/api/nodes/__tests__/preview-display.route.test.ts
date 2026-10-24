import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { previewDisplayReadiness } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

describe("virtual display preflight route", () => {
  const email = `display-${crypto.randomUUID()}@test.test`;
  const password = "display-readiness-test";
  const nodeId = crypto.randomUUID();
  let cookie: string;
  beforeAll(async () => {
    await setupAuthTables();
    const owner = await new UsersRepository(db).createUser({
      email,
      name: "Display test",
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    cookie = await signIn(email, password);
    await ensureLocalNode(db);
    const now = new Date().toISOString();
    await db
      .insertInto("nodes")
      .values({
        id: nodeId,
        ownerUserId: owner,
        name: "Offline machine",
        kind: "agent",
        status: "offline",
        createdAt: now,
        updatedAt: now,
      } as never)
      .execute();
  });
  afterAll(async () => {
    await db.deleteFrom("nodes").where("id", "=", nodeId).execute();
    await deleteUserByEmailOrId(email);
  });
  function get(id: string, authenticated = true) {
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${id}/preview-display`, {
        headers: authenticated ? { cookie: `better-auth.session_token=${cookie}` } : {},
      }),
    );
  }
  it("requires authentication", async () => {
    expect((await get("local", false)).status).toBe(401);
  });
  it("checks the built-in host even before Preview is enabled", async () => {
    const response = await get("local");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(previewDisplayReadiness());
  });
  it("keeps missing nodes private", async () => {
    expect((await get(crypto.randomUUID())).status).toBe(404);
  });
  it("doesn't report an offline machine as ready", async () => {
    expect((await get(nodeId)).status).toBe(409);
  });
});
