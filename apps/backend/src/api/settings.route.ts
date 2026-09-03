import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { isCookieAdmin } from "@/api/user-utils.js";
import { APP_BASE_URL, emergencyLoginArmed } from "@/constants.js";
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
    description:
      "True while SUBSHELL_EMERGENCY_PASSWORD is set (break-glass admin login armed; drives the warning banner)",
  }),
  // Not a leak: the keyless `install.sh` usage script already embeds this exact
  // value, so it is public by construction. The Nodes dialog needs the SERVER's
  // view of its own address (not window.location.origin) because the install
  // command must be dialable from the remote machine, not from this browser.
  appBaseUrl: t.String({
    description:
      "Instance base URL the server bakes into rendered install commands (APP_BASE_URL); may point at loopback — a remote node must dial a reachable address",
  }),
  viewerIsAdmin: t.Boolean({
    description:
      "True when the caller is a signed-in admin via COOKIE session (drives the Server nav entry); bearer actors always read false",
  }),
});

/**
 * Settings endpoints (admin-cookie only for reads/writes; the public "allow
 * registrations" read is exposed so the login page can hide the sign-up
 * link). Bearer keys — subshell or system — are rejected with 403 even when
 * their owner is an admin: machine credentials cannot manage the instance.
 */
export const settingsRoutes = new Elysia({ prefix: "/api/settings" })
  .use(authGuard)
  .get(
    "/public",
    async ({ user, actor }) => {
      const repo = new SettingsRepository(db);
      const allow = await repo.get("allow_registrations", true);
      return {
        allowRegistrations: allow,
        emergencyLoginActive: emergencyLoginArmed(),
        appBaseUrl: APP_BASE_URL,
        // Cookie-admin rule in one place (user-utils): bearer actors read
        // false even when their owner is an admin.
        viewerIsAdmin: await isCookieAdmin(user, actor),
      } as const;
    },
    {
      response: PublicSettingsSchema,
      detail: {
        operationId: "getPublicSettings",
        tags: ["settings"],
        description:
          "Settings readable by any SIGNED-IN user (registration flag + emergency-login armed state + instance base URL + viewerIsAdmin admin-nav signal, cookie-only); anonymous callers get 401",
      },
    },
  )
  .get(
    "/",
    async ({ user, actor }) => {
      // The shared cookie-admin rule (user-utils): a bearer actor's synthetic
      // `user` is the subshell OWNER, so isAdmin alone would let an
      // admin-owned subshell token read instance settings. Machine
      // credentials cannot manage the instance.
      if (!(await isCookieAdmin(user, actor))) {
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
      // Same cookie+admin gate as GET / above: bearer keys (subshell or system)
      // never reach settings writes even when their owner is an admin.
      if (!(await isCookieAdmin(user, actor))) {
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
