import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { autostartSeams } from "@/api/admin-server/autostart.route.js";
import { adminServerRoutes } from "@/api/admin-server/index.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import type { CliResult } from "@/service.js";
import type { DeploymentView } from "@/services/server-deployment.js";
import { authedRequest } from "../../__tests__/helpers/auth-tables.js";
import { type AdminServerFixture, bearerRequest, setupAdminServerFixture } from "./fixture.js";

const app = new Elysia().use(errorHandlerPlugin).use(adminServerRoutes);

function post(cookie: string, body: unknown): Request {
  return authedRequest("/api/admin/server/autostart", cookie, { method: "POST", body: JSON.stringify(body) });
}

const OK: CliResult = { code: 0, out: "subshell-server will start at login.\n", err: "" };

describe("POST /api/admin/server/autostart", () => {
  let fx: AdminServerFixture;
  const realDeployment = autostartSeams.deployment;
  const realApply = autostartSeams.apply;
  let base: DeploymentView;
  /** Every `setAutostart` call the route made, as the flag it was given. */
  let applied: boolean[] = [];

  /** The real view with the service facts forced to the case under test. */
  function viewWith(over: Partial<DeploymentView["service"]>): DeploymentView {
    return { ...base, service: { ...base.service, ...over } };
  }

  /** Count the audit rows for this action, so "wrote one" and "wrote none" are both assertable. */
  async function autostartEvents(): Promise<number> {
    const events = await new AuditRepository(db).listLatest(20);
    return events.filter((e) => e.action === "server.autostart.update").length;
  }

  beforeAll(async () => {
    fx = await setupAdminServerFixture("srv-autostart");
    base = realDeployment();
  });
  afterAll(async () => {
    await fx.cleanup();
  });
  beforeEach(() => {
    applied = [];
    autostartSeams.apply = (_deps, enabled) => {
      applied.push(enabled);
      return OK;
    };
  });
  afterEach(() => {
    autostartSeams.deployment = realDeployment;
    autostartSeams.apply = realApply;
  });

  it("arms login, answers the fresh view, and writes one audit row", async () => {
    autostartSeams.deployment = () => viewWith({ manager: "launchd", installed: true, enabled: false });
    const before = await autostartEvents();
    const res = await app.fetch(post(fx.adminCookie, { enabled: true }));
    expect(res.status).toBe(200);
    expect(applied).toEqual([true]);
    // The view comes back so a caller never has to re-fetch to see what it did.
    expect((await res.json()) as { service: unknown }).toHaveProperty("service");
    expect(await autostartEvents()).toBe(before + 1);
  });

  it("records what it changed FROM, which is the only half the caller did not send", async () => {
    autostartSeams.deployment = () => viewWith({ manager: "systemd", installed: true, enabled: true });
    await app.fetch(post(fx.adminCookie, { enabled: false }));
    const row = (await new AuditRepository(db).listLatest(20)).find((e) => e.action === "server.autostart.update");
    expect(JSON.parse(row?.metadataJson ?? "{}")).toEqual({ from: true, to: false });
  });

  it("a no-op writes nothing and audits nothing", async () => {
    autostartSeams.deployment = () => viewWith({ manager: "launchd", installed: true, enabled: true });
    const before = await autostartEvents();
    const res = await app.fetch(post(fx.adminCookie, { enabled: true }));
    expect(res.status).toBe(200);
    // Idempotent below, so this is about the TRAIL: a press that changed
    // nothing is not an act, and auditing it fills the log with non-events.
    expect(applied).toEqual([]);
    expect(await autostartEvents()).toBe(before);
  });

  it("409 AUTOSTART_UNAVAILABLE with nothing installed", async () => {
    autostartSeams.deployment = () => viewWith({ manager: "systemd", installed: false, enabled: null });
    const res = await app.fetch(post(fx.adminCookie, { enabled: true }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("AUTOSTART_UNAVAILABLE");
    expect(body.message).toContain("No service is installed");
    expect(applied).toEqual([]);
  });

  it("409 when the desktop app runs this server, naming what to do instead", async () => {
    autostartSeams.deployment = () => viewWith({ manager: "app", installed: false, enabled: false });
    const res = await app.fetch(post(fx.adminCookie, { enabled: true }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("AUTOSTART_UNAVAILABLE");
    // A refusal that names no remedy is a dead end; the app IS the remedy here.
    expect(body.message).toContain("start the app at login");
    expect(applied).toEqual([]);
  });

  it("409 when the manager would not say whether it starts at login", async () => {
    autostartSeams.deployment = () => viewWith({ manager: "systemd", installed: true, enabled: null });
    const res = await app.fetch(post(fx.adminCookie, { enabled: false }));
    expect(res.status).toBe(409);
    // `enabled: null` means the manager did not answer. Writing on top of that
    // would be acting on a guess about the state we are changing.
    expect(applied).toEqual([]);
  });

  it("500 carries the manager's own words when the write fails", async () => {
    autostartSeams.deployment = () => viewWith({ manager: "systemd", installed: true, enabled: false });
    autostartSeams.apply = () => ({ code: 1, out: "", err: "systemctl --user enable failed (exit 1): unit is masked" });
    const res = await app.fetch(post(fx.adminCookie, { enabled: true }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { message: string }).message).toContain("unit is masked");
  });

  it("bearer 403, non-admin 403, and neither writes anything", async () => {
    autostartSeams.deployment = () => viewWith({ manager: "launchd", installed: true, enabled: false });
    const asBearer = await app.fetch(
      bearerRequest("/api/admin/server/autostart", fx.bearer, { method: "POST", body: '{"enabled":true}' }),
    );
    expect(asBearer.status).toBe(403);
    expect((await app.fetch(post(fx.userCookie, { enabled: true }))).status).toBe(403);
    expect(applied).toEqual([]);
  });
});
