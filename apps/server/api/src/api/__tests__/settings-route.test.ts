import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeArtifactFileName } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { settingsRoutes } from "@/api/settings.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { APP_BASE_URL, NODE_ARTIFACTS_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { localHostname } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { originRegistry } from "@/services/trusted-origins.js";
import { SERVER_VERSION } from "@/version.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * GET/PATCH /api/settings are admin-COOKIE routes.
 *
 * The regression these pin: authGuard maps a subshell token's `user` to its
 * OWNER, so an admin-owned subshell token used to pass `isAdmin(user)` and
 * read/write instance settings; and SettingsError carried no status, so every
 * denial surfaced as a 500 instead of a 403. Both gates are asserted here:
 * role (non-admin cookie -> 403) AND actor (any bearer -> 403, not 500).
 * `errorHandlerPlugin` is mounted so denials serialize like production.
 */

const app = new Elysia().use(errorHandlerPlugin).use(settingsRoutes);

/** Bearer-authenticated request against the settings routes. */
function bearerRequest(path: string, key: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`http://localhost:3080${path}`, { ...init, headers });
}

describe("settings routes (admin cookie only)", () => {
  let adminId: string;
  const adminEmail = `settings-admin-${crypto.randomUUID()}@subshell.local`;
  const adminPassword = "settings-admin-pass-1";
  let nonAdminId: string;
  const nonAdminEmail = `settings-user-${crypto.randomUUID()}@subshell.local`;
  const nonAdminPassword = "settings-user-pass-1";
  let adminCookie: string;
  let nonAdminCookie: string;
  let adminSubshellKey: string;
  let systemKey: string;
  let subshellId: string;
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    adminId = await users.createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      role: "admin",
    });
    nonAdminId = await users.createUser({
      email: nonAdminEmail,
      name: nonAdminEmail,
      passwordHash: await hashPassword(nonAdminPassword),
      role: "user",
    });
    adminCookie = await signIn(adminEmail, adminPassword);
    nonAdminCookie = await signIn(nonAdminEmail, nonAdminPassword);

    // A subshell OWNED BY THE ADMIN, with its real MCP token: the exact
    // credential that used to inherit the admin's settings rights.
    subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId: adminId,
      presetId: "p",
      harnessId: "claude-code",
      name: "settings-token-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    adminSubshellKey = await issueSubshellToken(subshellId, adminId);
    const row = await new SubshellsRepository(db).findById(subshellId);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);

    const created = (await getAuth().api.createApiKey({
      body: { name: "settings-sys-test", userId: await ensureSystemUser(), metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    systemKey = created.key;
  });

  afterAll(async () => {
    // Restore the instance-wide default this suite toggles, then drop fixtures.
    await new SettingsRepository(db).set("allow_registrations", true);
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await db.deleteFrom("userMeta").where("userId", "=", adminId).execute();
    await db.deleteFrom("userMeta").where("userId", "=", nonAdminId).execute();
    await deleteUserByEmailOrId(adminEmail);
    await deleteUserByEmailOrId(nonAdminEmail);
  });

  it("anonymous -> 401", async () => {
    expect((await app.fetch(new Request("http://localhost:3080/api/settings"))).status).toBe(401);
  });

  it("admin cookie reads and writes settings (200)", async () => {
    const get = await app.fetch(authedRequest("/api/settings", adminCookie));
    expect(get.status).toBe(200);
    const before = (await get.json()) as { allowRegistrations: boolean };
    expect(typeof before.allowRegistrations).toBe("boolean");

    const patch = await app.fetch(
      authedRequest("/api/settings", adminCookie, {
        method: "PATCH",
        body: JSON.stringify({ allowRegistrations: false }),
      }),
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { allowRegistrations: boolean }).allowRegistrations).toBe(false);

    const restore = await app.fetch(
      authedRequest("/api/settings", adminCookie, {
        method: "PATCH",
        body: JSON.stringify({ allowRegistrations: true }),
      }),
    );
    expect(restore.status).toBe(200);
    expect(((await restore.json()) as { allowRegistrations: boolean }).allowRegistrations).toBe(true);
  });

  it("admin cookie round-trips the instance name", async () => {
    const patch = await app.fetch(
      authedRequest("/api/settings", adminCookie, {
        method: "PATCH",
        body: JSON.stringify({ instanceName: "Prod plane" }),
      }),
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { instanceName: string }).instanceName).toBe("Prod plane");

    const get = await app.fetch(authedRequest("/api/settings", adminCookie));
    expect(((await get.json()) as { instanceName: string }).instanceName).toBe("Prod plane");

    // Cleared means "back to the default", not blank.
    const cleared = await app.fetch(
      authedRequest("/api/settings", adminCookie, { method: "PATCH", body: JSON.stringify({ instanceName: "" }) }),
    );
    expect(((await cleared.json()) as { instanceName: string }).instanceName).toBe(localHostname());
  });

  it("PATCH of the instance name audits a real change with from/to", async () => {
    // Identify this PATCH's event by what was there BEFORE it, never by
    // "newest": `createdAt` is a millisecond ISO string with no tiebreaker, so
    // the preceding test's clear-to-hostname PATCH can land in the same
    // millisecond and win an `ORDER BY createdAt DESC`. That made this case
    // fail intermittently with the HOSTNAME as the audited `to`.
    const idsBefore = new Set(
      (await db.selectFrom("auditEvents").select("id").where("targetId", "=", "instance_name").execute()).map(
        (e) => e.id,
      ),
    );

    await app.fetch(
      authedRequest("/api/settings", adminCookie, {
        method: "PATCH",
        body: JSON.stringify({ instanceName: "Audited plane" }),
      }),
    );

    const added = (
      await db.selectFrom("auditEvents").selectAll().where("targetId", "=", "instance_name").execute()
    ).filter((e) => !idsBefore.has(e.id));
    expect(added).toHaveLength(1);
    expect(added[0]?.actorUserId).toBe(adminId);
    expect(JSON.parse(String(added[0]?.metadataJson)).to).toBe("Audited plane");

    await app.fetch(
      authedRequest("/api/settings", adminCookie, { method: "PATCH", body: JSON.stringify({ instanceName: "" }) }),
    );
  });

  it("GET /public carries the instance name (the sidebar reads it on every route)", async () => {
    await app.fetch(
      authedRequest("/api/settings", adminCookie, {
        method: "PATCH",
        body: JSON.stringify({ instanceName: "Public plane" }),
      }),
    );
    const pub = await app.fetch(authedRequest("/api/settings/public", nonAdminCookie));
    expect(pub.status).toBe(200);
    expect(((await pub.json()) as { instanceName: string }).instanceName).toBe("Public plane");

    await app.fetch(
      authedRequest("/api/settings", adminCookie, { method: "PATCH", body: JSON.stringify({ instanceName: "" }) }),
    );
  });

  // The registration toggle was flipped on the LIVE instance by a scripted
  // session to mint a throwaway admin (the 2026-09-03 deploy-bot incident),
  // and the flip left no trace in audit_events. Every CHANGED write is now
  // audited; a no-change PATCH stays silent so the trail reads as flips.
  it("PATCH of allowNodeEnrollment audits real flips only, like its sibling", async () => {
    const patchTo = async (allowNodeEnrollment: boolean) => {
      const res = await app.fetch(
        authedRequest("/api/settings", adminCookie, {
          method: "PATCH",
          body: JSON.stringify({ allowNodeEnrollment }),
        }),
      );
      expect(res.status).toBe(200);
    };
    const clearEvents = async () =>
      await db
        .deleteFrom("auditEvents")
        .where("actorUserId", "=", adminId)
        .where("action", "=", "settings.update")
        .execute();

    await clearEvents();
    await patchTo(false);
    await patchTo(false); // no flip — must not add an event
    await patchTo(true);

    const events = await db
      .selectFrom("auditEvents")
      .select(["targetType", "targetId", "metadataJson"])
      .where("actorUserId", "=", adminId)
      .where("action", "=", "settings.update")
      .execute();
    expect(events.length).toBe(2);
    expect(events.map((e) => [e.targetType, e.targetId])).toEqual([
      ["settings", "allow_node_enrollment"],
      ["settings", "allow_node_enrollment"],
    ]);
    // Turning it ON widens who may bring a machine into this instance, and a
    // node is arbitrary command execution under its own OS user — so the
    // trail has to name who opened it, not just that something changed.
    expect(JSON.parse(events[0]?.metadataJson ?? "{}")).toEqual({ from: true, to: false });
    expect(JSON.parse(events[1]?.metadataJson ?? "{}")).toEqual({ from: false, to: true });
    await clearEvents();
  });

  it("reports allowNodeEnrollment as true with no row, on BOTH reads", async () => {
    await db.deleteFrom("settings").where("key", "=", "allow_node_enrollment").execute();
    // The absent-row default is what leaves an existing instance unchanged,
    // and it has to be the same answer everywhere — a page reporting "off"
    // while the route still admits non-admins is the disagreement this pins.
    const admin = await (await app.fetch(authedRequest("/api/settings", adminCookie))).json();
    expect((admin as { allowNodeEnrollment: boolean }).allowNodeEnrollment).toBe(true);
    const pub = await (await app.fetch(authedRequest("/api/settings/public", adminCookie))).json();
    expect((pub as { allowNodeEnrollment: boolean }).allowNodeEnrollment).toBe(true);
  });

  it("PATCH of allow_registrations audits every real flip with actor and from/to", async () => {
    const patchTo = async (allowRegistrations: boolean) => {
      const res = await app.fetch(
        authedRequest("/api/settings", adminCookie, {
          method: "PATCH",
          body: JSON.stringify({ allowRegistrations }),
        }),
      );
      expect(res.status).toBe(200);
    };

    // The shared DB carries events from earlier tests in this suite; start
    // from a clean slate so the count below is exactly this test's flips.
    await db
      .deleteFrom("auditEvents")
      .where("actorUserId", "=", adminId)
      .where("action", "=", "settings.update")
      .execute();

    await patchTo(false);
    await patchTo(false); // no flip — must not add an event
    await patchTo(true); // flip back

    const events = await db
      .selectFrom("auditEvents")
      .select(["action", "targetType", "targetId", "metadataJson"])
      .where("actorUserId", "=", adminId)
      .where("action", "=", "settings.update")
      .execute();
    expect(events.length).toBe(2);
    expect(events.map((e) => [e.targetType, e.targetId])).toEqual([
      ["settings", "allow_registrations"],
      ["settings", "allow_registrations"],
    ]);
    expect(JSON.parse(events[0]?.metadataJson ?? "{}")).toEqual({ from: true, to: false });
    expect(JSON.parse(events[1]?.metadataJson ?? "{}")).toEqual({ from: false, to: true });

    await db
      .deleteFrom("auditEvents")
      .where("actorUserId", "=", adminId)
      .where("action", "=", "settings.update")
      .execute();
  });

  it("non-admin cookie PATCH -> 403 with a 403 body (not the old statusless 500)", async () => {
    const res = await app.fetch(
      authedRequest("/api/settings", nonAdminCookie, {
        method: "PATCH",
        body: JSON.stringify({ allowRegistrations: false }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; statusCode: number };
    expect(body.code).toBe("ACCESS_DENIED");
    expect(body.statusCode).toBe(403);
    expect((await app.fetch(authedRequest("/api/settings", nonAdminCookie))).status).toBe(403);
  });

  it("admin-owned subshell token is rejected on GET and PATCH (403, not 500)", async () => {
    const get = await app.fetch(bearerRequest("/api/settings", adminSubshellKey));
    expect(get.status).toBe(403);
    const patch = await app.fetch(
      bearerRequest("/api/settings", adminSubshellKey, {
        method: "PATCH",
        body: JSON.stringify({ allowRegistrations: false }),
      }),
    );
    expect(patch.status).toBe(403);
    const body = (await patch.json()) as { code: string; statusCode: number };
    expect(body.code).toBe("ACCESS_DENIED");
    expect(body.statusCode).toBe(403);
    // The setting is untouched: the denial was real, not a serialization mask.
    const now = await new SettingsRepository(db).get("allow_registrations", true);
    expect(now).toBe(true);
  });

  it("system key is rejected on GET and PATCH (403)", async () => {
    expect((await app.fetch(bearerRequest("/api/settings", systemKey))).status).toBe(403);
    expect(
      (
        await app.fetch(
          bearerRequest("/api/settings", systemKey, {
            method: "PATCH",
            body: JSON.stringify({ allowRegistrations: false }),
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("public GET stays as-is (no admin/cookie gate added)", async () => {
    // /public is the registration-visibility read at the top of the file; the
    // fix must not touch it: it keeps answering through authGuard (401 for
    // anonymous today) and 200 for any authenticated actor, bearer included.
    const anon = await app.fetch(new Request("http://localhost:3080/api/settings/public"));
    expect(anon.status).toBe(401);
    const viaSubshellKey = await app.fetch(bearerRequest("/api/settings/public", adminSubshellKey));
    expect(viaSubshellKey.status).toBe(200);
  });

  it("GET /public reports emergencyLoginActive around the env var", async () => {
    // /public answers behind authGuard (401 anonymous — pinned by the test
    // above), so the flag reads go out with the admin cookie; the banner's
    // real caller is always a signed-in user anyway.
    type Public = { allowRegistrations: boolean; emergencyLoginActive: boolean };
    const saved = process.env.SUBSHELL_EMERGENCY_PASSWORD;
    const get = async () =>
      (await (
        await app.fetch(
          new Request("http://localhost:3080/api/settings/public", {
            headers: { cookie: `better-auth.session_token=${adminCookie}` },
          }),
        )
      ).json()) as Public;
    try {
      delete process.env.SUBSHELL_EMERGENCY_PASSWORD;
      const off = await get();
      expect(off.emergencyLoginActive).toBe(false);
      process.env.SUBSHELL_EMERGENCY_PASSWORD = "armed-for-test";
      const on = await get();
      expect(on.emergencyLoginActive).toBe(true);
      expect(on.allowRegistrations).toBe(off.allowRegistrations);
      // Whitespace-only must read as DISARMED (the hatch itself refuses to
      // arm on it — a " " break-glass password is no password).
      process.env.SUBSHELL_EMERGENCY_PASSWORD = "   ";
      expect((await get()).emergencyLoginActive).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SUBSHELL_EMERGENCY_PASSWORD;
      else process.env.SUBSHELL_EMERGENCY_PASSWORD = saved;
    }
  });

  it("GET /public reports appBaseUrl === APP_BASE_URL (Nodes dialog renders the install command from it)", async () => {
    // Spec 2026-08-31 Phase 3: the dialog must bake the SERVER-side base URL,
    // not window.location.origin — the browser may reach the instance through
    // a name the node cannot dial. The value is already public: the keyless
    // install.sh usage script embeds the same constant.
    const res = await app.fetch(authedRequest("/api/settings/public", adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      allowRegistrations: boolean;
      emergencyLoginActive: boolean;
      appBaseUrl: string;
    };
    expect(body.appBaseUrl).toBe(APP_BASE_URL);
  });

  it("GET /public reports trustedOrigins === the live registry, to any signed-in caller", async () => {
    // The "Subshell for Mobile" picker needs every address a browser may sign
    // in from, because the one it should show a phone is usually NOT the one
    // this desktop is browsing: a laptop on loopback, a phone on the tailnet.
    // Asserting against the registry rather than a literal is what keeps the
    // two from drifting — the list is already canonicalized there
    // (URL.origin), and re-deriving it here would be a second implementation.
    //
    // NON-ADMIN on purpose: the widening this pins is that every signed-in
    // user reads the instance's other addresses (docs/security.md §3). An
    // admin-only assertion would still pass if a gate were added by accident.
    const res = await app.fetch(authedRequest("/api/settings/public", nonAdminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trustedOrigins: string[] };
    expect(body.trustedOrigins).toEqual([...originRegistry().current()]);
    // Canonical origins only: a trailing slash or a path here would be an
    // entry no browser's Origin header can equal.
    for (const origin of body.trustedOrigins) expect(new URL(origin).origin).toBe(origin);
  });

  it("GET /public reports an origin a network plugin just contributed, without a restart", async () => {
    originRegistry().setPluginOrigins("settings-route-test", ["http://100.64.0.9:3080"]);
    try {
      const res = await app.fetch(authedRequest("/api/settings/public", nonAdminCookie));
      const body = (await res.json()) as { trustedOrigins: string[] };
      expect(body.trustedOrigins).toContain("http://100.64.0.9:3080");
    } finally {
      originRegistry().clearPlugin("settings-route-test");
    }
  });

  it("GET /public reports serverVersion tracking package.json, not a literal", async () => {
    // The regression this pins is one that already happened next door:
    // /api/meta/status shipped a hardcoded "1.0.0" and was still claiming it
    // at 1.5.0, because nothing compared the two. Asserting against
    // SERVER_VERSION (not a copied string) is what makes drift impossible —
    // a literal here would pass happily while both went stale together.
    const res = await app.fetch(authedRequest("/api/settings/public", adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { serverVersion: string };
    expect(body.serverVersion).toBe(SERVER_VERSION);
    expect(body.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("GET /public reports nodeArtifactTargets from the artifacts dir (Nodes dialog honesty)", async () => {
    // The bug this field fixes: a binary-only server install serves install.sh
    // but its node-artifacts dir is EMPTY, so the one-liner 404s every
    // machine. The dialog reads this list instead of guessing. Membership is
    // asserted around a REAL file write, never exact equality — the
    // downloads-route suite writes fixtures into the same per-process dir,
    // and the empty-file arm pins artifactStat's published rule (a zero-
    // length artifact is unpublished, so the list must not claim it).
    const read = async (): Promise<string[]> => {
      const res = await app.fetch(authedRequest("/api/settings/public", adminCookie));
      expect(res.status).toBe(200);
      return ((await res.json()) as { nodeArtifactTargets: string[] }).nodeArtifactTargets;
    };
    mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
    const path = join(NODE_ARTIFACTS_DIR, nodeArtifactFileName("darwin-arm64"));
    try {
      rmSync(path, { force: true });
      expect(await read()).not.toContain("darwin-arm64");
      writeFileSync(path, "");
      expect(await read()).not.toContain("darwin-arm64");
      writeFileSync(path, "binary-bytes");
      expect(await read()).toContain("darwin-arm64");
    } finally {
      rmSync(path, { force: true });
    }
  });

  /**
   * `viewerIsAdmin` (spec 2026-09-02 settings-split §5): the ONE client-side
   * admin signal for the Server nav entry. Cookie humans get the truth;
   * bearer actors (whose synthetic user is the subshell OWNER — possibly an
   * admin) must read false: a machine token must not paint admin chrome.
   */
  it("GET /public reports viewerIsAdmin per actor+role", async () => {
    const admin = (await (await app.fetch(authedRequest("/api/settings/public", adminCookie))).json()) as {
      viewerIsAdmin: boolean;
    };
    expect(admin.viewerIsAdmin).toBe(true);

    const user = (await (await app.fetch(authedRequest("/api/settings/public", nonAdminCookie))).json()) as {
      viewerIsAdmin: boolean;
    };
    expect(user.viewerIsAdmin).toBe(false);

    const bearer = await app.fetch(bearerRequest("/api/settings/public", adminSubshellKey));
    expect(bearer.status).toBe(200);
    expect(((await bearer.json()) as { viewerIsAdmin: boolean }).viewerIsAdmin).toBe(false);
  });
});

/**
 * GET/PATCH /api/settings/terminal-history — the per-USER terminal attach
 * history cap that replaced the per-subshell dialog (spec 2026-09-03
 * close-vocabulary design §2). Self-service (ANY cookie user, no admin),
 * cookie-actor-only, per-user storage in `user_meta`.
 */
describe("/api/settings/terminal-history (per-user, cookie only)", () => {
  const app = new Elysia().use(errorHandlerPlugin).use(settingsRoutes);
  const email = `term-hist-${crypto.randomUUID()}@subshell.local`;
  const pw = "term-hist-pass-1";
  let userId: string;
  let cookie: string;
  let subshellId: string;
  let apiKeyId: string | null = null;

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
    // A real subshell of THIS user, for the bearer-actor refusal below.
    subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "term-hist-token-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
  });

  afterAll(async () => {
    if (apiKeyId) authDatabase().run("DELETE FROM apikey WHERE id = ?", [apiKeyId]);
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
  });

  const get = () => app.fetch(authedRequest("/api/settings/terminal-history", cookie));
  const patch = (lines: unknown) =>
    app.fetch(
      authedRequest("/api/settings/terminal-history", cookie, {
        method: "PATCH",
        body: JSON.stringify({ lines }),
      }),
    );

  it("no stored preference reads as null (instance default)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { lines: number | null }).lines).toBeNull();
  });

  it("PATCH persists per-user and GET reads it back; null restores the default", async () => {
    expect(((await (await patch(150)).json()) as { lines: number | null }).lines).toBe(150);
    expect(((await (await get()).json()) as { lines: number | null }).lines).toBe(150);
    expect(await new UserMetaRepository(db).getTerminalReplayLines(userId)).toBe(150);

    expect(((await (await patch(null)).json()) as { lines: number | null }).lines).toBeNull();
    expect(await new UserMetaRepository(db).getTerminalReplayLines(userId)).toBeNull();
  });

  it("the cap is per-user: another user reads their own (null) preference", async () => {
    await patch(42);
    const otherEmail = `term-hist-other-${crypto.randomUUID()}@subshell.local`;
    const otherId = await new UsersRepository(db).createUser({
      email: otherEmail,
      name: otherEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    try {
      const otherCookie = await signIn(otherEmail, pw);
      const res = await app.fetch(authedRequest("/api/settings/terminal-history", otherCookie));
      expect(((await res.json()) as { lines: number | null }).lines).toBeNull();
    } finally {
      await db.deleteFrom("userMeta").where("userId", "=", otherId).execute();
      await deleteUserByEmailOrId(otherEmail);
      await patch(null);
    }
  });

  it("out-of-range and malformed values -> 400", async () => {
    for (const bad of [0, 201, -1, "42"]) {
      const res = await patch(bad);
      expect(res.status).toBe(400);
    }
  });

  it("bearer actors are refused (cookie self-service only)", async () => {
    const key = await issueSubshellToken(subshellId, userId);
    apiKeyId = (await new SubshellsRepository(db).findById(subshellId))?.apiKeyId ?? null;
    expect((await app.fetch(bearerRequest("/api/settings/terminal-history", key))).status).toBe(403);
    const res = await app.fetch(
      bearerRequest("/api/settings/terminal-history", key, {
        method: "PATCH",
        body: JSON.stringify({ lines: 50 }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("anonymous -> 401", async () => {
    expect((await app.fetch(new Request("http://localhost:3080/api/settings/terminal-history"))).status).toBe(401);
  });
});
