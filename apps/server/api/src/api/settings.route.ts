import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { isCookieAdmin } from "@/api/user-utils.js";
import { APP_BASE_URL, emergencyLoginArmed } from "@/constants.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
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
import { applyLockdown, lockdownEnabled, serverNodeName } from "@/services/lockdown.js";
import { expiryDays, PENDING_APPROVAL_EXPIRY_KEY } from "@/services/pending-approvals.js";
import { ALLOW_NODE_ENROLLMENT_KEY, registrationOpen } from "@/services/registration-gate.js";
import { autoFetchEnabled } from "@/services/releases.js";
import { ALLOW_SERVER_SUBSHELLS_KEY, serverSubshellsEnabled } from "@/services/server-as-node.js";
import { originRegistry } from "@/services/trusted-origins.js";
import { SERVER_VERSION } from "@/version.js";

/**
 * Ceiling for `pendingApprovalExpiryDays` (Task 10b, spec 2026-09-24 §6):
 * ten years of days. The floor is 0 (keep forever), which the sweep itself
 * defines; a hand-set value beyond a decade is indistinguishable from a
 * typo, and the sweep's consumer is a human queue, not an archive.
 */
const PENDING_APPROVAL_EXPIRY_MAX_DAYS = 3650;

/** The six settings an admin can WRITE, one shape shared by both schemas. */
const SettingsWriteSchema = t.Object({
  allowRegistrations: t.Boolean({ description: "Whether new users can register" }),
  allowNodeEnrollment: t.Boolean({
    description:
      "Whether a non-admin may mint a node setup key, and so add a machine to this instance. Absent means true: an instance that never set it is unchanged. Admins are unaffected.",
  }),
  allowServerSubshells: t.Boolean({
    description:
      "Whether the control-plane host runs subshells at all. Absent means true: an instance that never set it is unchanged. Off, NOTHING launches on the Server, admins included; running panes finish and the machine stays manageable everywhere else. Distinct from maintenance, which is temporary and kills panes",
  }),
  instanceName: t.String({
    minLength: 0,
    maxLength: INSTANCE_NAME_MAX,
    description:
      "Operator-chosen display name for this control plane; falls back to the host's own name when cleared. Names the instance for everyone signing in, so several planes are tellable apart",
  }),
  lockdown: t.Boolean({
    description:
      "Instance-wide emergency stop (absent means false). ON stops every running subshell and starts no new ones on any machine, admins and pane-to-pane launches included; clearing it restarts nothing. Every real flip, either direction, must carry the server's node name in `lockdownConfirm`; re-sending the current state asks nothing. Distinct from node maintenance, which is one machine, its owner, and mirrored onto it",
  }),
  // The expiry window behind the pending-approval sweep (spec 2026-09-24 §6).
  // The consumer is the hourly pass in `services/pending-approvals.ts`: it
  // deletes `pending` sign-ins whose clock is older than this number of days,
  // so this is how long an unactioned arrival waits before it is dropped.
  // `0` means those rows never expire. Absent means 30, and the GET answer is
  // the ANSWERED number (absent and corrupt rows both read 30) — the same
  // number the sweep will act on, never the raw row.
  pendingApprovalExpiryDays: t.Number({
    description:
      "Days an unactioned pending sign-in waits before the hourly expiry sweep deletes it; 0 means pending rows never expire. Absent means 30. Writes outside 0 to 3650 are refused; a stored row that is not a day count reads back as 30",
  }),
});

/**
 * The General page's read: what can be written, plus the confirmation name
 * its lockdown dialog must show (and therefore echo back verbatim).
 */
const SettingsSchema = t.Object({
  ...SettingsWriteSchema.properties,
  localNodeName: t.String({
    description:
      'The control-plane host\'s admin-chosen node name (default "Server") — what a lockdown ON is confirmed against, so the dialog and the route cannot disagree about a correctly typed name',
  }),
});

/**
 * The PATCH body: the writable fields plus the one write-only ritual.
 * Separate from the read schema on purpose — `localNodeName` is an input
 * nowhere, and a body that accepted it silently would be a lie the OpenAPI
 * page tells.
 */
const SettingsPatchSchema = t.Partial(
  t.Object({
    ...SettingsWriteSchema.properties,
    lockdownConfirm: t.String({
      description:
        "The server's node name, required to CHANGE lockdown in either direction and checked against the live node row — nothing is stored from it. Ignored when the body only re-sends the current state, which is a double-submit, not an act",
    }),
  }),
);

/** PATCH response: the read, plus what this act stopped, in the maintenance route's grammar. */
const SettingsPatchResponseSchema = t.Object({
  ...SettingsSchema.properties,
  stopped: t.Array(t.String(), {
    description: "Subshell ids retired by THIS PATCH's lockdown ON; empty unless it turned lockdown ON",
  }),
  failed: t.Optional(
    t.Array(t.String(), {
      description: "Ids whose kill failed — absent when clean, never []. A row here may still be running",
    }),
  ),
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
  // The home page's "nothing can launch" guidance reads it, and so does every
  // launch picker's reason — which makes it a fact about what a signed-in
  // person may DO, disclosed exactly as `allowNodeEnrollment` is: no secret,
  // no grant, and the admin's own refusal would name it anyway.
  allowServerSubshells: t.Boolean({
    description:
      "Whether the control-plane host runs subshells at all (absent means true). Off, no machine may launch there and the Subshells page points people at adding a node instead",
  }),
  // Lockdown drives the server-wide banner EVERY signed-in user sees, so it
  // must be readable by everyone signed in — the same disclosure rule as the
  // two flags above, and the refusal a launch meets already names it.
  lockdown: t.Boolean({
    description:
      "True while the instance is in lockdown: subshells are stopped and no new ones can be created anywhere (drives the server-wide banner; absent means false)",
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
  // Every address a browser may sign in from, which is what the "Subshell for
  // Mobile" picker offers a phone: appBaseUrl alone is ONE spelling, and the
  // useful one is rarely the one this browser is on (a laptop on loopback, a
  // phone on the tailnet). Read LIVE from the registry — a network a plugin
  // joined a minute ago is already here, no restart — and already
  // canonicalized there; re-deriving it in the client would be a second
  // implementation of the allowlist. The read also re-asks this machine's own
  // interfaces — this is the request made right before a phone is handed an
  // address, and a laptop that switched Wi-Fi must not offer the network it
  // left.
  //
  // This is a real widening, recorded in docs/security.md §3: any signed-in
  // caller, bearer keys included, learns this instance's other names.
  trustedOrigins: t.Array(t.String(), {
    description:
      "Origins a browser may sign in from, live: this instance's own addresses including its LAN interfaces on a wildcard bind, the operator's TRUSTED_ORIGINS extras, and the addresses of every enabled network plugin this host is joined to or published on (canonicalized); the addresses offered when installing Subshell on a phone",
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
      "Version of the SERVER app (apps/server/api package.json). Per-app, not instance-wide; the node and frontend version independently",
  }),
  // The enroll-UX honesty field: a binary-only server install ships an EMPTY
  // node-artifacts dir, so the Nodes dialog's install one-liner would 404 on
  // every machine (the exact bug this reports). Rides the shared public read
  // like serverVersion — 4 stat calls, and every signed-in page already
  // holds this payload.
  nodeArtifactTargets: t.Array(t.String(), {
    description:
      "Platform triples whose node binary is already ON DISK here, served under /api/downloads/node/* without a fetch; empty on a fresh binary-only install",
  }),
  // Whether an absent binary is a 404 or a download. With a release source
  // configured (the default) the missing targets above are fetched the first
  // time a machine asks, so the dialog must NOT warn about them — the warning
  // is for the air-gapped configuration, where it is still exactly true.
  nodeArtifactsAutoFetch: t.Boolean({
    description:
      "Whether this server downloads a missing node binary from the project's own GitHub release on first use (SUBSHELL_RELEASE_URL; empty disables it)",
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
      const allow = await registrationOpen(db);
      // The mobile dialog refetches this on open, and interfaces change
      // without an act to hook — this read is where a Wi-Fi switch lands.
      originRegistry().refreshLocal();
      return {
        allowRegistrations: allow,
        allowNodeEnrollment: await repo.get(ALLOW_NODE_ENROLLMENT_KEY, true),
        allowServerSubshells: await serverSubshellsEnabled(db),
        lockdown: await lockdownEnabled(db),
        instanceName: await resolveInstanceName(db),
        emergencyLoginActive: emergencyLoginArmed(),
        appBaseUrl: APP_BASE_URL,
        trustedOrigins: [...originRegistry().current()],
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
          "Settings readable by any SIGNED-IN user: the registration and node-enrollment flags, the emergency-login armed state, the instance name, its base URL and the origins a browser may sign in from, the viewerIsAdmin admin-nav signal (cookie-only), the server version and the node-artifact facts; anonymous callers get 401",
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
      const allow = await registrationOpen(db);
      return {
        allowRegistrations: allow,
        allowNodeEnrollment: await repo.get(ALLOW_NODE_ENROLLMENT_KEY, true),
        allowServerSubshells: await serverSubshellsEnabled(db),
        lockdown: await lockdownEnabled(db),
        instanceName: await resolveInstanceName(db),
        // The dialog shows this and echoes it back; the route re-checks it
        // against the live row, so a rename between read and PATCH costs the
        // admin a 400 naming the NEW name rather than a silent lockdown by
        // a stale confirmation.
        localNodeName: await serverNodeName(db),
        // The ANSWERED number (absent/corrupt read 30) — what the expiry
        // sweep will act on, so the Auth page cannot show a number the
        // sweep disagrees with.
        pendingApprovalExpiryDays: await expiryDays(db),
      } as const;
    },
    {
      response: SettingsSchema,
      detail: {
        operationId: "getSettings",
        tags: ["settings"],
        description:
          "Full settings (admin only, cookie session): the instance flags, the operator's name, the machine name a lockdown ON must be confirmed with, and the pending-approval expiry window as the sweep will answer it",
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
      // Lockdown validation is HOISTED above every write (review finding I2,
      // 2026-09-24): a PATCH refused for its confirmation must have changed
      // NOTHING, because a 400 is reasonably read as "nothing happened" and
      // the OpenAPI page advertises the compound body. One read answers both
      // the gate here and `expectFrom` below — no second world to be stale
      // against.
      const lockdownBefore = body.lockdown === undefined ? undefined : await lockdownEnabled(db);
      if (lockdownBefore !== undefined && body.lockdown !== lockdownBefore) {
        // A REAL flip in either direction (operator ruling 2026-09-24); a
        // re-send of the CURRENT state asks nothing — that is the dialog's
        // double-submit and a card mount echoing state, not an act.
        const expected = await serverNodeName(db);
        if ((body.lockdownConfirm ?? "").trim() !== expected) {
          // Naming what to type is safe here (the name rides every signed-in
          // node list already) and it is the whole remedy for a caller who
          // arrived at this PATCH without the dialog.
          throw new SettingsError("lockdown_confirm", `Type the machine name "${expected}" to confirm.`, 400);
        }
      }
      // The expiry-day count is validated in the same hoist position (a 400
      // means NOTHING happened, the lockdown finding's rule): an integer in
      // 0..3650. `Number.isInteger` rather than schema bounds because the
      // schema says `t.Number` — 2.5 must be refused by name, not rounded by
      // a downstream `days * MS_PER_DAY`.
      if (body.pendingApprovalExpiryDays !== undefined) {
        const days = body.pendingApprovalExpiryDays;
        if (!Number.isInteger(days) || days < 0 || days > PENDING_APPROVAL_EXPIRY_MAX_DAYS) {
          throw new SettingsError(
            "pending_expiry_days",
            `Pending expiry days must be a whole number from 0 to ${PENDING_APPROVAL_EXPIRY_MAX_DAYS}. Use 0 to keep pending approvals forever.`,
            400,
          );
        }
      }
      const repo = new SettingsRepository(db);
      if (body.allowRegistrations !== undefined) {
        // The answer lives on the E-mail provider row now (spec 2026-09-24
        // §2): this PATCH writes `registration_enabled` 1/0, and every read —
        // this route's own response included — answers through
        // `registrationOpen`, so a write that did not land cannot report
        // itself as a success. The row's existence is migration 0037's
        // guarantee (it seeds the E-mail door at upgrade time).
        const before = await registrationOpen(db);
        await new AuthProvidersRepository(db).update("email", {
          registrationEnabled: body.allowRegistrations ? 1 : 0,
        });
        // Audited on REAL flips only (best-effort like every audit call):
        // opening sign-up on a live instance is the step a scripted session
        // used to mint a throwaway admin (2026-09-03 deploy-bot incident),
        // and it left no trace. Admin-minted accounts go through POST
        // /api/users, which already audits `user.create`. The targetId keeps
        // spelling the legacy settings key — the trail's vocabulary for this
        // switch, so rows before and after the move read alike.
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
      if (body.allowServerSubshells !== undefined) {
        const before = await serverSubshellsEnabled(db);
        await repo.set(ALLOW_SERVER_SUBSHELLS_KEY, body.allowServerSubshells);
        // Audited on a REAL flip only, like its siblings. Turning it OFF
        // strands no pane (running subshells finish), but it stops every
        // launch on the host for every user at once — the trail should say
        // who moved the ground under them.
        if (before !== body.allowServerSubshells) {
          await audit({
            actorUserId: user.id,
            action: "settings.update",
            targetType: "settings",
            targetId: ALLOW_SERVER_SUBSHELLS_KEY,
            metadataJson: JSON.stringify({ from: before, to: body.allowServerSubshells }),
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
      if (body.pendingApprovalExpiryDays !== undefined) {
        // `from` is the previously ANSWERED number (absent/corrupt ⇒ 30), so
        // the trail reads as changes to what the sweep actually did, not to
        // whatever bytes the row happened to hold. Re-sending the current
        // value writes the row (it heals a corrupt one) but audits nothing —
        // the sibling idiom. No confirmation ritual: the blast radius is a
        // queue aging out, and nothing is stopped.
        const before = await expiryDays(db);
        await repo.set(PENDING_APPROVAL_EXPIRY_KEY, body.pendingApprovalExpiryDays);
        if (before !== body.pendingApprovalExpiryDays) {
          await audit({
            actorUserId: user.id,
            action: "settings.update",
            targetType: "settings",
            targetId: PENDING_APPROVAL_EXPIRY_KEY,
            metadataJson: JSON.stringify({ from: before, to: body.pendingApprovalExpiryDays }),
          });
        }
      }
      // Lockdown is the one write here that ACTS rather than records, so it
      // runs last — every other field is settled before the whole instance
      // goes down. Its CONFIRMATION was validated up top, above every write;
      // this half only performs. An echo of the current state never reaches
      // `applyLockdown` at all (review finding I1): the guard it carries is
      // for the race where another admin's flip lands between the read above
      // and this call, and the correct act there is none.
      let lockdownStopped: string[] = [];
      let lockdownFailed: string[] = [];
      if (body.lockdown !== undefined && lockdownBefore !== undefined && body.lockdown !== lockdownBefore) {
        const effects = await applyLockdown(db, {
          on: body.lockdown,
          expectFrom: lockdownBefore,
          actorUserId: user.id,
        });
        lockdownStopped = effects.stopped;
        lockdownFailed = effects.failed;
      }
      const allow = await registrationOpen(db);
      return {
        allowRegistrations: allow,
        allowNodeEnrollment: await repo.get(ALLOW_NODE_ENROLLMENT_KEY, true),
        allowServerSubshells: await serverSubshellsEnabled(db),
        lockdown: await lockdownEnabled(db),
        instanceName: await resolveInstanceName(db),
        localNodeName: await serverNodeName(db),
        pendingApprovalExpiryDays: await expiryDays(db),
        stopped: lockdownStopped,
        ...(lockdownFailed.length > 0 ? { failed: lockdownFailed } : {}),
      } as const;
    },
    {
      body: SettingsPatchSchema,
      response: SettingsPatchResponseSchema,
      detail: {
        operationId: "updateSettings",
        tags: ["settings"],
        description:
          "Updates settings (admin only, cookie session). Turning lockdown ON stops every running subshell (reported in `stopped`); changing it in either direction requires the server's node name in `lockdownConfirm`",
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
  readonly status: number;
  constructor(code: string, message: string, status = 403) {
    super(message);
    this.code = code;
    // 403 is every existing throw (authorization); the lockdown confirmation
    // is the first INPUT problem this route can have, and it is a 400.
    this.status = status;
  }
}
