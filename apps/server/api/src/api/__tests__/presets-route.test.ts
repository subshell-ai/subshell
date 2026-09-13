import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { TRUE_BINARY } from "@/__tests__/helpers/true-binary.js";
import { usableHarnessIds } from "@/api/harness-utils.js";
import { presetRoutes } from "@/api/presets.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { installLocalPlugin, uninstallLocalPlugin } from "@/services/nodes/local-plugins.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import {
  authedRequest,
  deleteUserByEmailOrId,
  seedLocalPluginsForTests,
  setupAuthTables,
  signIn,
} from "./helpers/auth-tables.js";

/**
 * Preset WRITES (POST /, PUT /:id, DELETE /:id) are cookie-only; reads stay
 * open to every authenticated actor (the agent toolset only ever GETs the
 * list — list_presets).
 *
 * The regression these pin: a bearer key could create/update/delete the
 * owner's presets, and preset.env OUTRANKS the SUBSHELL_* credential layer when
 * a subshell starts — rewriting the owner's presets was a harvest path for
 * every future subshell's bearer token. Additionally, env var KEYS are
 * validated server-side on create and update (they reach the tmux start
 * command, so `X; touch /tmp/pwned #` is a shell-injection vector).
 */

const app = new Elysia().use(errorHandlerPlugin).use(presetRoutes);

const validBody = { harnessId: "claude-code", name: "writetest", env: { GOOD_KEY_1: "v" } };

describe("preset write routes (cookie only) + env name validation", () => {
  let userId: string;
  const email = `profw-${crypto.randomUUID()}@subshell.local`;
  const password = "profw-pass-1234";
  let cookie: string;
  let subshellKey: string;
  let systemKey: string;
  let subshellId: string;
  const createdKeyIds: string[] = [];
  const createdPresetIds: string[] = [];
  const repo = new PresetsRepository(db);

  /** Bearer request against a preset-routes path (GET/POST/PUT/DELETE). */
  function bearerRequest(path: string, key: string, init?: RequestInit): Request {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${key}`);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return new Request(`http://localhost:3080${path}`, { ...init, headers });
  }

  /** Seeds a preset directly (bypasses the POST gate under test). */
  async function seedPreset(name: string, envJson: string | null): Promise<string> {
    const id = crypto.randomUUID();
    createdPresetIds.push(id);
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
    // Every fixture here is a claude-code preset, and GET /api/presets
    // filters rows to INSTALLED harnesses (presets.route.ts) — so on a bare
    // CI runner the seeded rows vanished from the list ("seeded preset
    // missing"). CLAUDE_PATH is the plugin's documented binary override
    // (same technique as harness-enable.test.ts / the PI_PATH negative case);
    // /bin/true exists on every POSIX runner.
    process.env.CLAUDE_PATH = TRUE_BINARY;
    await setupAuthTables();
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
      presetId: "p",
      harnessId: "claude-code",
      name: "profw-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    subshellKey = await issueSubshellToken(subshellId, userId);
    const row = await new SubshellsRepository(db).findById(subshellId);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);

    const created = (await getAuth().api.createApiKey({
      body: { name: "profw-sys-test", userId: await ensureSystemUser(), metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    systemKey = created.key;

    ownedId = await seedPreset("owned", null);
  });

  afterAll(async () => {
    for (const id of createdPresetIds) await repo.delete(id);
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
    delete process.env.CLAUDE_PATH;
  });

  it("subshell token still reads the preset list (GET 200, envJson redacted)", async () => {
    const res = await app.fetch(bearerRequest("/api/presets", subshellKey));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  // F2 (security audit 2026-08): reads stay open for list_presets, but
  // preset.env is secret storage — a bearer key must never harvest it. The
  // MCP tool projects rows to {id,name,harnessId} client-side, so redacting
  // envJson to null cannot break it. flagsJson/settingsJson are NOT secret
  // storage by convention and stay visible.
  describe("GET /api/presets envJson redaction", () => {
    let secretPresetId: string;
    // A system key authenticates as the SYSTEM service user, so proving the
    // redaction for that actor needs a row the system user actually owns.
    let systemSecretPresetId: string;

    beforeAll(async () => {
      secretPresetId = await seedPreset("envsecret", '{"API_TOKEN":"operator-secret"}');
      await repo.update(secretPresetId, {
        flagsJson: '["--verbose"]',
        settingsJson: '{"model":"sonnet"}',
      });

      systemSecretPresetId = crypto.randomUUID();
      createdPresetIds.push(systemSecretPresetId);
      await repo.create({
        id: systemSecretPresetId,
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
      expect(row, "seeded preset missing from list").toBeDefined();
      return row;
    }

    it("subshell bearer sees envJson=null but keeps flags/settings", async () => {
      const res = await app.fetch(bearerRequest("/api/presets", subshellKey));
      expect(res.status).toBe(200);
      const row = findRow((await res.json()) as { id: string }[], secretPresetId);
      expect(row.envJson).toBeNull();
      expect(row.flagsJson).toBe('["--verbose"]');
      expect(row.settingsJson).toBe('{"model":"sonnet"}');
    });

    it("system bearer also sees envJson=null", async () => {
      const res = await app.fetch(bearerRequest("/api/presets", systemKey));
      expect(res.status).toBe(200);
      expect(findRow((await res.json()) as { id: string }[], systemSecretPresetId).envJson).toBeNull();
    });

    it("cookie sees envJson intact (preset editor needs it)", async () => {
      const res = await app.fetch(authedRequest("/api/presets", cookie));
      expect(res.status).toBe(200);
      const row = findRow((await res.json()) as { id: string }[], secretPresetId);
      expect(JSON.parse(row.envJson as string)).toEqual({ API_TOKEN: "operator-secret" });
    });
  });

  it("subshell token cannot create, update, or delete (403, target untouched)", async () => {
    const post = await app.fetch(
      bearerRequest("/api/presets", subshellKey, { method: "POST", body: JSON.stringify(validBody) }),
    );
    expect(post.status).toBe(403);

    // The exact attack: repoint the credential layer for future subshells.
    const put = await app.fetch(
      bearerRequest(`/api/presets/${ownedId}`, subshellKey, {
        method: "PUT",
        body: JSON.stringify({ env: { SUBSHELL_API_KEY: "attacker" } }),
      }),
    );
    expect(put.status).toBe(403);
    expect((await repo.findById(ownedId))?.envJson).toBeNull();

    const del = await app.fetch(bearerRequest(`/api/presets/${ownedId}`, subshellKey, { method: "DELETE" }));
    expect(del.status).toBe(403);
    expect(await repo.findById(ownedId)).toBeDefined();
  });

  it("system key cannot create, update, or delete (403)", async () => {
    const post = await app.fetch(
      bearerRequest("/api/presets", systemKey, { method: "POST", body: JSON.stringify(validBody) }),
    );
    expect(post.status).toBe(403);
    const put = await app.fetch(
      bearerRequest(`/api/presets/${ownedId}`, systemKey, {
        method: "PUT",
        body: JSON.stringify({ env: { SUBSHELL_BASE_URL: "http://evil" } }),
      }),
    );
    expect(put.status).toBe(403);
    const del = await app.fetch(bearerRequest(`/api/presets/${ownedId}`, systemKey, { method: "DELETE" }));
    expect(del.status).toBe(403);
  });

  it("cookie create with a shell-injection env KEY -> 400, named in the message", async () => {
    const badKey = "X; touch /tmp/pwned #";
    const res = await app.fetch(
      authedRequest("/api/presets", cookie, {
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
      authedRequest("/api/presets", cookie, {
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
    createdPresetIds.push(created.id);
    expect(JSON.parse(created.envJson)).toEqual({ MY_VAR_2: "any value; incl. $(parens)" });
  });

  it("cookie update: invalid env key -> 400, valid env -> 200 and persisted", async () => {
    const bad = await app.fetch(
      authedRequest(`/api/presets/${ownedId}`, cookie, {
        method: "PUT",
        body: JSON.stringify({ env: { "BAD NAME": "1" } }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toBe("invalid env var name: BAD NAME");
    expect((await repo.findById(ownedId))?.envJson).toBeNull();

    const good = await app.fetch(
      authedRequest(`/api/presets/${ownedId}`, cookie, {
        method: "PUT",
        body: JSON.stringify({ env: { OK_KEY: "x; y" } }),
      }),
    );
    expect(good.status).toBe(200);
    expect(JSON.parse(((await good.json()) as { envJson: string }).envJson)).toEqual({ OK_KEY: "x; y" });
  });

  it("cookie update of an unknown preset still 404s (cookie gate runs before ownership)", async () => {
    const res = await app.fetch(
      authedRequest(`/api/presets/${crypto.randomUUID()}`, cookie, {
        method: "PUT",
        body: JSON.stringify({ name: "ghost" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("cookie delete -> 200 {ok:true} and the row is gone", async () => {
    const id = await seedPreset("todelete", null);
    const res = await app.fetch(authedRequest(`/api/presets/${id}`, cookie, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(await repo.findById(id)).toBeUndefined();
  });

  it("GET never seeds: a presetless user reading the list stays presetless", async () => {
    // The one invariant the Default deletion replaced: nothing on ANY read
    // path writes preset rows. A read-side "convenience" seed would resurrect
    // rows a user deleted on the very next refetch and make Delete look broken.
    await db.deleteFrom("presets").where("userId", "=", userId).execute();
    const res = await app.fetch(authedRequest("/api/presets", cookie));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toEqual([]);
    expect(await repo.listByUser(userId)).toEqual([]);
  });
});

/**
 * The pin died with spec 2026-09-13 §2.3: the routes neither read nor store a
 * node. What replaces the pinning suite is the pair of facts the deletion
 * leaves on the wire — a stray `nodeId` in a write body changes nothing, and
 * DELETE NULLS the referencing subshells (their restart falls back to the
 * empty preset instead of erroring).
 */
describe("preset writes have no node dimension (spec 2026-09-13 §6)", () => {
  const pw = "nopin-pass-1234";
  const ownerEmail = `nopin-${crypto.randomUUID()}@subshell.local`;
  const repo = new PresetsRepository(db);
  const subshells = new SubshellsRepository(db);
  let ownerId: string;
  let ownerCookie: string;
  const createdPresetIds: string[] = [];

  beforeAll(async () => {
    process.env.CLAUDE_PATH = TRUE_BINARY;
    await setupAuthTables();
    ownerId = await new UsersRepository(db).createUser({
      email: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    await ensureLocalNode(db);
  });

  afterAll(async () => {
    for (const id of createdPresetIds) await repo.delete(id);
    await db.deleteFrom("subshells").where("userId", "=", ownerId).execute();
    await deleteUserByEmailOrId(ownerEmail);
    delete process.env.CLAUDE_PATH;
  });

  it("POST body carrying nodeId has no persisted effect", async () => {
    const res = await app.fetch(
      authedRequest("/api/presets", ownerCookie, {
        method: "POST",
        body: JSON.stringify({ harnessId: "claude-code", name: "stray-node-id", nodeId: crypto.randomUUID() }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    createdPresetIds.push(body.id as string);
    // Elysia strips the unknown field; the row shape is exactly the schema's.
    expect(Object.keys(body).sort()).toEqual(
      [
        "configIsolation",
        "createdAt",
        "description",
        "envJson",
        "flagsJson",
        "harnessId",
        "id",
        "name",
        "restartOnExit",
        "settingsJson",
        "updatedAt",
        "userId",
      ].sort(),
    );
    expect(await repo.findById(body.id as string)).toBeDefined();
  });

  it("PUT body carrying nodeId has no persisted effect either", async () => {
    const id = (
      await repo.create({
        id: crypto.randomUUID(),
        userId: ownerId,
        harnessId: "claude-code",
        name: "put-stray",
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
      })
    ).id;
    createdPresetIds.push(id);
    const res = await app.fetch(
      authedRequest(`/api/presets/${id}`, ownerCookie, {
        method: "PUT",
        body: JSON.stringify({ name: "put-stray-2", nodeId: crypto.randomUUID() }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("put-stray-2");
    expect((await repo.findById(id))?.name).toBe("put-stray-2");
  });

  it("DELETE nulls subshells.preset_id on the rows that used it", async () => {
    // The §6 ruling: deleting a preset is not deleting its launches. The
    // subshell survives, its `presetId` goes NULL, and its later restart
    // composes from the empty preset instead of erroring.
    const id = (
      await repo.create({
        id: crypto.randomUUID(),
        userId: ownerId,
        harnessId: "claude-code",
        name: "referenced",
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
      })
    ).id;
    const subshellId = crypto.randomUUID();
    await subshells.create({
      id: subshellId,
      userId: ownerId,
      presetId: id,
      harnessId: "claude-code",
      name: "keeper",
      workingDir: "/tmp",
      tmuxSocket: null,
    });

    const res = await app.fetch(authedRequest(`/api/presets/${id}`, ownerCookie, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await repo.findById(id)).toBeUndefined();
    const row = await subshells.findById(subshellId);
    expect(row, "the subshell outlives its preset").toBeDefined();
    expect(row?.presetId).toBeNull(); // the null is proven, not merely absent
  });
});

/**
 * `?node=any` (spec 2026-09-02 node-profile-pairing §4a): the new-subshell
 * form pairs presets against EVERY node client-side, so it must see presets
 * whose harness is off here. The default listing keeps its local gate —
 * mobile and the presets page rely on the hiding.
 */
describe("GET /api/presets — node=any", () => {
  let userId: string;
  let cookie: string;
  let presetId: string;
  const email = `profany-${crypto.randomUUID()}@subshell.local`;
  const password = "profany-pass-1234";
  const presets = new PresetsRepository(db);

  beforeAll(async () => {
    // claude-code's BINARY must read as installed, so the row's absence under
    // the default listing can only come from the host not having the PLUGIN.
    // Those were the same fact when this was an enable flag; they are two now.
    process.env.CLAUDE_PATH = TRUE_BINARY;
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);
    presetId = (
      await presets.create({
        id: crypto.randomUUID(),
        userId,
        harnessId: "claude-code",
        name: `any-${crypto.randomUUID()}`,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
      })
    ).id;
    await seedLocalPluginsForTests();
    await uninstallLocalPlugin("claude-code");
  });

  afterAll(async () => {
    // Put it back: these suites share one data dir, so leaving it uninstalled
    // changes what every later suite in the process sees.
    await installLocalPlugin("claude-code");
    await deleteUserByEmailOrId(email);
  });

  it("hides the preset of a harness this host does not have, without the param", async () => {
    const res = await app.fetch(authedRequest("/api/presets", cookie));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).not.toContain(presetId);
  });

  it("returns it when node=any is passed", async () => {
    const res = await app.fetch(authedRequest("/api/presets?node=any", cookie));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(presetId);
  });

  /**
   * `node` is a closed one-value set (t.Literal, spec 2026-09-02 §4a): a
   * misspelling must 400 loudly, never silently degrade to the local-filtered
   * list — the exact bug class the param exists to remove.
   */
  it("400s a node value outside {any} instead of silently filtering", async () => {
    for (const bad of ["ANY", "anyy", "mac-mini"]) {
      const res = await app.fetch(authedRequest(`/api/presets?node=${bad}`, cookie));
      expect(res.status, `node=${bad}`).toBe(400);
    }
  });
});
