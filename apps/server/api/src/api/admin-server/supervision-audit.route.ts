import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { collectDeploymentCached } from "@/services/server-deployment.js";

const SupervisionAuditBodySchema = t.Object({
  mode: t.Union([t.Literal("service"), t.Literal("app")], {
    description: "Which supervisor the machine is being moved to",
  }),
  autostart: t.Boolean({ description: "Whether the service is to be armed for login; read only when mode is service" }),
  force: t.Boolean({ description: "Whether the pane-safety refusal was overridden" }),
});

const SupervisionAuditViewSchema = t.Object({
  recorded: t.Boolean({ description: "Always true; the row is written before this answers" }),
});

/**
 * `POST /api/admin/server/supervision` — RECORD that an admin asked to change
 * who supervises this server. It changes nothing.
 *
 * **The act itself is not here and cannot be.** Moving between supervisors
 * leaves the server unreachable for a moment — an uninstall stops it, a
 * switch back stops the app's child — so the actor has to outlive the server,
 * which is the desktop app (`desktop_set_supervision`). This route exists
 * only so the act reaches the instance's audit trail, and it closes a real
 * asymmetry: `POST /api/admin/server/autostart` wrote a row for the SMALLER
 * change (arming login) while removing the service definition entirely wrote
 * none.
 *
 * **It is a record of intent, not proof of what happened.** Two limits, both
 * worth stating rather than glossing:
 *
 * - It is best-effort and it is the CALLER that posts it. Anything driving
 *   the Tauri command directly — including an XSS in this SPA, which is the
 *   threat the grant's accounting in `docs/security.md` names — simply skips
 *   it. It makes honest use legible; it is not a control.
 * - The row says what was ASKED. The chain that follows can fail halfway, and
 *   the machine's real state afterwards is what `GET /api/admin/server`
 *   reports, not this.
 *
 * Cookie-admin only, like every other route in this group: `requireAdmin`
 * refuses bearer actors, so a machine credential cannot write instance
 * history.
 */
export const supervisionAuditRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .post(
    "/supervision",
    async ({ body, user }) => {
      // The cached view: this is a record, and spawning the service manager
      // to decorate an audit row would make the cheapest route in the group
      // as expensive as the polled one.
      const from = collectDeploymentCached().service.manager;
      await audit({
        actorUserId: user.id,
        action: "server.supervision.request",
        targetType: "server",
        targetId: "service",
        metadataJson: JSON.stringify({ from, to: body.mode, autostart: body.autostart, force: body.force }),
      });
      return { recorded: true };
    },
    {
      body: SupervisionAuditBodySchema,
      response: { 200: SupervisionAuditViewSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse" },
      detail: {
        operationId: "recordServerSupervisionRequest",
        tags: ["admin"],
        description:
          "Record that an admin asked to change which supervisor runs this server. Changes nothing: the act runs in the Subshell Server desktop app, which is what outlives the server. Cookie-admin only; bearer keys are refused.",
      },
    },
  );
