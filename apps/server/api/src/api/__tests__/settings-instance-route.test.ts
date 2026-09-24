import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { settingsRoutes } from "@/api/settings.route.js";
import { instancePublicRoutes } from "@/api/settings-public.route.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { INSTANCE_NAME_KEY } from "@/services/instance-name.js";
import { localHostname } from "@/services/nodes/seed-local.js";
import { setupAuthTables } from "./helpers/auth-tables.js";

/**
 * `GET /api/settings/instance` is the app's first anonymous read outside the
 * first-run setup window, so both halves are pinned here: that it answers with
 * no credential at all, and that it answers with NOTHING BUT the three fields
 * the sign-in page renders — the name, the open provider doors, and whether
 * the E-mail door is open at all (spec 2026-09-24 §7).
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
    const body = (await res.json()) as { instanceName: string; providers: unknown[]; emailSignIn: boolean };
    expect(body.instanceName).toBe(localHostname());
    expect(Array.isArray(body.providers)).toBe(true);
    expect(typeof body.emailSignIn).toBe("boolean");
  });

  it("carries ONLY the instance name, the provider doors, and the E-mail flag", async () => {
    // The whole key set, not just these fields: this endpoint sits OUTSIDE
    // authGuard, so a field added here later would become anonymous silently.
    // The guarded /public payload carries viewerIsAdmin, appBaseUrl and
    // nodeArtifactTargets — none of which may ever appear here. Growing the
    // pin is itself the decision the spec (§7) makes: sign-in needs to know
    // WHICH doors to paint before anyone has a cookie.
    const body = (await (await app.fetch(anon("/api/settings/instance"))).json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["instanceName", "providers", "emailSignIn"]);
    const providers = body.providers as Record<string, unknown>[];
    for (const p of providers) expect(Object.keys(p)).toEqual(["id", "name", "kind"]);
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

  it("lists only open google/oidc doors, and reads emailSignIn off the E-mail row", async () => {
    // Membership is asserted around rows THIS test seeds (filtered by id),
    // never by comparing the whole list — the shared test DB can carry other
    // suites' doors, and the list is ordered by position, so a full-list
    // equality would be a cross-suite coordination nobody owns.
    const doors = new AuthProvidersRepository(db);
    const open = `si-open-${crypto.randomUUID().slice(0, 8)}`;
    const muted = `si-muted-${crypto.randomUUID().slice(0, 8)}`;
    await doors.create({ id: open, kind: "google", name: "Open door", position: 50 });
    await doors.create({ id: muted, kind: "oidc", name: "Muted door", position: 51, signInEnabled: 0 });
    try {
      const body = (await (await app.fetch(anon("/api/settings/instance"))).json()) as {
        providers: { id: string; name: string; kind: string }[];
        emailSignIn: boolean;
      };
      expect(body.providers.find((p) => p.id === open)).toEqual({ id: open, name: "Open door", kind: "google" });
      // signInEnabled = 0 (or enabled = 0, by the same filter) is invisible
      // pre-auth: the button must not appear for a door no one may use.
      expect(body.providers.some((p) => p.id === muted)).toBe(false);
      // The E-mail row is never listed as a provider button (it is the
      // password form) — and its switches answer through emailSignIn instead.
      expect(body.providers.some((p) => p.id === "email")).toBe(false);
      expect(body.emailSignIn).toBe(true);

      await doors.update("email", { signInEnabled: 0 });
      const closed = (await (await app.fetch(anon("/api/settings/instance"))).json()) as { emailSignIn: boolean };
      expect(closed.emailSignIn).toBe(false);
    } finally {
      await doors.update("email", { signInEnabled: 1, enabled: 1 });
      await doors.remove(open);
      await doors.remove(muted);
    }
  });

  it("reads emailSignIn TRUE when the E-mail row answers nothing", async () => {
    // The seed failed or a hand edit deleted the row — never hide the
    // password form because of OUR bookkeeping (§7).
    const deleted = await db.deleteFrom("authProviders").where("id", "=", "email").executeTakeFirst();
    void deleted;
    try {
      const body = (await (await app.fetch(anon("/api/settings/instance"))).json()) as { emailSignIn: boolean };
      expect(body.emailSignIn).toBe(true);
    } finally {
      await db
        .insertInto("authProviders")
        .values({ id: "email", kind: "email", name: "E-mail", position: 0, registrationEnabled: null })
        .execute();
    }
  });

  it("does not make the guarded settings routes anonymous", async () => {
    // The point of keeping this in its own module: mounting it must not lift
    // authGuard off its neighbour.
    expect((await app.fetch(anon("/api/settings"))).status).toBe(401);
    expect((await app.fetch(anon("/api/settings/public"))).status).toBe(401);
  });
});
