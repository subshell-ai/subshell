import { withPluginOutput } from "@internal/pane-runtime";
import { Elysia, t } from "elysia";
import { ndjsonResponse } from "@/api/network/ndjson.js";
import {
  auditNetwork,
  configurationRefusal,
  invalidateNetworkStatus,
  prepareNetworkAct,
  readinessRefusal,
  readNetworkStatus,
  requireNetworkAdmin,
} from "@/api/network/network-gate.js";
import { NetworkParamsSchema } from "@/api/network/schemas.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";

const JoinBodySchema = t.Object(
  {
    credential: t.Optional(
      t.String({
        description:
          "A pre-authentication credential pasted by the operator. Absent asks for the interactive flow instead, which a plugin declaring interactiveLogin answers with a URL",
      }),
    ),
    hostname: t.Optional(
      t.String({ description: "What this machine should be called on the network. Defaults to its own hostname" }),
    ),
  },
  { description: "How to join: with a pasted credential, or interactively" },
);

/**
 * `POST /api/network/:id/join` (spec 2026-09-15 § 5.1).
 *
 * Streams NDJSON, because a join runs a vendor CLI that can sit for tens of
 * seconds and, in the interactive case, prints the URL a human has to open
 * while it is still running.
 *
 * **The credential's SHAPE is not pre-validated, and cannot be.** What a valid
 * pre-authentication key looks like is the vendor's business — the plugin's
 * `join` is what knows, and a malformed one makes it THROW. By then the body
 * is open and a 400 is impossible, so it arrives as an `error` frame. Every
 * refusal that CAN be decided up front is (the tmux route's rule): the gate,
 * the platform, the lock, the readiness state and the required settings all
 * answer before a byte of the body is written.
 *
 * **The credential never leaves this request.** It is not stored, not logged,
 * and not audited: the audit row records the MODE (`credential` or
 * `interactive`) and whether it worked. A test scans the serialized metadata
 * for the credential string.
 */
export const joinNetworkRoute = new Elysia().use(apiModels).post(
  "/:id/join",
  async ({ params, body, request, status }) => {
    await requireNetworkAdmin(request);
    const prepared = await prepareNetworkAct(params.id);
    if ("status" in prepared) {
      return status(prepared.status, apiErrorBody({ code: prepared.code, message: prepared.message }));
    }
    const { resolved, ctx, release } = prepared;
    const entry = resolved.entry;
    const id = entry.manifest.id;

    // Fresh, not memoised: this decides whether an act may run at all, and
    // a three-second-old answer is the wrong basis for that.
    const before = await readNetworkStatus(entry, ctx, { fresh: true });
    const refusal = readinessRefusal(before, entry.manifest.name) ?? configurationRefusal(entry, ctx);
    if (refusal) {
      release();
      return status(refusal.status, apiErrorBody({ code: refusal.code, message: refusal.message }));
    }

    const mode = body.credential ? "credential" : "interactive";
    return ndjsonResponse(async (send) => {
      send({ type: "line", text: `Joining ${entry.manifest.name}…` });
      try {
        // Wrapped so the vendor CLI's OWN output reaches this stream. Without
        // it the frames carry only this route's narration, which for a
        // `tailscale up` that takes half a minute is the least interesting
        // half of what is happening. The plugin's own `onLine` is untouched —
        // this tees.
        const outcome = await withPluginOutput(
          id,
          (text) => send({ type: "line", text }),
          () =>
            entry.plugin.join(
              {
                ...(body.credential !== undefined ? { credential: body.credential } : {}),
                ...(body.hostname !== undefined ? { hostname: body.hostname } : {}),
              },
              ctx,
            ),
        );
        invalidateNetworkStatus(id);
        const after = await readNetworkStatus(entry, ctx, { fresh: true });
        if (outcome.state === "needs-login") {
          send({ type: "line", text: `Open ${outcome.loginUrl} to finish signing in.` });
        }
        for (const hint of after.hints) send({ type: "line", text: hint.text });
        await auditNetwork(request, "network.join", id, { mode, ok: true });
        send({ type: "done", outcome, status: after });
      } catch (err) {
        // Audited BEFORE the rethrow, because the rethrow becomes the
        // terminal `error` frame and nothing after it runs. A failed join
        // is worth a row: it is an admin act on this machine either way.
        await auditNetwork(request, "network.join", id, { mode, ok: false });
        invalidateNetworkStatus(id);
        throw err;
      }
    }, release);
  },
  {
    params: NetworkParamsSchema,
    body: JoinBodySchema,
    // NO typed 200: this route streams. The body is NDJSON — a
    // {"type":"line","text":…} per step, then exactly one
    // {"type":"done","outcome":…,"status":…} or {"type":"error","message":…}.
    response: {
      400: "ApiErrorResponse",
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      404: "ApiErrorResponse",
      409: "ApiErrorResponse",
    },
    detail: {
      operationId: "joinNetwork",
      tags: ["network"],
      description:
        "Joins this host to the network, with a pasted credential or interactively (admin cookie only). STREAMS application/x-ndjson: {type:line,text} frames, then one {type:done,outcome,status} or {type:error,message}. A malformed credential is the plugin's own refusal and arrives as an error frame, because the body is already open by then. Audited as network.join with the mode and the outcome — never the credential.",
    },
  },
);
