import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { isAdmin } from "@/api/user-utils.js";
import { emergencyPassword } from "@/constants.js";
import { db } from "@/db/index.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";

const SettingsSchema = t.Object({
  allowRegistrations: t.Boolean({ description: "Whether new users can register" }),
});

/** Public read gains the break-glass flag (spec 2026-08-31 §6) — it leaks
 * only that the hatch is armed, which the banner itself broadcasts. */
const PublicSettingsSchema = t.Object({
  allowRegistrations: t.Boolean({ description: "Whether new users can register" }),
  emergencyLoginActive: t.Boolean({
    description: "True while MOTE_EMERGENCY_PASSWORD is set (break-glass admin login armed; drives the warning banner)",
  }),
});

/**
 * Settings endpoints (admin-cookie only for reads/writes; the public "allow
 * registrations" read is exposed so the login page can hide the sign-up
 * link). Bearer keys — session or system — are rejected with 403 even when
 * their owner is an admin: machine credentials cannot manage the instance.
 */
export const settingsRoutes = new Elysia({ prefix: "/api/settings" })
  .use(authGuard)
  .get(
    "/public",
    async () => {
      const repo = new SettingsRepository(db);
      const allow = await repo.get("allow_registrations", true);
      return { allowRegistrations: allow, emergencyLoginActive: emergencyPassword() !== "" } as const;
    },
    {
      response: PublicSettingsSchema,
      detail: {
        operationId: "getPublicSettings",
        tags: ["settings"],
        description: "Public settings (registration open/closed)",
      },
    },
  )
  .get(
    "/",
    async ({ user, actor }) => {
      // Cookie-only admins, mirroring requireAdmin / users.route.ts: a bearer
      // actor's synthetic `user` is the session OWNER (auth-guard), so
      // isAdmin(user) alone would let an admin-owned session token read and
      // write instance settings. Machine credentials cannot manage the
      // instance.
      if (actor !== "cookie" || !(await isAdmin(user))) {
        throw new SettingsError("forbidden", "Admins only (cookie session)");
      }
      const repo = new SettingsRepository(db);
      const allow = await repo.get("allow_registrations", true);
      return { allowRegistrations: allow } as const;
    },
    {
      response: SettingsSchema,
      detail: {
        operationId: "getSettings",
        tags: ["settings"],
        description: "Full settings (admin only, cookie session)",
      },
    },
  )
  .patch(
    "/",
    async ({ body, user, actor }) => {
      // Same cookie+admin gate as GET / above: bearer keys (session or system)
      // never reach settings writes even when their owner is an admin.
      if (actor !== "cookie" || !(await isAdmin(user))) {
        throw new SettingsError("forbidden", "Admins only (cookie session)");
      }
      const repo = new SettingsRepository(db);
      if (body.allowRegistrations !== undefined) {
        await repo.set("allow_registrations", body.allowRegistrations);
      }
      const allow = await repo.get("allow_registrations", true);
      return { allowRegistrations: allow } as const;
    },
    {
      body: t.Partial(SettingsSchema),
      response: SettingsSchema,
      detail: {
        operationId: "updateSettings",
        tags: ["settings"],
        description: "Updates settings (admin only, cookie session)",
      },
    },
  );

/**
 * Route error with an HTTP status; the global error handler maps `status` to
 * the response code (same shape as `UsersError`). Without it every denial
 * surfaced as a 500 — every throw here is a 403 authorization failure.
 */
class SettingsError extends Error {
  readonly code: string;
  readonly status = 403;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
