import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { cors } from "@elysiajs/cors";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { promptsRoutes } from "@/api/prompts.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { PromptsRepository } from "@/db/repositories/prompts.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { corsOriginAllowed } from "@/server.js";
import { originRegistry } from "@/services/trusted-origins.js";
import { wsPlugin } from "@/ws/ws.plugin.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

const FOREIGN = "http://localhost:61987";
const LEARNED = "https://browser-origin.example.invalid";
const PLUGIN = "browser-origin-test";
const app = new Elysia()
  .use(errorHandlerPlugin)
  .use(cors({ origin: corsOriginAllowed }))
  .use(promptsRoutes)
  .use(wsPlugin);

describe("browser origin authorization", () => {
  let userId: string;
  let token: string;
  let port: number;

  beforeAll(async () => {
    await setupAuthTables();
    const email = `origin-${crypto.randomUUID()}@subshell.local`;
    const password = "browser-origin-password";
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    token = await signIn(email, password);
    expect(originRegistry().has(FOREIGN)).toBe(false);
    await app.listen({ hostname: "127.0.0.1", port: 0 });
    const boundPort = app.server?.port;
    if (boundPort === undefined) throw new Error("Test server did not bind a port");
    port = boundPort;
  });

  it("limits the opaque-origin CORS exception to valid preview paths", async () => {
    const requestFor = (path: string) => new Request(`http://localhost${path}`, { headers: { origin: "null" } });
    expect(corsOriginAllowed(requestFor("/pv/0123456789abcdef0123456789abcdef/filter.js"))).toBe(true);
    expect(corsOriginAllowed(requestFor("/api/subshells"))).toBe(false);
    expect(corsOriginAllowed(requestFor("/pv/invalid/index.html"))).toBe(false);
  });

  afterEach(async () => {
    originRegistry().clearPlugin(PLUGIN);
    await db.deleteFrom("prompts").where("userId", "=", userId).execute();
  });
  afterAll(async () => {
    await app.stop(true);
    await deleteUserByEmailOrId(userId);
  });

  function post(origin?: string, form = false) {
    const body = { description: "Origin regression", body: "Unrequested text" };
    return app.fetch(
      authedRequest("/api/prompts", token, {
        method: "POST",
        headers: {
          ...(origin === undefined ? {} : { origin }),
          "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
        },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      }),
    );
  }

  it("rejects a same-site cross-origin form before it writes, even though CORS hides its response", async () => {
    const response = await post(FOREIGN, true);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await new PromptsRepository(db).listOwn(userId)).toHaveLength(0);
  });

  it.each([FOREIGN, "null", "", "http://localhost:3080.evil.invalid"])(
    "rejects cookie mutations from the untrusted Origin %s",
    async (origin) => {
      expect((await post(origin)).status).toBe(403);
      expect(await new PromptsRepository(db).listOwn(userId)).toHaveLength(0);
    },
  );

  it("accepts the configured frontend and clients without an Origin header", async () => {
    expect((await post("http://localhost:5174")).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(await new PromptsRepository(db).listOwn(userId)).toHaveLength(2);
  });

  it("applies origin additions and revocations without restarting", async () => {
    expect((await post(LEARNED)).status).toBe(403);
    originRegistry().setPluginOrigins(PLUGIN, [LEARNED]);
    expect((await post(LEARNED)).status).toBe(200);
    originRegistry().clearPlugin(PLUGIN);
    expect((await post(LEARNED)).status).toBe(403);
    expect(await new PromptsRepository(db).listOwn(userId)).toHaveLength(1);
  });

  it("keeps explicitly supplied bearer credentials independent of cookie origin checks", async () => {
    const created = await getAuth().api.createApiKey({
      body: {
        name: "origin-bearer-test",
        userId: await ensureSystemUser(),
        metadata: { kind: "system", permissionVersion: 1, systemPermissions: ["prompts:read"] },
      },
    });
    try {
      const response = await app.fetch(
        new Request("http://localhost:3080/api/prompts", {
          headers: { authorization: `Bearer ${created.key}`, origin: FOREIGN },
        }),
      );
      expect(response.status).toBe(200);
      // A cookie still selects the cookie path even alongside a valid bearer.
      const cookieResponse = await app.fetch(
        authedRequest("/api/prompts", token, {
          headers: { authorization: `Bearer ${created.key}`, origin: FOREIGN },
        }),
      );
      expect(cookieResponse.status).toBe(403);
    } finally {
      authDatabase().run("DELETE FROM apikey WHERE id = ?", [created.id]);
    }
  });

  async function upgrades(path: string, origin?: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: { cookie: `better-auth.session_token=${token}`, ...(origin === undefined ? {} : { origin }) },
      });
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("WebSocket handshake did not finish"));
      }, 3000);
      socket.onopen = () => {
        clearTimeout(timer);
        socket.close();
        resolve(true);
      };
      socket.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  it.each(["/ws", "/ws/live"])("refuses an untrusted browser before upgrading %s", async (path) => {
    expect(await upgrades(path, FOREIGN)).toBe(false);
    expect(await upgrades(path, "null")).toBe(false);
    // Authentication still runs after a trusted handshake. These probes have
    // no pane or attach token, so the handler closes them without attaching.
    expect(await upgrades(path, "http://localhost:5174")).toBe(true);
    expect(await upgrades(path)).toBe(true);
  });
});
