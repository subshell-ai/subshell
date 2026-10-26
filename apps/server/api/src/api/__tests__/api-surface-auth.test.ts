import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { authGuard, requireAdmin } from "@/api/auth-guard.js";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { routes } from "@/api/routes.js";
import { setHasUsersProbeForTests } from "@/api/setup.route.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getAuth } from "@/modules/auth/auth.js";
import { authDatabase } from "@/modules/auth/database.js";
import { ensureSystemUser } from "@/modules/auth/system-user.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../testing/api/auth-tables.js";

// Every exception must name its credential boundary. A new route without
// authGuard fails this inventory check even if nobody adds a request case.
const MANUAL_AUTH_ROUTES = {
  "GET /api/settings/instance": "Public sign-in configuration",
  "GET /api/setup/status": "Public first-account status",
  "GET /api/setup/progress": "Own cookie session",
  "PATCH /api/setup/progress": "Own cookie session",
  "GET /api/setup/harnesses": "Public before first account; issued credential afterwards",
  "POST /api/setup/plugins": "Built-ins before first account; admin cookie afterwards",
  "DELETE /api/setup/plugins/:pluginId": "Built-ins before first account; admin cookie afterwards",
  "POST /api/setup/agents/:pluginId/install": "Admin cookie, including during first run",
  "POST /api/setup/tmux/install": "Admin cookie, including during first run",
  "GET /api/network/": "Admin cookie",
  "PATCH /api/network/:id/settings": "Admin cookie",
  "POST /api/network/:id/install": "Admin cookie",
  "POST /api/network/:id/join": "Admin cookie",
  "POST /api/network/:id/publish": "Admin cookie",
  "POST /api/network/:id/unpublish": "Admin cookie",
  "POST /api/network/:id/leave": "Admin cookie",
  "GET /api/downloads/node/:target": "Cookie, unspent setup key, or update ticket",
  "GET /api/downloads/node/linux-x64.sha256": "Cookie or unspent setup key",
  "GET /api/downloads/node/linux-arm64.sha256": "Cookie or unspent setup key",
  "GET /api/downloads/node/darwin-arm64.sha256": "Cookie or unspent setup key",
  "GET /api/downloads/node/darwin-x64.sha256": "Cookie or unspent setup key",
  "POST /api/nodes/enroll": "Unspent setup key",
  "POST /api/nodes/route": "Paired node key inside an encrypted envelope",
  "GET /api/restore-status/:id": "Expiring read-only job capability",
};

const app = new Elysia().use(errorHandlerPlugin).use(routes);
const authTransforms = new Set((authGuard.event.transform ?? []).map((hook) => hook.fn));
const permissionChecks = new Set((authGuard.event.beforeHandle ?? []).map((hook) => hook.fn));
const adminTransforms = new Set(
  (requireAdmin.event.transform ?? []).filter((hook) => !authTransforms.has(hook.fn)).map((hook) => hook.fn),
);
const guarded = app.routes.filter((route) => route.hooks.transform?.some((hook) => authTransforms.has(hook.fn)));
const adminRoutes = app.routes.filter(
  ({ method, path }) =>
    /^\/api\/(?:admin\/|auth-providers(?:\/|$)|system-keys(?:\/|$)|audit(?:\/|$))/.test(path) ||
    (path.startsWith("/api/users/") && !(method === "GET" && path === "/api/users/")),
);

function probe(method: string, path: string, headers?: Record<string, string>, body: unknown = {}) {
  return new Request(`http://localhost:3080${path.replace(/:[^/]+/g, "audit-missing")}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

describe("mounted API authorization boundaries", () => {
  let userId: string;
  let cookie: string;
  let nodeKey: string;
  let systemKey: string;
  const keyIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    const email = `surface-${crypto.randomUUID()}@subshell.local`;
    const password = "api-surface-password";
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);
    const node = await getAuth().api.createApiKey({
      body: { name: "surface-node", userId, metadata: { kind: "node" } },
    });
    nodeKey = node.key;
    keyIds.push(node.id);
    const system = await getAuth().api.createApiKey({
      body: {
        name: "surface-legacy",
        userId: await ensureSystemUser(),
        // Legacy keys have no scope ceiling. Their rejection must come from
        // the cookie-admin boundary, not a missing permission annotation.
        metadata: { kind: "system" },
      },
    });
    systemKey = system.key;
    keyIds.push(system.id);
    setHasUsersProbeForTests(async () => true);
  });

  afterAll(async () => {
    setHasUsersProbeForTests(null);
    for (const id of keyIds) authDatabase().run("DELETE FROM apikey WHERE id = ?", [id]);
    await deleteUserByEmailOrId(userId);
  });

  it("has no undeclared route outside the shared authentication guard", () => {
    expect(authTransforms.size).toBeGreaterThan(0);
    expect(permissionChecks.size).toBeGreaterThan(0);
    const outside = app.routes.filter((route) => !guarded.includes(route));
    expect(outside.map(({ method, path }) => `${method} ${path}`).sort()).toEqual(
      Object.keys(MANUAL_AUTH_ROUTES).sort(),
    );
    for (const route of guarded) {
      expect(
        route.hooks.beforeHandle?.some((hook) => permissionChecks.has(hook.fn)),
        route.path,
      ).toBe(true);
    }
  });

  it("rejects anonymous requests and verified node credentials on every ordinary API route", async () => {
    for (const { method, path } of guarded) {
      for (const headers of [undefined, { authorization: `Bearer ${nodeKey}` }]) {
        const response = await app.fetch(probe(method, path, headers));
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    }
  });

  it("keeps administration behind the cookie-admin guard after route composition", async () => {
    expect(adminTransforms.size).toBeGreaterThan(0);
    for (const route of adminRoutes) {
      expect(
        route.hooks.transform?.some((hook) => adminTransforms.has(hook.fn)),
        route.path,
      ).toBe(true);
      // Only reads carry a valid credential here. An accidental future guard
      // regression must not let the audit execute a host-management command.
      if (route.method !== "GET") continue;
      const ordinary = await app.fetch(authedRequest(route.path.replace(/:[^/]+/g, "audit-missing"), cookie));
      expect(ordinary.status, route.path).toBe(403);
      const machine = await app.fetch(probe("GET", route.path, { authorization: `Bearer ${systemKey}` }));
      expect(machine.status, route.path).toBe(403);
    }
  });

  it("checks credentials on setup and network exceptions after the first account exists", async () => {
    const conditional = app.routes.filter(
      ({ path }) =>
        (path.startsWith("/api/setup/") && path !== "/api/setup/status") || path.startsWith("/api/network/"),
    );
    for (const { method, path } of conditional) {
      const body =
        path === "/api/setup/progress" ? { step: null } : { pluginId: "audit-missing", confirm: "audit-missing" };
      const response = await app.fetch(probe(method, path, undefined, body));
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});
