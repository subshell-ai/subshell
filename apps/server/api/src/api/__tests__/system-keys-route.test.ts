import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { API_KEY_PERMISSIONS } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { exportJWK, generateKeyPair } from "jose";
import { authGuard, isIssuedCredential } from "@/api/auth-guard.js";
import { channelRoutes } from "@/api/channels/index.js";
import { nodesRoutes } from "@/api/nodes/index.js";
import { systemKeysRoutes } from "@/api/system-keys.route.js";
import { authDatabase } from "@/auth/database.js";
import { intersectSystemPermissions, systemKeyPermissions } from "@/auth/system-key-permissions.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { openApiPlugin } from "@/plugins/openapi.plugin.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { ALLOW_NODE_ENROLLMENT_KEY } from "@/services/registration-gate.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * Admin CRUD for system-wide API keys. The property that matters: the key
 * minted here is a real bearer credential that reaches the API (admin-gated
 * surfaces reject it, ordinary routes accept it), and revocation is immediate.
 */
describe("system keys route", () => {
  let adminId: string;
  let adminToken: string;
  let plainToken: string;
  const adminEmail = `sysk-admin-${crypto.randomUUID()}@subshell.local`;
  const userEmail = `sysk-user-${crypto.randomUUID()}@subshell.local`;
  const pw = "syskeys-pass-1";
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    adminId = await users.createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    await users.createUser({ email: userEmail, name: userEmail, passwordHash: await hashPassword(pw), role: "user" });
    adminToken = await signIn(adminEmail, pw);
    plainToken = await signIn(userEmail, pw);
  });

  afterAll(async () => {
    for (const kid of createdKeyIds) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    await db.deleteFrom("userMeta").where("userId", "=", adminId).execute();
    await deleteUserByEmailOrId(adminEmail);
    await deleteUserByEmailOrId(userEmail);
  });

  async function adminCall(path: string, init?: RequestInit) {
    const res = await systemKeysRoutes.fetch(authedRequest(path, adminToken, init));
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, body: body as any, text: res.ok ? "" : await res.text().catch(() => "") };
  }

  it("plain user cookie -> 403; anonymous -> 401", async () => {
    expect((await systemKeysRoutes.fetch(authedRequest("/api/system-keys", plainToken))).status).toBe(403);
    expect((await systemKeysRoutes.fetch(new Request("http://localhost:3080/api/system-keys"))).status).toBe(401);
  });

  it("admin creates a usable key, sees it listed (never the hash), and revokes it", async () => {
    const created = await adminCall("/api/system-keys", {
      method: "POST",
      body: JSON.stringify({ name: "lan", permissions: ["channels:read"] }),
    });
    expect(created.status).toBe(200);
    const key = created.body.key as string;
    const id = created.body.id as string;
    createdKeyIds.push(id);
    expect(key.startsWith("subshell_")).toBe(true);

    const listed = await adminCall("/api/system-keys");
    const row = (listed.body.keys as Record<string, unknown>[]).find((k) => k.id === id);
    expect(row).toMatchObject({ name: "lan", enabled: true, permissions: ["channels:read"], legacy: false });
    expect(JSON.stringify(listed.body)).not.toContain(key); // plaintext never resurfaces
    expect((row as { preview?: string }).preview).toBeTruthy(); // 6-char start is fine

    // The key authenticates as a bearer credential on ordinary routes…
    const asBearer = await channelRoutes.fetch(
      new Request("http://localhost:3080/api/channels", { headers: { authorization: `Bearer ${key}` } }),
    );
    expect(asBearer.status).toBe(200);
    // …but not on admin routes (cookie-admin only).
    expect(
      (
        await systemKeysRoutes.fetch(
          new Request("http://localhost:3080/api/system-keys", { headers: { authorization: `Bearer ${key}` } }),
        )
      ).status,
    ).toBe(403);

    // Disable -> bearer rejected; re-enable -> accepted; delete -> gone.
    expect(
      (await adminCall(`/api/system-keys/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status,
    ).toBe(200);
    expect(
      (
        await channelRoutes.fetch(
          new Request("http://localhost:3080/api/channels", { headers: { authorization: `Bearer ${key}` } }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await adminCall(`/api/system-keys/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) })).status,
    ).toBe(200);
    expect((await adminCall(`/api/system-keys/${id}`, { method: "DELETE" })).status).toBe(200);
    const after = await adminCall("/api/system-keys");
    expect((after.body.keys as { id: string }[]).some((k) => k.id === id)).toBe(false);
  });

  it("PATCH on an unknown key id -> 404; missing name -> 400 INPUT_VALIDATION_ERROR", async () => {
    expect(
      (
        await adminCall("/api/system-keys/does-not-exist", {
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(404);
    // Mounted with the global error handler (as in the real server), Elysia's
    // native 422 becomes the shared 400 structured body.
    const app = new Elysia().use(errorHandlerPlugin).use(systemKeysRoutes);
    const res = await app.fetch(authedRequest("/api/system-keys", adminToken, { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INPUT_VALIDATION_ERROR");
  });

  it("requires valid nonempty explicit grants and denies undeclared routes", async () => {
    const app = new Elysia().use(errorHandlerPlugin).use(systemKeysRoutes);
    for (const permissions of [undefined, [], ["unknown"], ["channels:read", "channels:read"]]) {
      const response = await app.handle(
        authedRequest("/api/system-keys", adminToken, {
          method: "POST",
          body: JSON.stringify({ name: "invalid", permissions }),
        }),
      );
      expect(response.status).toBe(400);
    }
    const created = await adminCall("/api/system-keys", {
      method: "POST",
      body: JSON.stringify({ name: "reader", permissions: ["channels:read"] }),
    });
    createdKeyIds.push(created.body.id);
    const guarded = new Elysia()
      .use(errorHandlerPlugin)
      .use(authGuard)
      .get("/read", () => "yes", { systemPermission: "channels:read" })
      .get("/write", () => "no", { systemPermission: "channels:write" })
      .get("/future", () => "no");
    for (const path of ["read", "future", "write", "read", "future"]) {
      const response = await guarded.handle(
        new Request(`http://localhost/${path}`, { headers: { authorization: `Bearer ${created.body.key}` } }),
      );
      expect(response.status).toBe(path === "read" ? 200 : 403);
    }
    await expect(isIssuedCredential(created.body.key, "instance:read")).rejects.toThrow("instance:read");
    expect(systemKeyPermissions({ permissionVersion: 2, systemPermissions: ["channels:read"] })).toEqual([]);
    expect(intersectSystemPermissions(["channels:read"], ["channels:read", "channels:write"])).toEqual([
      "channels:read",
    ]);
    const paneId = `s_${crypto.randomUUID()}`;
    await new SubshellsRepository(db).create({
      id: paneId,
      userId: await ensureSystemUser(),
      presetId: "p",
      harnessId: "terminal",
      name: "scoped",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    try {
      const child = await issueSubshellToken(paneId, await ensureSystemUser(), ["channels:read"]);
      const pane = await new SubshellsRepository(db).findById(paneId);
      if (pane?.apiKeyId) createdKeyIds.push(pane.apiKeyId);
      for (const path of ["read", "write", "future"]) {
        expect(
          (
            await guarded.handle(
              new Request(`http://localhost/${path}`, { headers: { authorization: `Bearer ${child}` } }),
            )
          ).status,
        ).toBe(path === "read" ? 200 : 403);
      }
    } finally {
      await db.deleteFrom("subshells").where("id", "=", paneId).execute();
    }
  });

  it("a subshell-kind key is never listed through the system routes", async () => {
    // The seed in subshell-tokens suites proves list scoping is by metadata kind.
    const listed = await adminCall("/api/system-keys");
    for (const k of listed.body.keys as { name: string }[]) expect(k.name.startsWith("sess:")).toBe(false);
  });

  it("node management is opt-in, owner-scoped, and uses real setup-key enrollment", async () => {
    const app = new Elysia().use(errorHandlerPlugin).use(openApiPlugin).use(nodesRoutes).use(systemKeysRoutes);
    const nodes = new NodesRepository(db);
    const systemId = await ensureSystemUser();
    await ensureLocalNode(db);
    const foreignId = crypto.randomUUID();
    await nodes.create({
      id: foreignId,
      ownerUserId: adminId,
      name: "foreign automation node",
      kind: "agent",
      status: "offline",
    });
    await new NodeSharesRepository(db).replaceForNode(
      foreignId,
      [{ granteeUserId: null, permission: "edit" }],
      adminId,
    );
    const keys: { key: string; id: string }[] = [];
    for (const permissions of [["channels:read"], ["channels:read"], [...API_KEY_PERMISSIONS]]) {
      const created = await adminCall("/api/system-keys", {
        method: "POST",
        body: JSON.stringify({ name: "node automation", permissions }),
      });
      expect(created.status).toBe(200);
      keys.push(created.body);
      createdKeyIds.push(created.body.id);
    }
    // Legacy keys predate the flag entirely, rather than storing false.
    authDatabase().run("UPDATE apikey SET metadata = ? WHERE id = ?", [
      JSON.stringify({ kind: "system" }),
      keys[0]?.id ?? "",
    ]);
    const enabled = keys[2];
    if (!enabled) throw new Error("Expected an enabled key fixture");
    const call = (key: string, path: string, method = "GET", body?: unknown) =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const operations: [string, string, unknown?][] = [
      ["/setup-keys", "POST"],
      ["/setup-keys", "GET"],
      ["/setup-keys/missing", "DELETE"],
      ["/missing", "GET"],
      ["/missing", "PATCH", { name: "renamed" }],
      ["/missing/allowed-dirs", "PUT", { dirs: [] }],
      ["/missing/shares", "GET"],
      ["/missing/shares", "PUT", { shares: [] }],
      ["/missing/cross-agent", "PUT", { crossCommNotes: null, recommendedStartingDirs: [] }],
      ["/missing/ssh-enabled", "PUT", { on: true }],
      ["/missing/ssh-wide-forwards", "PUT", { on: false }],
      ["/missing/config", "PATCH", { serverUrl: "https://subshell.example.com" }],
      ["/missing/logging", "PUT", { debug: true }],
      ["/missing/maintenance", "PUT", { on: false }],
      ["/missing/recheck", "POST"],
    ];
    const paneId = `s_${crypto.randomUUID()}`;
    const panes = new SubshellsRepository(db);
    await panes.create({
      id: paneId,
      userId: adminId,
      presetId: "p",
      harnessId: "terminal",
      name: "permission test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const paneKey = await issueSubshellToken(paneId, adminId);
    const pane = await panes.findById(paneId);
    if (!pane?.apiKeyId) throw new Error("Expected a pane key fixture");
    createdKeyIds.push(pane.apiKeyId);
    // Even a flag attached to another kind of credential must not grant this permission.
    authDatabase().run(
      "UPDATE apikey SET metadata = json_set(metadata, '$.allowNodeManagement', json('true')) WHERE id = ?",
      [pane.apiKeyId],
    );
    let nodeId: string | undefined;
    let setupId: string | undefined;
    try {
      for (const key of [...keys.slice(0, 2), { key: paneKey }]) {
        for (const [path, method, body] of operations) {
          const response = await call(key.key, `/api/nodes${path}`, method, body);
          expect(response.status, `${method} ${path}`).toBe(403);
        }
        expect((await call(key.key, "/api/nodes")).status).toBe(key.key === keys[1]?.key ? 403 : 200);
      }
      const listed = await adminCall("/api/system-keys");
      expect(listed.body.keys.find((key: { id: string }) => key.id === enabled.id).permissions).toEqual(
        API_KEY_PERMISSIONS,
      );
      const setup = await call(enabled.key, "/api/nodes/setup-keys", "POST");
      expect(setup.status).toBe(201);
      const setupBody = (await setup.json()) as { id: string; key: string };
      setupId = setupBody.id;
      expect((await new NodeSetupKeysRepository(db).listByUser(systemId)).some((key) => key.id === setupId)).toBe(true);
      const { publicKey } = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
      const enrollment = await app.handle(
        new Request("http://localhost/api/nodes/enroll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            setupKey: setupBody.key,
            name: "automated machine",
            os: "linux",
            arch: "x64",
            hostname: "automation",
            agentVersion: "1.0.0",
            publicKey: JSON.stringify(await exportJWK(publicKey)),
          }),
        }),
      );
      expect(enrollment.status).toBe(201);
      const enrolled = (await enrollment.json()) as { nodeId: string; nodeKey: string };
      nodeId = enrolled.nodeId;
      expect((await nodes.findById(enrolled.nodeId))?.ownerUserId).toBe(systemId);
      for (const [path, method, body] of operations) {
        expect((await call(enrolled.nodeKey, `/api/nodes${path}`, method, body)).status).toBe(401);
        expect((await call("invalid-key", `/api/nodes${path}`, method, body)).status).toBe(401);
      }
      expect((await call(enabled.key, `/api/nodes/${nodeId}`)).status).toBe(200);
      expect((await call(enabled.key, `/api/nodes/${nodeId}`, "PATCH", { name: "automated renamed" })).status).toBe(
        200,
      );
      expect(
        (await call(enabled.key, `/api/nodes/${nodeId}/allowed-dirs`, "PUT", { dirs: ["/srv/work"] })).status,
      ).toBe(200);
      expect(
        (
          await call(enabled.key, `/api/nodes/${nodeId}/cross-agent`, "PUT", {
            crossCommNotes: "Fleet worker",
            recommendedStartingDirs: ["/srv/work"],
          })
        ).status,
      ).toBe(200);
      expect((await call(enabled.key, `/api/nodes/${nodeId}/shares`, "PUT", { shares: [] })).status).toBe(200);
      expect((await call(enabled.key, `/api/nodes/${nodeId}`, "DELETE")).status).toBe(403);
      expect(
        (await call(enabled.key, `/api/nodes/${nodeId}/config`, "PATCH", { serverUrl: "https://example.com" })).status,
      ).toBe(403);
      const recovery = await new NodeSetupKeysRepository(db).create(systemId, undefined, nodeId);
      try {
        const list = await (await call(enabled.key, "/api/nodes/setup-keys")).text();
        expect(list).not.toContain(recovery.key);
        expect((await call(enabled.key, `/api/nodes/setup-keys/${recovery.id}`, "DELETE")).status).toBe(404);
        expect(await new NodeSetupKeysRepository(db).findById(recovery.id)).toBeDefined();
      } finally {
        await db.deleteFrom("nodeSetupKeys").where("id", "=", recovery.id).execute();
      }
      for (const target of [foreignId, "local"]) {
        expect((await call(enabled.key, `/api/nodes/${target}`)).status).toBe(404);
        expect((await call(enabled.key, `/api/nodes/${target}`, "PATCH", { name: "forbidden" })).status).toBe(404);
      }
      expect((await call(enabled.key, "/api/nodes/setup-keys?all=1")).status).toBe(403);
      expect(
        (
          await call(enabled.key, "/api/system-keys", "POST", {
            name: "escalation",
            permissions: [...API_KEY_PERMISSIONS],
          })
        ).status,
      ).toBe(403);
      await new SettingsRepository(db).set(ALLOW_NODE_ENROLLMENT_KEY, false);
      expect((await call(enabled.key, "/api/nodes/setup-keys", "POST")).status).toBe(403);
      await new SettingsRepository(db).set(ALLOW_NODE_ENROLLMENT_KEY, true);
      const disposable = (await (await call(enabled.key, "/api/nodes/setup-keys", "POST")).json()) as { id: string };
      expect((await call(enabled.key, `/api/nodes/setup-keys/${disposable.id}`, "DELETE")).status).toBe(200);
      await adminCall(`/api/system-keys/${enabled.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
      expect((await call(enabled.key, `/api/nodes/${nodeId}`)).status).toBe(401);

      const schemaResponse = await app.handle(new Request("http://localhost/openapi.json"));
      expect(schemaResponse.status).toBe(200);
      const schema = (await schemaResponse.json()) as {
        components: { securitySchemes: { bearerAuth: { scheme: string } } };
        paths: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(schema.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
      expect(schema.paths["/api/nodes/setup-keys"].post["x-api-key-permission"]).toBe("nodes:enroll");
      expect(schema.paths["/api/nodes/{id}/allowed-dirs"].put.requestBody).toBeDefined();
      expect((await app.handle(new Request("http://localhost/docs/json"))).headers.get("location")).toBe(
        "/openapi.json",
      );
    } finally {
      await new SettingsRepository(db).set(ALLOW_NODE_ENROLLMENT_KEY, true);
      await db.deleteFrom("subshells").where("id", "=", paneId).execute();
      if (nodeId) {
        const node = await nodes.findById(nodeId);
        if (node?.apiKeyId) authDatabase().run("DELETE FROM apikey WHERE id = ?", [node.apiKeyId]);
        await db.deleteFrom("nodes").where("id", "=", nodeId).execute();
      }
      if (setupId) await db.deleteFrom("nodeSetupKeys").where("id", "=", setupId).execute();
      await db.deleteFrom("nodes").where("id", "=", foreignId).execute();
    }
  });
});
