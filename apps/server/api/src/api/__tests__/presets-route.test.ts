import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { TRUE_BINARY } from "@/__tests__/helpers/true-binary.js";
import { presetRoutes } from "@/api/presets.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { installLocalPlugin, uninstallLocalPlugin } from "@/services/nodes/local-plugins.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

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

  it("cookie create with valid env keys -> 200", async () => {
    // claude-code is in the INSTANCE store (setupAuthTables seeds the
    // built-ins), and the create gate reads exactly that — the store cases
    // (absent / disabled → 409) live in the store-gate suite below.
    const res = await app.fetch(
      authedRequest("/api/presets", cookie, {
        method: "POST",
        body: JSON.stringify({
          harnessId: "claude-code",
          name: "goodenv",
          env: { MY_VAR_2: "any value; incl. $(parens)" },
        }),
      }),
    );
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
 * leaves on the wire — a stray `nodeId` in a POST body is stripped and
 * changes nothing (PUT rejects it instead: its body schema is strict, see
 * below), and DELETE NULLS the referencing subshells (their restart falls
 * back to the empty preset instead of erroring).
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

  /** Seeds an updatable claude-code preset owned by this suite's user. */
  async function seedUpdatable(name: string): Promise<string> {
    const id = (
      await repo.create({
        id: crypto.randomUUID(),
        userId: ownerId,
        harnessId: "claude-code",
        name,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
      })
    ).id;
    createdPresetIds.push(id);
    return id;
  }

  // PUT's body schema is its OWN and strict (TODO 8): every field the update
  // cannot apply is refused as an unknown property, never 200'd into silence.
  // POST keeps its lenient strip (the nodeId test above).
  it("PUT body carrying nodeId is refused 400, not silently stripped", async () => {
    const id = await seedUpdatable("put-stray");
    const res = await app.fetch(
      authedRequest(`/api/presets/${id}`, ownerCookie, {
        method: "PUT",
        body: JSON.stringify({ name: "put-stray-2", nodeId: crypto.randomUUID() }),
      }),
    );
    expect(res.status).toBe(400);
    // Nothing landed — the whole request died at validation.
    expect((await repo.findById(id))?.name).toBe("put-stray");
  });

  it("renaming onto a name the caller already uses is 409, and nothing lands", async () => {
    // The rename half of the unique index (migration 0028). A 200 here would
    // produce two presets a picker renders identically.
    const first = await seedUpdatable("rename-target");
    const second = await seedUpdatable("rename-source");
    const res = await app.fetch(
      authedRequest(`/api/presets/${second}`, ownerCookie, {
        method: "PUT",
        body: JSON.stringify({ name: "RENAME-TARGET" }), // case-insensitive, as the index is
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/already have a claude-code preset named/i);
    // The failed rename left both rows exactly as they were.
    expect((await repo.findById(second))?.name).toBe("rename-source");
    expect((await repo.findById(first))?.name).toBe("rename-target");
  });

  it("renaming a preset to its OWN name is not a collision with itself", async () => {
    // The row is being updated, not inserted beside itself — a naive
    // SELECT-then-reject would fail this.
    const id = await seedUpdatable("rename-idempotent");
    const res = await app.fetch(
      authedRequest(`/api/presets/${id}`, ownerCookie, {
        method: "PUT",
        body: JSON.stringify({ name: "rename-idempotent", description: "touched" }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await repo.findById(id))?.description).toBe("touched");
  });

  it("PUT body carrying harnessId is refused 400 — a preset's harness is fixed at create", async () => {
    // "Move this preset to another agent" used to answer 200 with NOTHING
    // changed (the handler never read harnessId from the partial-create
    // schema). The honest answer is a 400 naming the unknown property.
    const id = await seedUpdatable("put-harness");
    const res = await app.fetch(
      authedRequest(`/api/presets/${id}`, ownerCookie, {
        method: "PUT",
        body: JSON.stringify({ harnessId: "codex" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await repo.findById(id))?.harnessId).toBe("claude-code");
  });

  it("PUT with only its own fields still updates", async () => {
    const id = await seedUpdatable("put-clean");
    const res = await app.fetch(
      authedRequest(`/api/presets/${id}`, ownerCookie, {
        method: "PUT",
        body: JSON.stringify({ name: "put-clean-2", restartOnExit: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("put-clean-2");
    expect((await repo.findById(id))?.restartOnExit).toBe(1);
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
 * Preset availability is the INSTANCE STORE (spec 2026-09-13 follow-up — the
 * ruling that retired `?node=any` and settles TODO 13's server half, plus 15,
 * 16 and 20 at the root): a preset is instance-scoped; only launches are
 * node-scoped. The list and the create gate read the store set (installed ∧
 * enabled ∧ ¬broken, `getAllHarnessIds()`), never this host's binary probe —
 * so a preset for an agent installed only on ANOTHER machine is simply listed
 * everywhere, and the pairing-matrix escape hatch has nothing left to escape.
 *
 * The `?node=any` suite this replaces pinned the old local filter plus the
 * typo-400 for the closed one-value `node` param; the param is gone, so both
 * pins are.
 *
 * NOT covered here: the ¬broken arm. The installer load-checks before
 * swapping, so a test cannot install a broken plugin — broken rows are
 * reported-state only (`plugins-route.test.ts` says so); the arm is one
 * filter at the shared store read.
 */
describe("preset availability is the instance store (list + create)", () => {
  let userId: string;
  let cookie: string;
  let presetId: string;
  const email = `storegate-${crypto.randomUUID()}@subshell.local`;
  const password = "storegate-pass-1234";
  const presets = new PresetsRepository(db);
  const pluginState = new PluginStateRepository(db);
  const createdPresetIds: string[] = [];

  async function listIds(): Promise<string[]> {
    const res = await app.fetch(authedRequest("/api/presets", cookie));
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }[]).map((r) => r.id);
  }

  /** `POST /api/presets` for claude-code; returns status, message and row id. */
  async function createClaudePreset(name: string): Promise<{ status: number; message?: string; id?: string }> {
    const res = await app.fetch(
      authedRequest("/api/presets", cookie, {
        method: "POST",
        body: JSON.stringify({ harnessId: "claude-code", name }),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { message?: string; id?: string };
    if (body.id) createdPresetIds.push(body.id);
    return { status: res.status, ...body };
  }

  beforeAll(async () => {
    // The binary must NOT read as installed locally — the half of the fact
    // the retired default filter keyed on and the store gate ignores.
    // CLAUDE_PATH is the plugin's documented binary override (the old suite
    // pointed it at TRUE_BINARY for exactly the opposite reason).
    process.env.CLAUDE_PATH = "/definitely/not/here/claude";
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
        name: `storegate-${crypto.randomUUID()}`,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
        restartOnExit: 0,
      })
    ).id;
    // Every case starts from the same store state: installed (the embedded
    // copy; idempotent) and enabled (an absent row means enabled — clear any
    // leftover flag).
    await installLocalPlugin("claude-code");
    await pluginState.clear("claude-code");
  });

  afterAll(async () => {
    // Put it back: these suites share one data dir, so leaving claude-code
    // uninstalled or disabled changes what every later suite sees.
    await installLocalPlugin("claude-code");
    await pluginState.clear("claude-code");
    delete process.env.CLAUDE_PATH;
    for (const id of createdPresetIds) await presets.delete(id);
    await deleteUserByEmailOrId(email);
  });

  it("lists the preset even though its harness binary is NOT detected here", async () => {
    // The headline inversion: exactly what the default (unparametrised) list
    // used to hide and what `?node=any` existed to un-hide. The store has the
    // plugin, the host's PATH does not — the row is listed.
    expect(await listIds()).toContain(presetId);
  });

  it("hides it while the plugin is out of the instance store", async () => {
    await uninstallLocalPlugin("claude-code");
    expect(await listIds()).not.toContain(presetId);
    await installLocalPlugin("claude-code");
    expect(await listIds()).toContain(presetId);
  });

  it("hides it while the plugin is disabled in the instance store", async () => {
    await pluginState.setEnabled("claude-code", false);
    expect(await listIds()).not.toContain(presetId);
    await pluginState.setEnabled("claude-code", true);
    expect(await listIds()).toContain(presetId);
  });

  it("creates through the store gate with no local binary", async () => {
    // TODO 13's server half: creating a preset used to 409 on any host
    // without the agent's CLI on PATH. Saved settings are not node-scoped —
    // the LAUNCH gate still checks the binary per node.
    const { status } = await createClaudePreset("no-local-binary");
    expect(status).toBe(200);
  });

  it("409s a disabled plugin, and the refusal names the server", async () => {
    await pluginState.setEnabled("claude-code", false);
    const { status, message } = await createClaudePreset("while-disabled");
    expect(status).toBe(409);
    expect(message).toBe("That harness is unavailable (disabled or not installed on the server)");
    await pluginState.setEnabled("claude-code", true);
  });

  it("409s a plugin absent from the store", async () => {
    await uninstallLocalPlugin("claude-code");
    const { status } = await createClaudePreset("while-uninstalled");
    expect(status).toBe(409);
    await installLocalPlugin("claude-code");
  });

  it("409s a second preset with the same name for the same agent (any case)", async () => {
    // Migration 0028's create half. Two same-named presets for one agent are
    // indistinguishable in every picker, and the name is how the MCP
    // addresses one — so the duplicate is refused rather than accepted and
    // disambiguated later.
    expect((await createClaudePreset("dup-name")).status).toBe(200);
    const second = await createClaudePreset("DUP-NAME");
    expect(second.status).toBe(409);
    expect(second.message).toBe('You already have a claude-code preset named "DUP-NAME"');
  });

  it("the same name on ANOTHER agent is not a collision", async () => {
    // The index is scoped to (user, harness): one "Dev" per agent is the
    // shape a user with several agents actually wants.
    expect((await createClaudePreset("cross-agent")).status).toBe(200);
    const res = await app.fetch(
      authedRequest("/api/presets", cookie, {
        method: "POST",
        body: JSON.stringify({ harnessId: "terminal", name: "cross-agent" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    createdPresetIds.push(body.id);
  });

  it("400s an id no plugin answers at all — getHarness still runs FIRST", async () => {
    const res = await app.fetch(
      authedRequest("/api/presets", cookie, {
        method: "POST",
        body: JSON.stringify({ harnessId: "no-such-plugin", name: "ghost" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("Unknown harness: no-such-plugin");
  });
});
