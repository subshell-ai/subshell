import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { settingsRoutes } from "@/api/settings.route.js";
import { instancePublicRoutes } from "@/api/settings-public.route.js";
import { db } from "@/db/index.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { INSTANCE_NAME_KEY } from "@/services/instance-name.js";
import { localHostname } from "@/services/nodes/seed-local.js";
import { setupAuthTables } from "./helpers/auth-tables.js";

/**
 * `GET /api/settings/instance` is the app's first anonymous read outside the
 * first-run setup window, so both halves are pinned here: that it answers with
 * no credential at all, and that it answers with NOTHING BUT the name.
 */
const app = new Elysia().use(errorHandlerPlugin).use(instancePublicRoutes).use(settingsRoutes);

function anon(path: string): Request {
  return new Request(`http://localhost:3080${path}`);
}

describe("GET /api/settings/instance (anonymous)", () => {
  beforeAll(async () => {
    await setupAuthTables();
    await new SettingsRepository(db).delete(INSTANCE_NAME_KEY);
  });

  afterAll(async () => {
    await new SettingsRepository(db).delete(INSTANCE_NAME_KEY);
  });

  it("answers an anonymous caller with the host's own name when unset", async () => {
    const res = await app.fetch(anon("/api/settings/instance"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instanceName: localHostname() });
  });

  it("carries ONLY the instance name", async () => {
    // The whole key set, not just the one field: this endpoint sits OUTSIDE
    // authGuard, so a field added here later would become anonymous silently.
    // The guarded /public payload carries viewerIsAdmin, appBaseUrl and
    // nodeArtifactTargets — none of which may ever appear here.
    const body = (await (await app.fetch(anon("/api/settings/instance"))).json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["instanceName"]);
  });

  it("reflects a stored name with no restart", async () => {
    await new SettingsRepository(db).set(INSTANCE_NAME_KEY, "Renamed plane");
    const body = (await (await app.fetch(anon("/api/settings/instance"))).json()) as { instanceName: string };
    expect(body.instanceName).toBe("Renamed plane");
  });

  it("never emits control characters, even from a hand-edited row", async () => {
    await new SettingsRepository(db).set(INSTANCE_NAME_KEY, "Prod\r\nplane");
    const body = (await (await app.fetch(anon("/api/settings/instance"))).json()) as { instanceName: string };
    expect(body.instanceName).toBe("Prod plane");
  });

  it("does not make the guarded settings routes anonymous", async () => {
    // The point of keeping this in its own module: mounting it must not lift
    // authGuard off its neighbour.
    expect((await app.fetch(anon("/api/settings"))).status).toBe(401);
    expect((await app.fetch(anon("/api/settings/public"))).status).toBe(401);
  });
});
