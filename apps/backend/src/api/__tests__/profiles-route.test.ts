import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { usableHarnessIds } from "@/api/harness-utils.js";
import { profileRoutes } from "@/api/profiles.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * Profile WRITES (POST /, PUT /:id, DELETE /:id) are cookie-only; reads stay
 * open to every authenticated actor (the agent toolset only ever GETs the
 * list — list_profiles).
 *
 * The regression these pin: a bearer key could create/update/delete the
 * owner's profiles, and profile.env OUTRANKS the SUBSHELL_* credential layer when
 * a subshell starts — rewriting the owner's default profile was a harvest path
 * for every future subshell's bearer token. Additionally, env var KEYS are
 * validated server-side on create and update (they reach the tmux start
 * command, so `X; touch /tmp/pwned #` is a shell-injection vector).
 */

const app = new Elysia().use(errorHandlerPlugin).use(profileRoutes);

const validBody = { harnessId: "claude-code", name: "writetest", env: { GOOD_KEY_1: "v" } };

describe("profile write routes (cookie only) + env name validation", () => {
  let userId: string;
  const email = `profw-${crypto.randomUUID()}@subshell.local`;
  const password = "profw-pass-1234";
  let cookie: string;
  let subshellKey: string;
  let systemKey: string;
  let subshellId: string;
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

    subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "profw-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    subshellKey = await issueSubshellToken(subshellId, userId);
    const row = await new SubshellsRepository(db).findById(subshellId);
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
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
    delete process.env.CLAUDE_PATH;
  });

  it("subshell token still reads the profile list (GET 200, envJson redacted)", async () => {
    const res = await app.fetch(bearerRequest("/api/profiles", subshellKey));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  // F2 (security audit 2026-08): reads stay open for list_profiles, but
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

    it("subshell bearer sees envJson=null but keeps flags/settings", async () => {
      const res = await app.fetch(bearerRequest("/api/profiles", subshellKey));
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

  it("subshell token cannot create, update, or delete (403, target untouched)", async () => {
    const post = await app.fetch(
      bearerRequest("/api/profiles", subshellKey, { method: "POST", body: JSON.stringify(validBody) }),
    );
    expect(post.status).toBe(403);

    // The exact attack: repoint the credential layer for future subshells.
    const put = await app.fetch(
      bearerRequest(`/api/profiles/${ownedId}`, subshellKey, {
        method: "PUT",
        body: JSON.stringify({ env: { SUBSHELL_API_KEY: "attacker" } }),
      }),
    );
    expect(put.status).toBe(403);
    expect((await repo.findById(ownedId))?.envJson).toBeNull();

    const del = await app.fetch(bearerRequest(`/api/profiles/${ownedId}`, subshellKey, { method: "DELETE" }));
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
        body: JSON.stringify({ env: { SUBSHELL_BASE_URL: "http://evil" } }),
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

describe("profile node pinning (spec 2026-08-31 §6.2, T15a)", () => {
  const app = new Elysia().use(errorHandlerPlugin).use(profileRoutes);
  const pw = "pin-pass-1234";
  const ownerEmail = `pin-owner-${crypto.randomUUID()}@subshell.local`;
  const nodes = new NodesRepository(db);
  const repo = new ProfilesRepository(db);
  let ownerId: string;
  let ownerCookie: string;
  let ownNodeId: string;
  let foreignNodeId: string;
  const createdProfileIds: string[] = [];
  const createdNodeIds: string[] = [];

  async function mkNode(ownerUserId: string): Promise<string> {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId, name: `pin-${id}`, kind: "agent", status: "offline" });
    createdNodeIds.push(id);
    return id;
  }

  async function mkProfile(name: string, nodeId?: string | null): Promise<string> {
    const id = crypto.randomUUID();
    createdProfileIds.push(id);
    await repo.create({
      id,
      userId: ownerId,
      harnessId: "claude-code",
      name,
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      restartOnExit: 0,
      ...(nodeId !== undefined ? { nodeId } : {}),
    });
    return id;
  }

  beforeAll(async () => {
    process.env.CLAUDE_PATH = "/bin/true";
    await setupAuthTables();
    ownerId = await new UsersRepository(db).createUser({
      email: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    await ensureLocalNode(db);
    ownNodeId = await mkNode(ownerId);
    // A private foreign node — invisible to the owner (no share, not theirs).
    foreignUserId = await new UsersRepository(db).createUser({
      email: `pin-foreign-${crypto.randomUUID()}@subshell.local`,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    foreignNodeId = await mkNode(foreignUserId);
  });

  let foreignUserId: string;

  afterAll(async () => {
    for (const id of createdProfileIds) await repo.delete(id);
    for (const id of createdNodeIds) await nodes.deleteById(id);
    await deleteUserByEmailOrId(foreignUserId);
    await deleteUserByEmailOrId(ownerEmail);
    delete process.env.CLAUDE_PATH;
  });

  function post(body: Record<string, unknown>, cookie = ownerCookie) {
    return app.fetch(authedRequest("/api/profiles", cookie, { method: "POST", body: JSON.stringify(body) }));
  }
  function put(profileId: string, body: Record<string, unknown>, cookie = ownerCookie) {
    return app.fetch(
      authedRequest(`/api/profiles/${profileId}`, cookie, { method: "PUT", body: JSON.stringify(body) }),
    );
  }

  it("POST with a visible (owned) nodeId stores it and the response echoes it", async () => {
    const res = await post({ harnessId: "claude-code", name: "pin-create", nodeId: ownNodeId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; nodeId: string };
    createdProfileIds.push(body.id);
    expect(body.nodeId).toBe(ownNodeId);
    expect((await repo.findById(body.id))?.nodeId).toBe(ownNodeId);
  });

  it("GET (list) returns nodeId — pinned and unpinned rows", async () => {
    const pinned = await mkProfile("pin-list-pinned", ownNodeId);
    const loose = await mkProfile("pin-list-loose");
    const res = await app.fetch(authedRequest("/api/profiles", ownerCookie));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; nodeId: string | null }[];
    expect(rows.find((r) => r.id === pinned)?.nodeId).toBe(ownNodeId);
    expect(rows.find((r) => r.id === loose)?.nodeId).toBeNull();
  });

  it("PUT pins then unpins (null = any node) — round-trip through the row", async () => {
    const id = await mkProfile("pin-roundtrip");
    const pin = await put(id, { nodeId: ownNodeId });
    expect(pin.status).toBe(200);
    expect(((await pin.json()) as { nodeId: string }).nodeId).toBe(ownNodeId);

    const unpin = await put(id, { nodeId: null });
    expect(unpin.status).toBe(200);
    expect(((await unpin.json()) as { nodeId: string | null }).nodeId).toBeNull();
    expect((await repo.findById(id))?.nodeId).toBeNull();
  });

  it("pinning `local` works (Everyone/edit share makes it visible to all)", async () => {
    const res = await post({ harnessId: "claude-code", name: "pin-local", nodeId: "local" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; nodeId: string };
    createdProfileIds.push(body.id);
    expect(body.nodeId).toBe("local");
  });

  it("an invisible (private foreign) node → 404, both POST and PUT; the row keeps its old pin", async () => {
    const post = await app.fetch(
      authedRequest("/api/profiles", ownerCookie, {
        method: "POST",
        body: JSON.stringify({ harnessId: "claude-code", name: "pin-ghost", nodeId: foreignNodeId }),
      }),
    );
    expect(post.status).toBe(404);

    const id = await mkProfile("pin-keep", ownNodeId);
    const bad = await put(id, { nodeId: foreignNodeId });
    expect(bad.status).toBe(404);
    expect((await repo.findById(id))?.nodeId).toBe(ownNodeId); // untouched
  });

  it("an empty nodeId → 400 (malformed)", async () => {
    const res = await post({ harnessId: "claude-code", name: "pin-empty", nodeId: "" });
    expect(res.status).toBe(400);
  });
});

/**
 * `?node=any` (spec 2026-09-02 node-profile-pairing §4a): the new-subshell
 * form pairs profiles against EVERY node client-side, so it must see profiles
 * whose harness is off here. The default listing keeps its local gate —
 * mobile and the profiles page rely on the hiding.
 */
describe("GET /api/profiles — node=any", () => {
  let userId: string;
  let cookie: string;
  let profileId: string;
  const email = `profany-${crypto.randomUUID()}@subshell.local`;
  const password = "profany-pass-1234";
  const profiles = new ProfilesRepository(db);
  const plugins = new HarnessPluginsRepository(db);

  beforeAll(async () => {
    // claude-code must read as INSTALLED so the row's absence under the
    // default listing can only come from the disabled state (same technique
    // as the file's first describe).
    process.env.CLAUDE_PATH = "/bin/true";
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);
    profileId = (
      await profiles.create({
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
    await plugins.setEnabled("claude-code", false);
  });

  afterAll(async () => {
    // Restore the lazy-default state so sibling suites see the plugin's own
    // enabledByDefault again.
    await plugins.setEnabled("claude-code", true);
    await deleteUserByEmailOrId(email);
  });

  it("hides the disabled-harness profile without the param", async () => {
    const res = await app.fetch(authedRequest("/api/profiles", cookie));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).not.toContain(profileId);
  });

  it("returns it when node=any is passed", async () => {
    const res = await app.fetch(authedRequest("/api/profiles?node=any", cookie));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(profileId);
  });

  /**
   * `node` is a closed one-value set (t.Literal, spec 2026-09-02 §4a): a
   * misspelling must 400 loudly, never silently degrade to the local-filtered
   * list — the exact bug class the param exists to remove.
   */
  it("400s a node value outside {any} instead of silently filtering", async () => {
    for (const bad of ["ANY", "anyy", "mac-mini"]) {
      const res = await app.fetch(authedRequest(`/api/profiles?node=${bad}`, cookie));
      expect(res.status, `node=${bad}`).toBe(400);
    }
  });
});
