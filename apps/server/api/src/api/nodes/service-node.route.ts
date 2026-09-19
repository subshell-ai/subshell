import { BackendErrorCodes } from "@internal/backend-errors";
import {
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NO_SERVICE,
  NODE_RESULT_NOT_SUPERVISED,
  NODE_SERVICE_DESTRUCTIVE,
  NODE_SERVICE_VERBS,
  type NodeServiceVerb,
} from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

const ServiceBodySchema = t.Object({
  verb: t.Union(
    NODE_SERVICE_VERBS.map((v) => t.Literal(v)),
    { description: "Which service-manager action to perform on the node" },
  ),
  force: t.Optional(
    t.Boolean({
      description: "Act even though the node's service definition would take live panes down",
    }),
  ),
});

const ServiceResponseSchema = t.Object({
  ok: t.Literal(true, { description: "The node accepted the verb" }),
  detail: t.Optional(t.String({ description: "The node's own words about what it did, when it said anything" })),
});

/**
 * The two verbs an `edit` grantee may not perform.
 *
 * Not a permission subtlety — a structural one. Every command reaches a node
 * over the NODE'S OWN socket, so the plane can never start a node that is
 * not running: `stop` and `uninstall` end the connection that would have
 * carried the verb undoing them. They are one-way from a browser, and only
 * someone with a shell on that machine can reverse them.
 *
 * So they sit where repointing sits: with the owner. An `edit` grantee is
 * trusted to interrupt a machine they were shared (restart comes back); making
 * it unreachable until somebody walks to it is a different act.
 */
const OWNER_ONLY_VERBS: readonly NodeServiceVerb[] = ["stop", "uninstall"];

/** One refusal, as an API code and a sentence a person can act on. */
interface Refusal {
  code: BackendErrorCodes;
  message: string;
}

/**
 * The node's refusal → an API code and message.
 *
 * Matched on `NodeRpcError.detail`, the node's `result.error` VERBATIM,
 * by equality against the protocol's own constants. Not on `err.message`,
 * which wraps that string in a sentence this module does not own — a
 * substring match there would silently change meaning the day that sentence
 * is reworded, and would also read "not supervised enough, honestly" as the
 * exact refusal. Anything unrecognized falls through to the generic
 * unreachable code rather than being guessed at.
 *
 * `paneSafety` decides the WORDING of the kills-panes refusal but never the
 * code: the node sends one string for both `kills` and `unknown`, because
 * its destructive verbs fail closed on a definition they could not read. Only
 * the plane knows which of the two it was, and telling someone their panes
 * WILL die when the truth is that nobody could tell is the kind of certainty
 * that makes a warning worth ignoring.
 */
function refusalFor(err: NodeRpcError, paneSafety: "keeps" | "kills" | "unknown" | undefined): Refusal {
  if (err.code === "offline") {
    return { code: BackendErrorCodes.NODE_OFFLINE, message: err.message };
  }
  if (err.code === "unsupported") {
    return {
      code: BackendErrorCodes.NODE_AGENT_TOO_OLD,
      message: "This node's binary predates the service command; update the node on that machine to drive it here",
    };
  }
  if (err.detail === NODE_RESULT_NOT_SUPERVISED) {
    return {
      code: BackendErrorCodes.NODE_NOT_SUPERVISED,
      message:
        "That node is not running under a service manager, so exiting it would stop it rather than restart it; restart it where it was started",
    };
  }
  if (err.detail === NODE_RESULT_NO_SERVICE) {
    return {
      code: BackendErrorCodes.NODE_NO_SERVICE,
      message:
        "That machine has no service definition installed, so there is nothing to start or stop; install one from here first",
    };
  }
  if (err.detail === NODE_RESULT_KILLS_PANES) {
    return {
      code: BackendErrorCodes.NODE_RESTART_KILLS_PANES,
      message:
        paneSafety === "unknown"
          ? "That node's service definition could not be read, so whether this keeps its running subshells is unknown; act anyway with force, or repair the definition on that machine"
          : "That node's service definition would close every subshell running on it; reinstall the definition on that machine, or act anyway with force",
    };
  }
  return { code: BackendErrorCodes.NODE_UNREACHABLE, message: err.message };
}

/**
 * `POST /api/nodes/:id/service` — drive an enrolled node's service manager
 * (spec 2026-09-12, node half § 5).
 *
 * One route for all five verbs, because they are one manager and one set of
 * refusals. `restart` is the verb this route used to BE: the node exits 0 and
 * its manager respawns it.
 *
 * Gate: cookie only, owner or `edit` (`nodeCanConfigure`, the same gate
 * re-check carries) — except {@link OWNER_ONLY_VERBS}, which are the owner's.
 * A `view` grantee may launch subshells here; driving the machine's daemon is
 * a configure act, and it interrupts everyone else's panes on that node rather
 * than only their own.
 *
 * No new trust: the plane already runs arbitrary launches on an enrolled node,
 * and the command travels the same signed channel as every other one. The
 * NODE decides — it refuses when its manager did not start it, when nothing
 * is installed, and (like `subshell service restart`) when its definition
 * would take live panes down without `force`.
 *
 * `local` → 400: the control-plane host manages itself through
 * `/api/admin/server/*`, which is a different act with a different gate.
 * Routing it through here would give a node's `edit` grantee a way to bounce —
 * or stop — the control plane.
 */
export const serviceNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/service",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node service control is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      // BEFORE the permission checks: `local` is a statement about the ROUTE,
      // not about the caller — a 403 would send someone looking for an owner
      // to ask, when this surface never applies to the control-plane host.
      if (gate.row.kind === "local") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "The control-plane host is managed from Server Settings, not as a node",
          }),
        );
      }
      if (!nodeCanConfigure(gate.access)) throw new ForbiddenError();
      // The one-way verbs are the owner's — see OWNER_ONLY_VERBS. Checked
      // against `access`, not `canManage`: the `local` exception that makes an
      // admin a manager is irrelevant here because `local` is refused outright
      // two lines down.
      if (OWNER_ONLY_VERBS.includes(body.verb) && gate.access !== "owner") throw new ForbiddenError();
      // `force` means "act even though live panes will die", so it is
      // meaningless on the two verbs that cannot end one. Refused rather than
      // ignored: a flag silently accepted where it does nothing is how a
      // caller learns it is noise, and then passes it where it is not.
      if (body.force === true && !NODE_SERVICE_DESTRUCTIVE.includes(body.verb)) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: `force is only meaningful for ${NODE_SERVICE_DESTRUCTIVE.join(", ")} — ${body.verb} cannot close a subshell`,
          }),
        );
      }
      // Read before sending: the connection is what carries the node's own
      // pane-safety report, and the command is about to take that socket down.
      const paneSafety = getLive(gate.row.id)?.agent?.runtime?.service.paneSafety;
      let detail: string | undefined;
      try {
        const answer = await sendCommand(
          gate.row.id,
          body.force ? { type: "service", verb: body.verb, force: true } : { type: "service", verb: body.verb },
        );
        // The manager's own words when it had any — `install` explaining where
        // it wrote, `stop` warning about what it took down. A person acting on
        // their own machine should read what the CLI would have printed.
        if (typeof answer === "string" && answer.trim().length > 0) detail = answer.trim().slice(0, 400);
      } catch (err) {
        if (err instanceof NodeRpcError) {
          const refusal = refusalFor(err, paneSafety);
          return status(409, apiErrorBody({ code: refusal.code, message: refusal.message }));
        }
        throw err;
      }
      await audit({
        actorUserId: user.id,
        action: "node.service",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ verb: body.verb, forced: body.force === true }),
      });
      return detail === undefined ? ({ ok: true } as const) : ({ ok: true, detail } as const);
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: ServiceBodySchema,
      response: {
        200: ServiceResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "nodeService",
        tags: ["nodes"],
        description:
          "Drive an enrolled node's service manager: start, stop, restart, install or uninstall (409 when offline, not supervised, nothing installed, too old, or pane-unsafe without force; stop and uninstall are owner-only)",
      },
    },
  );
