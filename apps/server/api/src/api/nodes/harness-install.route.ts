import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { apiErrorBody } from "@/api/api-error.js";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { HARNESS_RUN_ERROR_MAX, HARNESS_RUN_HEARTBEAT_MS } from "@/api/nodes/harness-run-frames.js";
import { apiModels } from "@/api/schemas/index.js";
import { audit } from "@/modules/audit.js";
import { nodeCanConfigure } from "@/modules/nodes/access.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { getLive } from "@/modules/nodes/node-registry.js";
import { NodeRpcError } from "@/modules/nodes/node-rpc.js";
import { installHarnessOnNode, refuseHarnessInstall } from "@/modules/plugins/harness-install.service.js";
import { claimHarnessRun, HarnessRunRefused } from "@/modules/plugins/harness-run-lock.js";
import { ForbiddenError } from "@/shared/errors.js";

/**
 * `POST /api/nodes/:id/harnesses/:pluginId/install` — install one harness CLI
 * on the enrolled machine that will run it (issue #250 follow-up).
 *
 * The control-plane host is NOT served here. Its install runs in this process
 * through the setup screen's installer (`POST /api/setup/agents/:pluginId/install`),
 * an admin-cookie act on the server's own OS user, and this route answers 400
 * for `local` rather than opening a second gate onto the same line. What is
 * left is exactly the remote act: the signed `harness_install` command
 * (protocol 29) runs the plugin's installer line on the node, so the package
 * manager, the cross compile and the PATH are the node's, not the server's.
 *
 * **Browser session only**, the same rule the harness update route carries: a
 * machine credential cannot order a package manager run. The gate is
 * `nodeCanConfigure(gate.access)` — owner, `manage`, or `edit` — the same band
 * harness and node updates carry. Installing is not a stronger band in
 * practice: Update falls back to this same installer line at `edit`, so the
 * built-in-only rule below is what bounds what may run, and the distinct verb
 * keeps its own audit.
 *
 * **The answer is NDJSON, not one JSON document**, for the same reason the
 * update route's is: a run that prints nothing for ten minutes (the node's own
 * budget) must still hold the connection open. Frames are `{type:"waiting"}`
 * (heartbeat), then exactly one `{type:"done", ...NodeHarnessUpdateResult}` or
 * `{type:"error", message}`. `done.ok:false` is a run that FAILED (the installer
 * ran and said no); a 4xx is a refusal decided before the body opened and
 * before anything ran.
 */
export const harnessInstallRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/harnesses/:pluginId/install",
    async ({ params, user, actor, status }) => {
      requireCookieActor(actor, "Harness installs are restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      // The node's KIND is answered before any grant is weighed: the host's
      // install is the setup screen's act, and it is not made remote by asking
      // this route for it.
      if (gate.row.kind !== "agent") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
            message: "The control-plane host installs through the setup screen.",
          }),
        );
      }
      if (!nodeCanConfigure(gate.access)) throw new ForbiddenError();

      // REFUSALS ARE DECIDED BEFORE A BYTE IS STREAMED. Once the body opens the
      // status is 200 and cannot be taken back, so anything that answers 4xx —
      // an unknown plugin, one this build does not carry as a built-in, one
      // with no installer line, one this instance does not offer, a node with
      // no live socket — has to be settled here.
      const refusal = await refuseHarnessInstall(params.pluginId);
      if (refusal) {
        return status(
          refusal.status,
          apiErrorBody({
            // The two statuses this refusal carries; the wire code must
            // describe the status it is attached to.
            code: refusal.status === 404 ? BackendErrorCodes.NOT_FOUND_ERROR : BackendErrorCodes.INPUT_VALIDATION_ERROR,
            message: refusal.message,
          }),
        );
      }
      // The live socket is authoritative, not the row's projection: a node that
      // just said `ready` is reachable the moment the registry knows, whatever
      // a status column still says. A HELD socket is deliberately not enough —
      // it predates protocol 29 and cannot run the command.
      if (getLive(gate.row.id) === undefined) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_OFFLINE,
            message: `Node "${gate.row.id}" is offline. Wait for it to reconnect before installing.`,
          }),
        );
      }
      // Reserve the node's one harness-run slot HERE, for the same reason: a
      // second press that lost the race inside the stream could only answer an
      // `error` frame over a 200. `installHarnessOnNode` releases this claim,
      // and so does the stream's finally if the run never reached it.
      const claim = claimHarnessRun(gate.row.id, params.pluginId, "install");
      if (claim instanceof HarnessRunRefused) {
        return status(409, apiErrorBody({ code: BackendErrorCodes.EXISTS_ERROR, message: claim.message }));
      }

      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          /** One NDJSON frame. A closed stream (the page navigated) must not throw into the install. */
          const send = (frame: unknown) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
            } catch {
              // The reader is gone. The install carries on regardless — it is
              // changing this machine, and abandoning it because nobody is
              // watching would leave a half-installed CLI either way.
            }
          };
          const heartbeat = setInterval(() => send({ type: "waiting" }), HARNESS_RUN_HEARTBEAT_MS);
          heartbeat.unref?.();
          try {
            const result = await installHarnessOnNode(gate.row.id, params.pluginId, claim);
            await audit({
              actorUserId: user.id,
              action: "node.harness.install",
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
            // A refusal racing another press, a node that dropped mid-run, or a
            // malformed answer. The status line is long gone, so this arrives
            // as a frame; a client that sees neither `done` nor `error` treats
            // an ended body as a failure too.
            const message = err instanceof Error ? err.message : "The install failed.";
            const boundedMessage =
              message.length > HARNESS_RUN_ERROR_MAX ? `${message.slice(0, HARNESS_RUN_ERROR_MAX)}…` : message;
            send({ type: "error", message: boundedMessage });
            // A timeout or a dropped socket may have happened after the node
            // received the command, and the node's own ten-minute budget keeps
            // it running — so whether it ran is unknowable. A spoken refusal or
            // a malformed answer is not ambiguity about whether it ran, so only
            // these two write the unknown row. A pre-run refusal did nothing.
            if (err instanceof NodeRpcError && (err.code === "timeout" || err.code === "offline")) {
              await audit({
                actorUserId: user.id,
                action: "node.harness.install.unknown",
                targetType: "node",
                targetId: gate.row.id,
                metadataJson: JSON.stringify({ pluginId: params.pluginId }),
              });
            }
          } finally {
            clearInterval(heartbeat);
            // `installHarnessOnNode` releases the slot; doing it again is a
            // no-op and covers a stream that failed before reaching it.
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
        pluginId: t.String({ description: "Harness plugin id whose CLI to install" }),
      }),
      // NO typed 200: this route streams. The body is NDJSON — heartbeat frames,
      // then one `done` carrying the run's result (the same shape
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
        operationId: "installNodeHarness",
        tags: ["nodes"],
        description:
          "Installs one built-in harness CLI on an enrolled node by running its installer line through the signed harness_install command. Browser sessions only; the configure band on the node (owner, manage, or edit). The control-plane host is refused: its install runs through the setup screen. STREAMS application/x-ndjson: {type:waiting} heartbeats, then one terminal {type:done,...} carrying ok/exitCode/output/durationMs/timedOut or {type:error,message}. ok:false inside a done frame is a run that failed; a 4xx is a refusal decided before the body opened.",
      },
    },
  );
