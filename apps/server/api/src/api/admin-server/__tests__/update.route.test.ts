import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { adminServerRoutes } from "@/api/admin-server/index.js";
import { updateSeams } from "@/api/admin-server/update.route.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import type { ResolvedRelease } from "@/services/releases.js";
import { setReleaseUrlForTests } from "@/services/releases.js";
import type { DeploymentView } from "@/services/server-deployment.js";
import { resetUpdateJobForTests } from "@/services/server-update.js";
import { clearPending, updateDir } from "@/services/update-transaction.js";
import { SERVER_VERSION } from "@/version.js";
import { authedRequest } from "../../__tests__/helpers/auth-tables.js";
import { type AdminServerFixture, bearerRequest, setupAdminServerFixture } from "./fixture.js";

/**
 * `POST /api/admin/server/update` — the seven refusals, in the spec's order
 * (2026-09-15 §4.5), plus the actor-carrying audit row written before the job.
 *
 * The success path ENDS IN A PROCESS EXIT, so it is testable only through
 * `updateSeams`, exactly as the restart route's is through `restartSeams`. The
 * job itself is tested against a real fake release server in
 * `services/__tests__/server-update.test.ts`; what is asserted here is which
 * requests ever reach it.
 */

const app = new Elysia().use(errorHandlerPlugin).use(adminServerRoutes);

function post(cookie: string, body: unknown): Request {
  return authedRequest("/api/admin/server/update", cookie, { method: "POST", body: JSON.stringify(body) });
}

async function code(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code;
}

describe("POST /api/admin/server/update", () => {
  let fx: AdminServerFixture;
  let dir: string;
  let binary: string;
  let started: { to: string; forced: boolean }[] = [];
  const real = { ...updateSeams };
  let base: DeploymentView;

  /** The real deployment view with the two fields this route gates on forced. */
  function viewWith(over: { supervised: boolean; paneSafety: "keeps" | "kills" | "unknown" }): DeploymentView {
    return {
      ...base,
      service: { ...base.service, supervised: over.supervised, paneSafety: over.paneSafety },
      restart: { available: over.supervised, reason: over.supervised ? null : "not supervised" },
    };
  }

  /** A release the index would answer with; its assets are never fetched here. */
  function release(version: string): ResolvedRelease {
    return { tag: `server-v${version}`, version, assets: new Map(), manifest: null, manifestRead: true };
  }

  beforeAll(async () => {
    fx = await setupAdminServerFixture("srv-update");
    base = real.deployment();
  });
  afterAll(async () => {
    await fx.cleanup();
    setReleaseUrlForTests(null);
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subshell-update-route-"));
    binary = join(dir, "subshell-server");
    writeFileSync(binary, "binary", { mode: 0o755 });
    started = [];
    resetUpdateJobForTests();
    clearPending();
    // The happy configuration; each case narrows exactly one of these.
    setReleaseUrlForTests("http://127.0.0.1:1/releases");
    updateSeams.deployment = () => viewWith({ supervised: true, paneSafety: "keeps" });
    updateSeams.installed = () => ({ kind: "compiled", path: binary, source: "service definition" });
    updateSeams.release = async () => release("99.0.0");
    updateSeams.start = (input) => {
      started.push({ to: input.release.version, forced: input.forced });
    };
  });

  afterEach(() => {
    Object.assign(updateSeams, real);
    setReleaseUrlForTests(null);
    clearPending();
    resetUpdateJobForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("409 UPDATE_SOURCE_DISABLED first, before anything else is even asked", async () => {
    setReleaseUrlForTests("");
    // Also unsupervised and also a checkout: the source still wins, because it
    // is the one an operator fixes without touching the service manager.
    updateSeams.deployment = () => viewWith({ supervised: false, paneSafety: "kills" });
    const res = await app.fetch(post(fx.adminCookie, {}));
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("UPDATE_SOURCE_DISABLED");
    expect(started).toEqual([]);
  });

  it("409 RESTART_UNAVAILABLE when nothing would respawn this process", async () => {
    updateSeams.deployment = () => viewWith({ supervised: false, paneSafety: "keeps" });
    const res = await app.fetch(post(fx.adminCookie, {}));
    expect(await code(res)).toBe("RESTART_UNAVAILABLE");
    expect(started).toEqual([]);
  });

  it("409 UPDATE_BINARY_UNKNOWN for a checkout and for an unwritable path", async () => {
    updateSeams.installed = () => ({
      kind: "source",
      argv: ["/usr/bin/bun", "/repo/src/index.ts"],
      source: "service definition",
      reason: "this server runs from a checkout; update it with git",
    });
    expect(await code(await app.fetch(post(fx.adminCookie, {})))).toBe("UPDATE_BINARY_UNKNOWN");

    updateSeams.installed = () => ({
      kind: "compiled",
      path: join(dir, "nowhere", "subshell-server"),
      source: "service definition",
    });
    expect(await code(await app.fetch(post(fx.adminCookie, {})))).toBe("UPDATE_BINARY_UNKNOWN");
    expect(started).toEqual([]);
  });

  it("409 UPDATE_IN_PROGRESS when a marker is already on disk", async () => {
    // A CLI update started in a terminal leaves exactly this, which is why the
    // route reads the marker rather than only its own job.
    mkdirSync(updateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(updateDir(), "pending.json"),
      JSON.stringify({
        from: "1.0.0",
        to: "2.0.0",
        binary,
        previousBinary: `${binary}.previous`,
        backup: null,
        startedAt: new Date().toISOString(),
        origin: "cli",
        forced: false,
      }),
    );
    expect(await code(await app.fetch(post(fx.adminCookie, {})))).toBe("UPDATE_IN_PROGRESS");
    expect(started).toEqual([]);
  });

  it("409 UPDATE_NOT_AVAILABLE naming what IS published when `version` names something else", async () => {
    const res = await app.fetch(post(fx.adminCookie, { version: "98.0.0" }));
    expect(await code(res)).toBe("UPDATE_NOT_AVAILABLE");
    expect(started).toEqual([]);
  });

  it("409 UPDATE_NOT_AVAILABLE when the newest release is the running version", async () => {
    updateSeams.release = async () => release(SERVER_VERSION);
    expect(await code(await app.fetch(post(fx.adminCookie, {})))).toBe("UPDATE_NOT_AVAILABLE");
  });

  it("409 UPDATE_NOT_AVAILABLE, not a 500, when the release source cannot be read", async () => {
    updateSeams.release = async () => {
      throw new Error("could not read the releases from http://…");
    };
    expect(await code(await app.fetch(post(fx.adminCookie, {})))).toBe("UPDATE_NOT_AVAILABLE");
  });

  it("409 UPDATE_DOWNGRADE, with no force to override it", async () => {
    updateSeams.release = async () => release("0.0.1");
    expect(await code(await app.fetch(post(fx.adminCookie, {})))).toBe("UPDATE_DOWNGRADE");
    // The CLI has `--force` for this; the API deliberately does not.
    expect(await code(await app.fetch(post(fx.adminCookie, { force: true })))).toBe("UPDATE_DOWNGRADE");
    expect(started).toEqual([]);
  });

  it("409 RESTART_KILLS_PANES without force; 202 with it, and the job learns it was forced", async () => {
    updateSeams.deployment = () => viewWith({ supervised: true, paneSafety: "kills" });
    expect(await code(await app.fetch(post(fx.adminCookie, {})))).toBe("RESTART_KILLS_PANES");
    expect(started).toEqual([]);

    const forced = await app.fetch(post(fx.adminCookie, { force: true }));
    expect(forced.status).toBe(202);
    expect(started).toEqual([{ to: "99.0.0", forced: true }]);
  });

  it("202 with from/to, and an audit row naming the admin BEFORE the job", async () => {
    // Rows audited by the test above land in the same millisecond as this
    // one, and `listLatest` orders by time — so find the row THIS request
    // wrote, never "the first server.update".
    const seen = new Set((await new AuditRepository(db).listLatest(50)).map((e) => e.id));
    const res = await app.fetch(post(fx.adminCookie, {}));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: true, from: SERVER_VERSION, to: "99.0.0" });
    expect(started).toEqual([{ to: "99.0.0", forced: false }]);

    const events = await new AuditRepository(db).listLatest(50);
    const row = events.find((e) => e.action === "server.update" && !seen.has(e.id));
    expect(row).toBeDefined();
    // The START carries the actor; the boot-time COMPLETION audits again with
    // actor null, so the pair reads as "who asked" then "what happened".
    expect(row?.actorUserId).toBeTruthy();
    expect(JSON.parse(row?.metadataJson ?? "{}")).toMatchObject({ to: "99.0.0", origin: "api", forced: false });
  });

  it("refuses a bearer key and a non-admin cookie, and starts nothing", async () => {
    const asBearer = await app.fetch(
      bearerRequest("/api/admin/server/update", fx.bearer, { method: "POST", body: "{}" }),
    );
    expect(asBearer.status).toBe(403);
    expect((await app.fetch(post(fx.userCookie, {}))).status).toBe(403);
    expect(started).toEqual([]);
  });
});

describe("GET /api/admin/server/update", () => {
  let fx: AdminServerFixture;

  beforeAll(async () => {
    fx = await setupAdminServerFixture("srv-update-get");
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it("answers the whole view to an admin and 403s a bearer key", async () => {
    const res = await app.fetch(authedRequest("/api/admin/server/update", fx.adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The entire key set, the rule `GET /api/admin/server` carries: a field
    // added later is a decision rather than an accumulation.
    expect(Object.keys(body).sort()).toEqual(
      [
        "backups",
        "binary",
        "canApply",
        "current",
        "job",
        "lastFailure",
        "latest",
        "latestError",
        "paneSafety",
        "source",
        "updateAvailable",
      ].sort(),
    );
    expect(body.current).toBe(SERVER_VERSION);

    expect((await app.fetch(bearerRequest("/api/admin/server/update", fx.bearer))).status).toBe(403);
  });

  it("POST /update/check answers the same view and is admin-only", async () => {
    const res = await app.fetch(
      authedRequest("/api/admin/server/update/check", fx.adminCookie, { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { current: string }).current).toBe(SERVER_VERSION);
    expect(
      (await app.fetch(authedRequest("/api/admin/server/update/check", fx.userCookie, { method: "POST" }))).status,
    ).toBe(403);
  });
});
