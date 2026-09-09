import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { setHasUsersProbeForTests, setupRoutes } from "@/api/setup.route.js";
import { authDatabase } from "@/auth/database.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * F3 (security audit 2026-08): `/api/setup/harnesses` GET and
 * `PATCH /api/setup/harnesses/:id` were unauthenticated even after setup —
 * only `/status` is the documented public carve-out. New semantics:
 *
 * - No users yet (needsSetup): all three stay public so the boot wizard works.
 * - Once a user exists: GET requires ANY authenticated actor (cookie or
 *   bearer); PATCH (a machine-config write — the MCP binary never calls it,
 *   confirmed by grepping packages/mcp-core/src/tools.ts for its endpoint census) requires
 *   a COOKIE actor.
 *
 * Isolation note: the test DB is a per-process temp FILE that every other
 * test file in the same `bun test` run writes users into, so the no-users
 * window is driven through the route's exported probe seam (the same
 * reset-function pattern the code-style rules bless for singletons) rather
 * than by emptying — or trusting empty — `user_meta`. The with-users phase
 * uses the REAL probe against the shared DB, which always has rows.
 */

const app = new Elysia().use(errorHandlerPlugin).use(setupRoutes);

const HARNESS_ID = "claude-code";

describe("/api/setup/harnesses conditional auth", () => {
  const email = `setup-${crypto.randomUUID()}@subshell.local`;
  const password = "setup-pass-1234";
  let userId: string;
  let cookie: string;
  let subshellKey = "";
  let subshellId = "";
  let apiKeyId: string | undefined;
  const createdKeyIds: string[] = [];

  function bearerRequest(path: string, key: string, init?: RequestInit): Request {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${key}`);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return new Request(`http://localhost:3080${path}`, { ...init, headers });
  }

  function patchBody(enabled: boolean): RequestInit {
    return { method: "PATCH", body: JSON.stringify({ enabled }) };
  }

  async function anonymousGet(path: string): Promise<Response> {
    return await app.fetch(new Request(`http://localhost:3080${path}`));
  }

  async function anonymousPatch(): Promise<Response> {
    return await app.fetch(
      new Request(`http://localhost:3080/api/setup/harnesses/${HARNESS_ID}`, {
        ...patchBody(false),
        headers: { "content-type": "application/json" },
      }),
    );
  }

  describe("while needsSetup (no users yet)", () => {
    beforeAll(async () => {
      await setupAuthTables();
      setHasUsersProbeForTests(async () => false);
    });

    afterAll(() => setHasUsersProbeForTests(null));

    it("anonymous GET /harnesses is public", async () => {
      const res = await anonymousGet("/api/setup/harnesses");
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });

    it("anonymous PATCH /harnesses/:id is public", async () => {
      const res = await anonymousPatch();
      expect(res.status).toBe(200);
    });

    it("every harness reports when detection ran, and why it failed when it did", async () => {
      const res = await anonymousGet("/api/setup/harnesses");
      const body = (await res.json()) as {
        id: string;
        installed: boolean;
        checkedAt?: string;
        reason?: string;
        version?: string;
      }[];
      expect(body.length).toBeGreaterThan(0);
      for (const h of body) {
        // The stamp is what lets a surface say how old its answer is, which is
        // the difference between the live local probe and an agent's cache.
        expect(typeof h.checkedAt).toBe("string");
        expect(Number.isFinite(Date.parse(h.checkedAt ?? ""))).toBe(true);
        if (h.installed) {
          expect(h.reason).toBeUndefined();
        } else {
          // A missing binary must say WHICH kind of missing, or the UI can only
          // offer an install command that may be the wrong advice entirely.
          expect(h.reason === "not-on-path" || h.reason === "override-invalid").toBe(true);
          expect(h.version).toBeUndefined();
        }
      }
    });

    it("anonymous GET /status still works", async () => {
      const res = await anonymousGet("/api/setup/status");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { needsSetup: boolean }).needsSetup).toBe(true);
    });
  });

  describe("with a user present (real has-users probe: anonymous is locked out)", () => {
    beforeAll(async () => {
      userId = await new UsersRepository(db).createUser({
        email,
        passwordHash: await hashPassword(password),
        role: "user",
      });
      cookie = await signIn(email, password);

      subshellId = crypto.randomUUID();
      await new SubshellsRepository(db).create({
        id: subshellId,
        userId,
        profileId: "p",
        harnessId: "claude-code",
        name: "setup-test",
        workingDir: "/tmp",
        tmuxSocket: null,
      });
      subshellKey = await issueSubshellToken(subshellId, userId);
      apiKeyId = (await new SubshellsRepository(db).findById(subshellId))?.apiKeyId ?? undefined;
    });

    it("anonymous GET /harnesses -> 401", async () => {
      expect((await anonymousGet("/api/setup/harnesses")).status).toBe(401);
    });

    it("anonymous PATCH /harnesses/:id -> 401", async () => {
      expect((await anonymousPatch()).status).toBe(401);
    });

    it("subshell bearer GET /harnesses -> 200 (any authenticated actor)", async () => {
      const res = await app.fetch(bearerRequest("/api/setup/harnesses", subshellKey));
      expect(res.status).toBe(200);
    });

    it("subshell bearer PATCH /harnesses/:id -> 403 (machine-config write is cookie-only)", async () => {
      const res = await app.fetch(bearerRequest(`/api/setup/harnesses/${HARNESS_ID}`, subshellKey, patchBody(false)));
      expect(res.status).toBe(403);
    });

    it("self-minted bearer key -> 401 (setup parser must match authGuard's accept-set)", async () => {
      // M-1 (final review): the old parser accepted ANY verifyApiKey-valid
      // key. authGuard additionally requires subshell-kind keys to match their
      // row's apiKeyId and non-subshell keys to be system-user-owned — so both
      // classes below are 401 material there and must be 401 here too.
      const forgedSubshell = (await getAuth().api.createApiKey({
        body: { name: "setup-forged-subshell", userId, metadata: { kind: "subshell", subshellId } },
      })) as unknown as { id: string; key: string };
      createdKeyIds.push(forgedSubshell.id);
      const fakeSystem = (await getAuth().api.createApiKey({
        body: { name: "setup-fake-system", userId, metadata: { kind: "system" } },
      })) as unknown as { id: string; key: string };
      createdKeyIds.push(fakeSystem.id);
      // Control: both keys DO verify at the plugin level.
      expect(
        (await getAuth().api.verifyApiKey({ body: { key: forgedSubshell.key } })) as unknown as { valid: boolean },
      ).toMatchObject({ valid: true });
      expect((await app.fetch(bearerRequest("/api/setup/harnesses", forgedSubshell.key))).status).toBe(401);
      expect((await app.fetch(bearerRequest("/api/setup/harnesses", fakeSystem.key))).status).toBe(401);
    });

    it("cookie GET /harnesses -> 200", async () => {
      expect((await app.fetch(authedRequest("/api/setup/harnesses", cookie))).status).toBe(200);
    });

    it("cookie PATCH /harnesses/:id -> 200", async () => {
      expect(
        (await app.fetch(authedRequest(`/api/setup/harnesses/${HARNESS_ID}`, cookie, patchBody(false)))).status,
      ).toBe(200);
    });

    it("GET /status remains the public carve-out", async () => {
      const res = await anonymousGet("/api/setup/status");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { hasUsers: boolean }).hasUsers).toBe(true);
    });
  });

  afterAll(async () => {
    setHasUsersProbeForTests(null);
    if (subshellId) await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    if (apiKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [apiKeyId]);
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    if (userId) await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await db.deleteFrom("harnessPlugins").where("id", "=", HARNESS_ID).execute();
    await deleteUserByEmailOrId(email);
  });
});
