import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { apiErrorBody } from "@/api/api-error.js";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { apiModels } from "@/api/schemas/index.js";
import { audit } from "@/modules/audit.js";
import { nodeCanConfigure } from "@/modules/nodes/access.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { getLive } from "@/modules/nodes/node-registry.js";
import { NodeRpcError } from "@/modules/nodes/node-rpc.js";
import {
  claimHarnessUpdate,
  HarnessUpdateRefused,
  refuseHarnessUpdate,
  updateHarness,
} from "@/modules/plugins/harness-update.service.js";
import { ForbiddenError } from "@/shared/errors.js";

/** The wire code a refusal's carried status maps to (same pair as the install route). */
function codeForRefusalStatus(status: 400 | 404 | 409): BackendErrorCodes {
  if (status === 409) return BackendErrorCodes.EXISTS_ERROR;
  if (status === 404) return BackendErrorCodes.NOT_FOUND_ERROR;
  return BackendErrorCodes.INPUT_VALIDATION_ERROR;
}

/**
 * How often a silent update says something. A remote run sends no line frames
 * (its output arrives in the one terminal answer), and Bun closes a response
 * that writes nothing for 10 s — measured against Bun 1.4.4, which answers a
 * 12 s gap with ECONNRESET. Proxies have their own idle deadlines too, so the
 * beat is half Bun's window: two of them per close, without turning the
 * stream into chatter.
 */
const UPDATE_HEARTBEAT_MS = 5_000;

/**
 * `POST /api/nodes/:id/harnesses/:pluginId/update` — run one harness CLI's own
 * update line on the machine that holds it (issue #250).
 *
 * `local` runs it in this process and streams the command's own lines;
 * an enrolled node runs it through the signed `harness_update` command, so its
 * output arrives when the run ends. **Browser session only**, the same rule
 * `/api/nodes/:id/update` carries: a machine credential cannot order a package
 * manager run even with `nodes:configure`, and `local` is narrower still —
 * admin, because the line runs in the server's own process. On an enrolled
 * node the gate is `nodeCanConfigure`, the same rule the node's Re-check uses:
 * updating a tool changes the machine, so it cannot be a viewer's act.
 *
 * **The answer is NDJSON, not one JSON document**, for the same reason the
 * installer's is: a run that prints nothing for ten minutes must still hold
 * the connection open. Frames are `{type:"line", text}` (local output),
 * `{type:"waiting"}` (heartbeat), then exactly one
 * `{type:"done", ...HarnessUpdateResult}` or `{type:"error", message}`.
 * `done.ok:false` is a run that FAILED (the command ran and said no); a 4xx is
 * a refusal decided before the body opened and before anything ran.
 */
export const harnessUpdateRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/harnesses/:pluginId/update",
    async ({ params, user, actor, status }) => {
      requireCookieActor(actor, "Harness updates are restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!nodeCanConfigure(gate.access)) throw new ForbiddenError();
      // Running the line on the control-plane host is the install route's act,
      // and that route reserves it for an admin cookie because it is remote
      // code execution as the server's OS user. Update falls back to the same
      // installer line when a plugin declares no dedicated verb, so `local`
      // rides the same gate. `edit` is not enough: the seeded local node gives
      // Everyone/edit, which is a launch grant, not permission to run a vendor
      // script in the server process. Enrolled nodes keep the configure gate.
      if (gate.row.kind === "local" && !gate.isAdmin) throw new ForbiddenError();

      // REFUSALS ARE DECIDED BEFORE A BYTE IS STREAMED. Once the body opens
      // the status is 200 and cannot be taken back, so anything that answers
      // 4xx — an unknown plugin, one with no update path, a node with no live
      // socket — has to be settled here.
      const refusal = await refuseHarnessUpdate(params.pluginId);
      if (refusal) {
        return status(
          refusal.status,
          apiErrorBody({ code: codeForRefusalStatus(refusal.status), message: refusal.message }),
        );
      }
      // The live socket is authoritative, not the row's projection: a node
      // that just said `ready` is reachable the moment the registry knows,
      // whatever a status column still says. A HELD socket is deliberately
      // not enough — it predates this protocol and cannot run the command.
      if (gate.row.kind !== "local" && getLive(gate.row.id) === undefined) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_OFFLINE,
            message: `Node "${gate.row.id}" is offline. Wait for it to reconnect before updating.`,
          }),
        );
      }
      // Reserve the node's one update slot HERE, for the same reason: a
      // second press that lost the race inside the stream could only answer
      // an `error` frame over a 200. `updateHarness` releases this claim.
      const claim = claimHarnessUpdate(gate.row.id, params.pluginId);
      if (claim instanceof HarnessUpdateRefused) {
        return status(409, apiErrorBody({ code: BackendErrorCodes.EXISTS_ERROR, message: claim.message }));
      }

      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          /** One NDJSON frame. A closed stream (the page navigated) must not throw into the update. */
          const send = (frame: unknown) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
            } catch {
              // The reader is gone. The update carries on regardless — it is
              // changing this machine, and abandoning it because nobody is
              // watching would leave a half-installed CLI either way.
            }
          };
          const heartbeat = setInterval(() => send({ type: "waiting" }), UPDATE_HEARTBEAT_MS);
          heartbeat.unref?.();
          try {
            const result = await updateHarness(
              gate.row.id,
              params.pluginId,
              (line) => send({ type: "line", text: line }),
              claim,
            );
            await audit({
              actorUserId: user.id,
              action: "node.harness.update",
              targetType: "node",
              targetId: gate.row.id,
              metadataJson: JSON.stringify({
                pluginId: params.pluginId,
                ok: result.ok,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                timedOut: result.timedOut,
              }),
            });
            send({ type: "done", ...result });
          } catch (err) {
            // A refusal racing another press, or a node that dropped
            // mid-run. The status line is long gone, so this arrives as a
            // frame; a client that sees neither `done` nor `error` treats an
            // ended body as a failure too.
            const message =
              err instanceof HarnessUpdateRefused
                ? err.message
                : err instanceof Error
                  ? err.message
                  : "The update failed.";
            send({ type: "error", message });
            // Mirrors `/api/nodes/:id/update`'s unknown branch: a timeout or a
            // dropped socket may have happened after the node received the
            // command, and the node's own ten-minute budget keeps it running.
            // A spoken refusal (`failed`, `unsupported`) or a malformed answer
            // is not ambiguity about whether it ran, so only these two write
            // the unknown row. A pre-run refusal did nothing.
            if (err instanceof NodeRpcError && (err.code === "timeout" || err.code === "offline")) {
              await audit({
                actorUserId: user.id,
                action: "node.harness.update.unknown",
                targetType: "node",
                targetId: gate.row.id,
                metadataJson: JSON.stringify({ pluginId: params.pluginId }),
              });
            }
          } finally {
            clearInterval(heartbeat);
            // `updateHarness` releases the slot; doing it again is a no-op and
            // covers a stream that failed before reaching it.
            claim.release();
            // Closing a stream whose reader already cancelled throws, and this
            // finally runs after a ten-minute run: the page may be long gone.
            try {
              controller.close();
            } catch {
              // already closed or errored by the consumer
            }
          }
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          // Nothing between here and the page may hold these frames back.
          "cache-control": "no-store, no-transform",
          "x-accel-buffering": "no",
        },
      });
    },
    {
      params: t.Object({
        id: t.String({ description: "Node id" }),
        pluginId: t.String({ description: "Harness plugin id whose CLI to update" }),
      }),
      // NO typed 200: this route streams. The body is NDJSON — line/waiting
      // frames, then one `done` carrying the run's result (the same shape
      // `parseNodeHarnessUpdateResult` validates on the node path) or one
      // `error`.
      response: {
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "updateNodeHarness",
        tags: ["nodes"],
        description:
          "Runs one harness CLI's own update command on the machine that holds it (the control-plane host or an enrolled node). Browser sessions only; admin on the control-plane host, node configure on an enrolled node. STREAMS application/x-ndjson: {type:line,text} frames for local output, {type:waiting} heartbeats, then one terminal {type:done,...} carrying ok/exitCode/output/durationMs/timedOut or {type:error,message}. ok:false inside a done frame is a run that failed; a 4xx is a refusal decided before the body opened.",
      },
    },
  );
