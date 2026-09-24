import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { adminServerRoutes } from "@/api/admin-server/index.js";
import { restartSeams } from "@/api/admin-server/restart.route.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import type { DeploymentView } from "@/services/server-deployment.js";
import { authedRequest } from "../../__tests__/helpers/auth-tables.js";
import { type AdminServerFixture, bearerRequest, setupAdminServerFixture } from "./fixture.js";

const app = new Elysia().use(errorHandlerPlugin).use(adminServerRoutes);

/** POST the restart with an admin cookie and a JSON body. */
function post(cookie: string, body: unknown): Request {
  return authedRequest("/api/admin/server/restart", cookie, { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/admin/server/restart", () => {
  let fx: AdminServerFixture;
  const realDeployment = restartSeams.deployment;
  const realPerform = restartSeams.perform;
  let base: DeploymentView;
  let performed = 0;

  /** The real view with supervision and pane safety forced to the case under test. */
  function viewWith(over: { supervised: boolean; paneSafety: "keeps" | "kills" | "unknown" }): DeploymentView {
    return {
      ...base,
      service: { ...base.service, supervised: over.supervised, paneSafety: over.paneSafety },
      restart: { available: over.supervised, reason: over.supervised ? null : "not supervised" },
    };
  }

  beforeAll(async () => {
    fx = await setupAdminServerFixture("srv-restart");
    base = realDeployment();
  });
  afterAll(async () => {
    await fx.cleanup();
  });
  beforeEach(() => {
    performed = 0;
    restartSeams.perform = () => {
      performed++;
    };
  });
  afterEach(() => {
    restartSeams.deployment = realDeployment;
    restartSeams.perform = realPerform;
  });

  it("409 RESTART_UNAVAILABLE when not supervised, and nothing is scheduled", async () => {
    restartSeams.deployment = () => viewWith({ supervised: false, paneSafety: "keeps" });
    const res = await app.fetch(post(fx.adminCookie, {}));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("RESTART_UNAVAILABLE");
    expect(performed).toBe(0);
  });

  it("409 RESTART_KILLS_PANES without force; 202 with force", async () => {
    restartSeams.deployment = () => viewWith({ supervised: true, paneSafety: "kills" });
    const refused = await app.fetch(post(fx.adminCookie, {}));
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { code: string; message: string };
    expect(body.code).toBe("RESTART_KILLS_PANES");
    // A definition that ANSWERED `kills` is the one case the certain sentence
    // belongs to (the wording rule the node routes carry too).
    expect(body.message).toContain("would close every running subshell");
    expect(performed).toBe(0);
    const forced = await app.fetch(post(fx.adminCookie, { force: true }));
    expect(forced.status).toBe(202);
    expect(performed).toBe(1);
  });

  it("an unreadable definition says it could not be read — same code, no false certainty", async () => {
    // `unknown` shares the refusal CODE with `kills` (both stop without
    // `force`), but promising that panes WILL die about a unit nobody read is
    // the certainty that teaches operators to ignore warnings.
    restartSeams.deployment = () => viewWith({ supervised: true, paneSafety: "unknown" });
    const res = await app.fetch(post(fx.adminCookie, {}));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("RESTART_KILLS_PANES");
    expect(body.message).toMatch(/could not be read/i);
    expect(body.message).not.toMatch(/would close/i);
  });

  it("202 when supervised and pane-safe, with resumeAt and an audit row", async () => {
    restartSeams.deployment = () => viewWith({ supervised: true, paneSafety: "keeps" });
    const res = await app.fetch(post(fx.adminCookie, {}));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { restarting: boolean; resumeAt: string };
    expect(body.restarting).toBe(true);
    // The SAVED base URL, not the address this request arrived on: a caller
    // whose address is about to change needs to know where to look.
    expect(body.resumeAt.startsWith("http")).toBe(true);
    expect(performed).toBe(1);
    const events = await new AuditRepository(db).listLatest(5);
    expect(events.some((e) => e.action === "server.restart")).toBe(true);
  });

  it("bearer 403, non-admin 403, and neither restarts anything", async () => {
    restartSeams.deployment = () => viewWith({ supervised: true, paneSafety: "keeps" });
    const asBearer = await app.fetch(
      bearerRequest("/api/admin/server/restart", fx.bearer, { method: "POST", body: "{}" }),
    );
    expect(asBearer.status).toBe(403);
    expect((await app.fetch(post(fx.userCookie, {}))).status).toBe(403);
    expect(performed).toBe(0);
  });
});
