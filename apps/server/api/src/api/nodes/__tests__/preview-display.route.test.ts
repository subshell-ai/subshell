import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { previewDisplayReadiness } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { ensureLocalNode } from "@/modules/nodes/seed-local.js";
import { issueSubshellToken } from "@/modules/subshells/tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

describe("virtual display preflight route", () => {
  const email = `display-${crypto.randomUUID()}@test.test`;
  const password = "display-readiness-test";
  const nodeId = crypto.randomUUID();
  let cookie: string;
  let bearer: string;
  /** A non-admin pane token: the invisibility case the admin boost would mask. */
  let foreignBearer: string;
  const sid = crypto.randomUUID();
  const foreignSid = crypto.randomUUID();
  const foreignId = crypto.randomUUID();
  /** A foreign machine with no shares: only the admin boost reaches it. */
  const boostId = crypto.randomUUID();
  const foreignEmail = `foreign-${crypto.randomUUID()}@test.test`;
  beforeAll(async () => {
    await setupAuthTables();
    const owner = await new UsersRepository(db).createUser({
      email,
      name: "Display test",
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    cookie = await signIn(email, password);
    await new SubshellsRepository(db).create({
      id: sid,
      userId: owner,
      presetId: "p",
      harnessId: "terminal",
      name: "Probe",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    bearer = await issueSubshellToken(sid, owner);
    const foreignOwner = await new UsersRepository(db).createUser({
      email: foreignEmail,
      name: "Foreign",
      passwordHash: await hashPassword(password),
      role: "user",
    });
    await db
      .insertInto("nodes")
      .values({
        id: foreignId,
        ownerUserId: foreignOwner,
        name: "Shared foreign machine",
        kind: "agent",
        status: "offline",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never)
      .execute();
    await new NodeSharesRepository(db).replaceForNode(
      foreignId,
      [{ granteeUserId: owner, permission: "edit" }],
      foreignOwner,
    );

    await new SubshellsRepository(db).create({
      id: foreignSid,
      userId: foreignOwner,
      presetId: "p",
      harnessId: "terminal",
      name: "Foreign probe",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    foreignBearer = await issueSubshellToken(foreignSid, foreignOwner);

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
    await db
      .insertInto("nodes")
      .values({
        id: boostId,
        ownerUserId: foreignOwner,
        name: "Private foreign machine",
        kind: "agent",
        status: "offline",
        createdAt: now,
        updatedAt: now,
      } as never)
      .execute();
  });
  afterAll(async () => {
    await db.deleteFrom("nodes").where("id", "in", [nodeId, boostId]).execute();
    await db.deleteFrom("subshells").where("id", "in", [sid, foreignSid]).execute();
    await db.deleteFrom("nodes").where("id", "=", foreignId).execute();
    await deleteUserByEmailOrId(foreignEmail);
    await deleteUserByEmailOrId(email);
  });
  function get(id: string, authenticated = true) {
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${id}/display-readiness`, {
        headers: authenticated ? { cookie: `better-auth.session_token=${cookie}` } : {},
      }),
    );
  }
  function bearerGet(path: string) {
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${path}`, { headers: { authorization: `Bearer ${bearer}` } }),
    );
  }
  function foreignBearerGet(path: string) {
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes/${path}`, {
        headers: { authorization: `Bearer ${foreignBearer}` },
      }),
    );
  }
  it("resolves the preflight as the account does: owned, shared and local are probe-able", async () => {
    // A machine the account owns and a machine shared with it both reach the
    // probe and stop at the node's own offline answer, never at a gate 404.
    expect((await bearerGet(`${nodeId}/display-readiness`)).status).toBe(409);
    expect((await bearerGet(`${foreignId}/display-readiness`)).status).toBe(409);
    // The host answers from the plane's own runtime, as it does for the browser.
    const local = await bearerGet("local/display-readiness");
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual(await previewDisplayReadiness());
    expect((await bearerGet(`${crypto.randomUUID()}/display-readiness`)).status).toBe(404);
    // The admin boost reaches a private machine the non-admin list omits, so
    // this probe answers the node's own offline state rather than a gate 404.
    expect((await bearerGet(`${boostId}/display-readiness`)).status).toBe(409);
    // No boost for a non-admin: a private foreign row stays invisible (404,
    // never 403), while the account's own machine still reaches the probe.
    expect((await foreignBearerGet(`${nodeId}/display-readiness`)).status).toBe(404);
    expect((await foreignBearerGet(`${foreignId}/display-readiness`)).status).toBe(409);
  });
  it("doesn't widen management detail access", async () => {
    expect((await bearerGet(nodeId)).status).toBe(403);
  });
  it("requires authentication", async () => {
    expect((await get("local", false)).status).toBe(401);
  });
  it("checks the built-in host even before Preview is enabled", async () => {
    const response = await get("local");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await previewDisplayReadiness());
  });
  it("keeps missing nodes private", async () => {
    expect((await get(crypto.randomUUID())).status).toBe(404);
  });
  it("doesn't report an offline machine as ready", async () => {
    expect((await get(nodeId)).status).toBe(409);
  });
});
