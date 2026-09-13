import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { isCookieAdmin } from "@/api/user-utils.js";
import { APP_BASE_URL, emergencyLoginArmed } from "@/constants.js";
import { db } from "@/db/index.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { publishedNodeTargets } from "@/lib/node-artifacts.js";
import { audit } from "@/services/audit.js";
import {
  INSTANCE_NAME_KEY,
  INSTANCE_NAME_MAX,
  resolveInstanceName,
  setInstanceName,
} from "@/services/instance-name.js";
import { autoFetchEnabled } from "@/services/node-release.js";
import { SERVER_VERSION } from "@/version.js";

/**
 * The `settings` row governing who may add a node.
 *
 * An ABSENT row means true, like `allow_registrations`: an instance that has
 * never touched this keeps the behaviour it had, where any signed-in user
 * could mint a setup key. Exported because `create-setup-key.route.ts` reads
 * the same row, and a second spelling of it would be a second setting.
 */
export const ALLOW_NODE_ENROLLMENT_KEY = "allow_node_enrollment";

const SettingsSchema = t.Object({
  allowRegistrations: t.Boolean({ description: "Whether new users can register" }),
  allowNodeEnrollment: t.Boolean({
    description:
      "Whether a non-admin may mint a node setup key, and so add a machine to this instance. Absent means true: an instance that never set it is unchanged. Admins are unaffected.",
  }),
  instanceName: t.String({
    minLength: 0,
    maxLength: INSTANCE_NAME_MAX,
    description:
      "Operator-chosen display name for this control plane; falls back to the host's own name when cleared. Names the instance for everyone signing in, so several planes are tellable apart",
  }),
});

/**
 * Per-user terminal attach history cap (spec 2026-09-03 close-vocabulary
 * design): null = instance default (`SUBSHELL_TERMINAL_REPLAY_LINES`, 100).
 * Same 1–200 bounds the removed per-subshell route enforced — the ceiling is
 * a load guarantee, not a preference (see `replayLineCap`).
 */
const TerminalHistorySchema = t.Object({
  lines: t.Nullable(
    t.Number({
      minimum: 1,
      maximum: 200,
      description: "Trailing log lines a terminal replays on attach (1–200); null = instance default",
    }),
  ),
});

/** Public read gains the break-glass flag (spec 2026-08-31 §6) — it leaks
 * only that the hatch is armed, which the banner itself broadcasts. */
const PublicSettingsSchema = t.Object({
  allowRegistrations: t.Boolean({ description: "Whether new users can register" }),
  // Read by the Nodes page, which hides "Add node" rather than offering a
  // button the route would refuse.
  allowNodeEnrollment: t.Boolean({
    description:
      "Whether a non-admin may mint a node setup key, and so add a machine to this instance. Absent means true: an instance that never set it is unchanged. Admins are unaffected.",
  }),
  // Rides the shared public read like serverVersion — every signed-in page
  // already holds this payload, and the sidebar needs it on every route.
  instanceName: t.String({
    minLength: 0,
    maxLength: INSTANCE_NAME_MAX,
    description:
      "Operator-chosen display name for this control plane; falls back to the host's own name when cleared. Names the instance for everyone signing in, so several planes are tellable apart",
  }),
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
      "Instance base URL the server bakes into rendered install commands (APP_BASE_URL); may point at loopback; a remote node must dial a reachable address",
  }),
  viewerIsAdmin: t.Boolean({
    description:
      "True when the caller is a signed-in admin via COOKIE session (drives the Server nav entry); bearer actors always read false",
  }),
  // Rides the shared public read rather than earning its own request: every
  // signed-in page already holds this payload, and a version nobody can see
  // without an admin session is a version nobody quotes in a bug report.
  serverVersion: t.String({
    description:
      "Version of the SERVER app (apps/server/api package.json). Per-app, not instance-wide; the agent and frontend version independently",
  }),
  // The enroll-UX honesty field: a binary-only server install ships an EMPTY
  // node-artifacts dir, so the Nodes dialog's install one-liner would 404 on
  // every machine (the exact bug this reports). Rides the shared public read
  // like serverVersion — 4 stat calls, and every signed-in page already
  // holds this payload.
  nodeArtifactTargets: t.Array(t.String(), {
    description:
      "Platform triples whose agent binary is already ON DISK here, served under /api/downloads/node/* without a fetch; empty on a fresh binary-only install",
  }),
  // Whether an absent binary is a 404 or a download. With a release source
  // configured (the default) the missing targets above are fetched the first
  // time a machine asks, so the dialog must NOT warn about them — the warning
  // is for the air-gapped configuration, where it is still exactly true.
  nodeArtifactsAutoFetch: t.Boolean({
    description:
      "Whether this server downloads a missing agent binary from the project's own GitHub release on first use (SUBSHELL_NODE_RELEASE_URL; empty disables it)",
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
        allowNodeEnrollment: await repo.get(ALLOW_NODE_ENROLLMENT_KEY, true),
        instanceName: await resolveInstanceName(db),
        emergencyLoginActive: emergencyLoginArmed(),
        appBaseUrl: APP_BASE_URL,
        // Cookie-admin rule in one place (user-utils): bearer actors read
        // false even when their owner is an admin.
        viewerIsAdmin: await isCookieAdmin(user, actor),
        serverVersion: SERVER_VERSION,
        nodeArtifactTargets: publishedNodeTargets(),
        nodeArtifactsAutoFetch: autoFetchEnabled(),
      } as const;
    },
    {
      response: PublicSettingsSchema,
      detail: {
        operationId: "getPublicSettings",
        tags: ["settings"],
        description:
          "Settings readable by any SIGNED-IN user (registration flag + emergency-login armed state + instance base URL + viewerIsAdmin admin-nav signal, cookie-only + server version); anonymous callers get 401",
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
      return {
        allowRegistrations: allow,
        allowNodeEnrollment: await repo.get(ALLOW_NODE_ENROLLMENT_KEY, true),
        instanceName: await resolveInstanceName(db),
      } as const;
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
        const before = await repo.get("allow_registrations", true);
        await repo.set("allow_registrations", body.allowRegistrations);
        // Audited on REAL flips only (best-effort like every audit call):
        // opening sign-up on a live instance is the step a scripted session
        // used to mint a throwaway admin (2026-09-03 deploy-bot incident),
        // and it left no trace. Admin-minted accounts go through POST
        // /api/users, which already audits `user.create`.
        if (before !== body.allowRegistrations) {
          await audit({
            actorUserId: user.id,
            action: "settings.update",
            targetType: "settings",
            targetId: "allow_registrations",
            metadataJson: JSON.stringify({ from: before, to: body.allowRegistrations }),
          });
        }
      }
      if (body.allowNodeEnrollment !== undefined) {
        const before = await repo.get(ALLOW_NODE_ENROLLMENT_KEY, true);
        await repo.set(ALLOW_NODE_ENROLLMENT_KEY, body.allowNodeEnrollment);
        // Audited on a REAL flip only, like the registration one. Turning it
        // ON widens who may bring a machine into this instance — and a node
        // is arbitrary command execution under its own OS user — so the trail
        // should say who opened it and when.
        if (before !== body.allowNodeEnrollment) {
          await audit({
            actorUserId: user.id,
            action: "settings.update",
            targetType: "settings",
            targetId: ALLOW_NODE_ENROLLMENT_KEY,
            metadataJson: JSON.stringify({ from: before, to: body.allowNodeEnrollment }),
          });
        }
      }
      if (body.instanceName !== undefined) {
        // Audited on a REAL change only, like the registration flip: the name
        // is what every user sees the instance called, so a silent edit by one
        // admin is worth a trace. The value is not a secret — it is disclosed
        // pre-auth by design — so it is safe to record both sides.
        const before = await resolveInstanceName(db);
        const after = await setInstanceName(db, body.instanceName);
        if (before !== after) {
          await audit({
            actorUserId: user.id,
            action: "settings.update",
            targetType: "settings",
            targetId: INSTANCE_NAME_KEY,
            metadataJson: JSON.stringify({ from: before, to: after }),
          });
        }
      }
      const allow = await repo.get("allow_registrations", true);
      return {
        allowRegistrations: allow,
        allowNodeEnrollment: await repo.get(ALLOW_NODE_ENROLLMENT_KEY, true),
        instanceName: await resolveInstanceName(db),
      } as const;
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
  )
  .get(
    "/terminal-history",
    async ({ user, actor }) => {
      // Self-service, not admin: the caller's OWN cap (cookie actor only —
      // the notifications-settings precedent). These endpoints live in this
      // module rather than a new route module on purpose: a fresh .use()
      // layer pushes the composed `App` type past its inference ceiling.
      requireCookieActor(actor, "Terminal history settings require a cookie session");
      return { lines: await new UserMetaRepository(db).getTerminalReplayLines(user.id) } as const;
    },
    {
      response: TerminalHistorySchema,
      detail: {
        operationId: "getTerminalHistorySettings",
        tags: ["settings"],
        description: "The caller's terminal attach history cap (null = instance default)",
      },
    },
  )
  .patch(
    "/terminal-history",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, "Terminal history settings require a cookie session");
      await new UserMetaRepository(db).setTerminalReplayLines(user.id, body.lines);
      return { lines: body.lines } as const;
    },
    {
      body: TerminalHistorySchema,
      response: TerminalHistorySchema,
      detail: {
        operationId: "updateTerminalHistorySettings",
        tags: ["settings"],
        description: "Set the caller's terminal attach history cap (1–200; null = instance default)",
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
