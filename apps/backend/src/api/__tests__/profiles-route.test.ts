import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { usableHarnessIds } from "@/api/harness-utils.js";
import { profileRoutes } from "@/api/profiles.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * Profile WRITES (POST /, PUT /:id, DELETE /:id) are cookie-only; reads stay
 * open to every authenticated actor (the agent toolset only ever GETs the
 * list — mote_list_profiles).
 *
 * The regression these pin: a bearer key could create/update/delete the
 * owner's profiles, and profile.env OUTRANKS the MOTE_* credential layer when
 * a session starts — rewriting the owner's default profile was a harvest path
 * for every future session's bearer token. Additionally, env var KEYS are
 * validated server-side on create and update (they reach the tmux start
 * command, so `X; touch /tmp/pwned #` is a shell-injection vector).
 */

const app = new Elysia().use(errorHandlerPlugin).use(profileRoutes);

const validBody = { harnessId: "claude-code", name: "writetest", env: { GOOD_KEY_1: "v" } };

describe("profile write routes (cookie only) + env name validation", () => {
  let userId: string;
  const email = `profw-${crypto.randomUUID()}@mote.local`;
  const password = "profw-pass-1234";
  let cookie: string;
  let sessionKey: string;
  let systemKey: string;
  let sessionId: string;
  const createdKeyIds: string[] = [];
  const createdProfileIds: string[] = [];
  const repo = new ProfilesRepository(db);

  /** Bearer request against a profile-routes path (GET/POST/PUT/DELETE). */
  function bearerRequest(path: string, key: string, init?: RequestInit): Request {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${key}`);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return new Request(`http://localhost:3080${path}`, { ...init, headers });
  }

  /** Seeds a profile directly (bypasses the POST gate under test). */
  async function seedProfile(name: string, envJson: string | null): Promise<string> {
    const id = crypto.randomUUID();
    createdProfileIds.push(id);
    await repo.create({
      id,
      userId,
      harnessId: "claude-code",
      name,
      description: null,
      envJson,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      restartOnExit: 0,
    });
    return id;
  }

  let ownedId: string;

  beforeAll(async () => {
    // Every fixture here is a claude-code profile, and GET /api/profiles
    // filters rows to INSTALLED harnesses (profiles.route.ts) — so on a bare
    // CI runner the seeded rows vanished from the list ("seeded profile
    // missing"). CLAUDE_PATH is the plugin's documented binary override
    // (same technique as harness-enable.test.ts / the PI_PATH negative case);
    // /bin/true exists on every POSIX runner.
    process.env.CLAUDE_PATH = "/bin/true";
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);

    sessionId = crypto.randomUUID();
    await new SessionsRepository(db).create({
      id: sessionId,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "profw-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    sessionKey = await issueSessionToken(sessionId, userId);
    const row = await new SessionsRepository(db).findById(sessionId);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);

    const created = (await auth.api.createApiKey({
      body: { name: "profw-sys-test", userId: await ensureSystemUser(), metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    systemKey = created.key;

    ownedId = await seedProfile("owned", null);
  });

  afterAll(async () => {
    for (const id of createdProfileIds) await repo.delete(id);
    await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
    delete process.env.CLAUDE_PATH;
  });

  it("session token still reads the profile list (GET 200, envJson redacted)", async () => {
    const res = await app.fetch(bearerRequest("/api/profiles", sessionKey));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  // F2 (security audit 2026-08): reads stay open for mote_list_profiles, but
  // profile.env is secret storage — a bearer key must never harvest it. The
  // MCP tool projects rows to {id,name,harnessId} client-side, so redacting
  // envJson to null cannot break it. flagsJson/settingsJson are NOT secret
  // storage by convention and stay visible.
  describe("GET /api/profiles envJson redaction", () => {
    let secretProfileId: string;
    // A system key authenticates as the SYSTEM service user, so proving the
    // redaction for that actor needs a row the system user actually owns.
    let systemSecretProfileId: string;

    beforeAll(async () => {
      secretProfileId = await seedProfile("envsecret", '{"API_TOKEN":"operator-secret"}');
      await repo.update(secretProfileId, {
        flagsJson: '["--verbose"]',
        settingsJson: '{"model":"sonnet"}',
      });

      systemSecretProfileId = crypto.randomUUID();
      createdProfileIds.push(systemSecretProfileId);
      await repo.create({
        id: systemSecretProfileId,
        userId: await ensureSystemUser(),
        harnessId: "claude-code",
        name: "sys-envsecret",
        description: null,
        envJson: '{"S":"1"}',
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
      });
    });

    function findRow(rows: { id: string }[], id: string): Record<string, unknown> {
      const row = rows.find((r) => r.id === id) as unknown as Record<string, unknown>;
      expect(row, "seeded profile missing from list").toBeDefined();
      return row;
    }

    it("session bearer sees envJson=null but keeps flags/settings", async () => {
      const res = await app.fetch(bearerRequest("/api/profiles", sessionKey));
      expect(res.status).toBe(200);
      const row = findRow((await res.json()) as { id: string }[], secretProfileId);
      expect(row.envJson).toBeNull();
      expect(row.flagsJson).toBe('["--verbose"]');
      expect(row.settingsJson).toBe('{"model":"sonnet"}');
    });

    it("system bearer also sees envJson=null", async () => {
      const res = await app.fetch(bearerRequest("/api/profiles", systemKey));
      expect(res.status).toBe(200);
      expect(findRow((await res.json()) as { id: string }[], systemSecretProfileId).envJson).toBeNull();
    });

    it("cookie sees envJson intact (profile editor needs it)", async () => {
      const res = await app.fetch(authedRequest("/api/profiles", cookie));
      expect(res.status).toBe(200);
      const row = findRow((await res.json()) as { id: string }[], secretProfileId);
      expect(JSON.parse(row.envJson as string)).toEqual({ API_TOKEN: "operator-secret" });
    });
  });

  it("session token cannot create, update, or delete (403, target untouched)", async () => {
    const post = await app.fetch(
      bearerRequest("/api/profiles", sessionKey, { method: "POST", body: JSON.stringify(validBody) }),
    );
    expect(post.status).toBe(403);

    // The exact attack: repoint the credential layer for future sessions.
    const put = await app.fetch(
      bearerRequest(`/api/profiles/${ownedId}`, sessionKey, {
        method: "PUT",
        body: JSON.stringify({ env: { MOTE_API_KEY: "attacker" } }),
      }),
    );
    expect(put.status).toBe(403);
    expect((await repo.findById(ownedId))?.envJson).toBeNull();

    const del = await app.fetch(bearerRequest(`/api/profiles/${ownedId}`, sessionKey, { method: "DELETE" }));
    expect(del.status).toBe(403);
    expect(await repo.findById(ownedId)).toBeDefined();
  });

  it("system key cannot create, update, or delete (403)", async () => {
    const post = await app.fetch(
      bearerRequest("/api/profiles", systemKey, { method: "POST", body: JSON.stringify(validBody) }),
    );
    expect(post.status).toBe(403);
    const put = await app.fetch(
      bearerRequest(`/api/profiles/${ownedId}`, systemKey, {
        method: "PUT",
        body: JSON.stringify({ env: { MOTE_BASE_URL: "http://evil" } }),
      }),
    );
    expect(put.status).toBe(403);
    const del = await app.fetch(bearerRequest(`/api/profiles/${ownedId}`, systemKey, { method: "DELETE" }));
    expect(del.status).toBe(403);
  });

  it("cookie create with a shell-injection env KEY -> 400, named in the message", async () => {
    const badKey = "X; touch /tmp/pwned #";
    const res = await app.fetch(
      authedRequest("/api/profiles", cookie, {
        method: "POST",
        body: JSON.stringify({ ...validBody, env: { [badKey]: "1", "ALSO-BAD": "2" } }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string; statusCode: number };
    expect(body.statusCode).toBe(400);
    expect(body.message).toBe(`invalid env var name: ${badKey}`);
  });

  it("cookie create with valid env keys -> 200 when a harness is usable (409 otherwise)", async () => {
    const usable = [...(await usableHarnessIds())];
    const harnessId = usable[0] ?? "claude-code";
    const res = await app.fetch(
      authedRequest("/api/profiles", cookie, {
        method: "POST",
        body: JSON.stringify({ harnessId, name: "goodenv", env: { MY_VAR_2: "any value; incl. $(parens)" } }),
      }),
    );
    if (usable.length === 0) {
      // No harness installed on this machine: the env gate passed (not 400)
      // and the normal availability rule answered instead.
      expect(res.status).toBe(409);
      return;
    }
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string; envJson: string };
    createdProfileIds.push(created.id);
    expect(JSON.parse(created.envJson)).toEqual({ MY_VAR_2: "any value; incl. $(parens)" });
  });

  it("cookie update: invalid env key -> 400, valid env -> 200 and persisted", async () => {
    const bad = await app.fetch(
      authedRequest(`/api/profiles/${ownedId}`, cookie, {
        method: "PUT",
        body: JSON.stringify({ env: { "BAD NAME": "1" } }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toBe("invalid env var name: BAD NAME");
    expect((await repo.findById(ownedId))?.envJson).toBeNull();

    const good = await app.fetch(
      authedRequest(`/api/profiles/${ownedId}`, cookie, {
        method: "PUT",
        body: JSON.stringify({ env: { OK_KEY: "x; y" } }),
      }),
    );
    expect(good.status).toBe(200);
    expect(JSON.parse(((await good.json()) as { envJson: string }).envJson)).toEqual({ OK_KEY: "x; y" });
  });

  it("cookie update of an unknown profile still 404s (cookie gate runs before ownership)", async () => {
    const res = await app.fetch(
      authedRequest(`/api/profiles/${crypto.randomUUID()}`, cookie, {
        method: "PUT",
        body: JSON.stringify({ name: "ghost" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("cookie delete -> 200 {ok:true} and the row is gone", async () => {
    const id = await seedProfile("todelete", null);
    const res = await app.fetch(authedRequest(`/api/profiles/${id}`, cookie, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(await repo.findById(id)).toBeUndefined();
  });

  it("delete of an auto-seeded default -> 409, the row survives", async () => {
    // A Default straight from the seeder (isDefault=1, exactly what the
    // registration seam creates), plus a renamed one — protection follows
    // the flag, not the name.
    const id = crypto.randomUUID();
    createdProfileIds.push(id);
    await repo.create({
      id,
      userId,
      harnessId: "claude-code",
      name: "Default",
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      restartOnExit: 0,
      isDefault: 1,
    });
    const res = await app.fetch(authedRequest(`/api/profiles/${id}`, cookie, { method: "DELETE" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("can't be deleted");
    expect(await repo.findById(id)).toBeDefined();
  });

  it("GET never seeds: a profileless user reading the list stays profileless", async () => {
    // §5's hard invariant — self-healing runs at seed POINTS only. A read-side
    // "convenience" seed would resurrect a just-deleted Default on the very
    // next refetch and make Delete look broken.
    await db.deleteFrom("profiles").where("userId", "=", userId).execute();
    const res = await app.fetch(authedRequest("/api/profiles", cookie));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toEqual([]);
    expect(await repo.listByUser(userId)).toEqual([]);
  });

  it("a renamed default is still protected; a name-alike still deletes", async () => {
    const id = crypto.randomUUID();
    createdProfileIds.push(id);
    await repo.create({
      id,
      userId,
      harnessId: "claude-code",
      name: "My tuned Default",
      description: null,
      envJson: '{"A":"1"}',
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      restartOnExit: 0,
      isDefault: 1,
    });
    const res = await app.fetch(authedRequest(`/api/profiles/${id}`, cookie, { method: "DELETE" }));
    expect(res.status).toBe(409);
    await repo.delete(id); // cleanup via repo — the route will not

    const lookalike = await seedProfile("Default", '{"hand":"made"}');
    const ok = await app.fetch(authedRequest(`/api/profiles/${lookalike}`, cookie, { method: "DELETE" }));
    expect(ok.status).toBe(200);
  });
});
