import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { ForbiddenError } from "@/api/auth-guard.js";
import { harnessInfo } from "@/api/harness-utils.js";
import { resolveSetupActor } from "@/api/setup.route.js";
import { IS_TEST } from "@/constants.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { resolveCookieSession } from "@/lib/session-cookie.js";
import { apiModels } from "@/schema/index.js";
import { type AgentInstallDeps, installBuiltInAgent, refuseInstall } from "@/services/agent-install.service.js";
import { audit } from "@/services/audit.js";
import { localPluginReports } from "@/services/nodes/local-plugins.js";

let depsOverride: AgentInstallDeps | undefined;

/**
 * Test seam: swap the installer's command lookup, timeout and PATH probe so
 * a test never spawns a login shell or shells out for a compiled-in plugin's
 * real install command. Refuses outside the suite, the same
 * `setHasUsersProbeForTests` pattern (`setup.route.ts`): a mis-wired
 * production import must not be able to redirect what this route runs on
 * the host.
 * @internal
 */
export function setAgentInstallDepsForTests(deps: AgentInstallDeps | null): void {
  if (!IS_TEST) throw new Error("setAgentInstallDepsForTests is a test-only seam");
  depsOverride = deps ?? undefined;
}

/**
 * The wire code a refusal's carried status maps to. Chosen to agree with
 * what the global error handler would assign a THROWN status-carrier of the
 * same status (`codeForStatus` in `error-handler.plugin.ts`: 400 -> BAD_REQUEST-
 * class validation, 409 -> EXISTS_ERROR) — the same pair `plugins.route.ts`'s
 * `HarnessStateError(…, 409)` resolves to once it reaches that handler. This
 * route answers via `status()` instead of throwing (so a caller sees the
 * refusal without an error-handler log line for what is expected input), and
 * the body must still describe the status it is attached to.
 */
function codeForRefusalStatus(status: 400 | 409): BackendErrorCodes {
  return status === 409 ? BackendErrorCodes.EXISTS_ERROR : BackendErrorCodes.INPUT_VALIDATION_ERROR;
}

/**
 * `POST /api/setup/agents/:pluginId/install` (spec 2026-09-11 § 7). Its own
 * module for the reason `settings-public.route.ts` is: the GATE differs from
 * the rest of `/api/setup`. Every other setup write is public while no user
 * exists, because the wizard runs before an admin exists — but THIS route is
 * never public: an unauthenticated caller on a fresh instance making the host
 * fetch and run a remote script is remote code execution, whatever the id
 * allowlist says. It requires an admin COOKIE session
 * ({@link resolveSetupActor} === "admin"); bearer keys 403 like every other
 * admin surface. This is safe for the wizard because the Add an Agent screen
 * runs AFTER Create Your Account, so the first person through already holds
 * that cookie.
 *
 * `ok: false` inside a 200 is a run that FAILED (the installer ran and said
 * no); a 4xx is a refusal before anything ran. `harness` is re-probed AFTER
 * the installer exits so one round trip reports both the run's log and the
 * new detection state.
 */
export const setupAgentInstallRoute = new Elysia({ prefix: "/api/setup/agents" }).use(apiModels).post(
  "/:pluginId/install",
  async ({ request, params, status }) => {
    if ((await resolveSetupActor(request)) !== "admin") throw new ForbiddenError();
    // REFUSALS ARE DECIDED BEFORE A BYTE IS STREAMED. Once the body opens the
    // status is 200 and cannot be taken back, so anything that answers 4xx —
    // an unknown id, one with no command, one already installing — has to be
    // settled here rather than discovered mid-stream.
    const refusal = await refuseInstall(params.pluginId, depsOverride);
    if (refusal) {
      return status(
        refusal.status,
        apiErrorBody({ code: codeForRefusalStatus(refusal.status), message: refusal.message }),
      );
    }

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        /** One NDJSON frame. A closed stream (the page navigated) must not throw into the installer. */
        const send = (frame: unknown) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
          } catch {
            // The reader is gone. The install carries on regardless — it is
            // changing this machine, and abandoning it half-done because
            // nobody is watching would be worse than finishing unobserved.
          }
        };
        try {
          const result = await installBuiltInAgent(params.pluginId, depsOverride, (line) =>
            send({ type: "line", text: line }),
          );
          // Best-effort actor id for the audit row; the gate above already
          // proved a valid admin cookie, so this just reads it back out.
          const actor = await resolveCookieSession(request.headers.get("cookie") ?? "");
          await audit({
            actorUserId: actor?.user.id ?? null,
            action: "agent.install",
            targetType: "plugin",
            targetId: params.pluginId,
            metadataJson: JSON.stringify({ ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs }),
          });
          const installedHere = (await localPluginReports()).some((r) => r.id === params.pluginId && !r.broken);
          send({ type: "done", ...result, harness: await harnessInfo(params.pluginId, installedHere) });
        } catch (err) {
          // The status line is long gone, so a failure has to arrive as a
          // FRAME. A client that sees neither `done` nor `error` before the
          // stream ends treats that as a failure too — see `use-install-agent`.
          send({ type: "error", message: err instanceof Error ? err.message : "The install failed." });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        // Nothing between here and the page may hold these frames back: the
        // whole point is that they arrive while the installer is still going.
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  },
  {
    params: t.Object({ pluginId: t.String({ description: "Built-in plugin id whose agent CLI to install" }) }),
    // NO typed 200: this route streams. The body is NDJSON — one
    // `{"type":"line","text":…}` per line the installer prints, then exactly
    // one `{"type":"done", …AgentInstallResult, harness}` or
    // `{"type":"error","message":…}`. `AgentInstallResultSchema` still
    // describes the `done` frame's payload and is where that shape lives; it
    // is simply no longer the shape of the whole body.
    response: {
      400: "ApiErrorResponse",
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      409: "ApiErrorResponse",
    },
    detail: {
      operationId: "installSetupAgent",
      tags: ["setup"],
      description:
        "Runs the official installer of one built-in agent CLI on the control-plane host, as the server's own user. Admin cookie only, never public, audited. STREAMS application/x-ndjson while it runs: a {type:line,text} per line of installer output, then one terminal {type:done,...} carrying ok/exitCode/output/harness, or {type:error,message}. ok:false inside a done frame is a run that failed; a 4xx is a refusal decided before the body opened and before anything ran.",
    },
  },
);
