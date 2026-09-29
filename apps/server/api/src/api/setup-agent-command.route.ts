import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { ForbiddenError } from "@/api/auth-guard.js";
import { harnessInfo } from "@/api/harness-utils.js";
import { resolveSetupActor } from "@/api/setup.route.js";
import { IS_TEST } from "@/constants.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { resolveCookieSession } from "@/lib/session-cookie.js";
import { apiModels } from "@/schema/index.js";
import {
  type AgentInstallDeps,
  type AgentInstallKind,
  refuseAgentCommand,
  runBuiltInAgentCommand,
} from "@/services/agent-install.service.js";
import { audit } from "@/services/audit.js";
import { localPluginReports } from "@/services/nodes/local-plugins.js";

/** The seam each kind runs against; a test installs one per kind, never both by accident. */
const depsOverrides = new Map<AgentInstallKind, AgentInstallDeps>();

/**
 * Test seam (install): swap the command lookup, timeout and PATH probe so a
 * test never spawns a login shell or shells out for a compiled-in plugin's
 * real command. Refuses outside the suite, the same `setHasUsersProbeForTests`
 * pattern (`setup.route.ts`): a mis-wired production import must not be able
 * to redirect what this route runs on the host.
 * @internal
 */
export function setAgentInstallDepsForTests(deps: AgentInstallDeps | null): void {
  if (!IS_TEST) throw new Error("setAgentInstallDepsForTests is a test-only seam");
  if (deps) depsOverrides.set("install", deps);
  else depsOverrides.delete("install");
}

/**
 * Test seam (update), twin of the above, and per-kind: the two kinds are set
 * independently because the cross-kind single-flight test gives them
 * different commands.
 * @internal
 */
export function setAgentUpdateDepsForTests(deps: AgentInstallDeps | null): void {
  if (!IS_TEST) throw new Error("setAgentUpdateDepsForTests is a test-only seam");
  if (deps) depsOverrides.set("update", deps);
  else depsOverrides.delete("update");
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
 * This module owns BOTH built-in agent commands on the install rails:
 * `POST /api/setup/agents/:pluginId/install` (spec 2026-09-11 § 7) and
 * `POST /api/setup/agents/:pluginId/update` (spec 2026-09-28 § 2). They are
 * one module because everything in the body except the kind word is one
 * protocol — the admin gate, the refusal decided before a byte streams, the
 * NDJSON framing, the audit row, the post-run harness re-probe — and two
 * copies of that protocol is exactly the drift the file ledger warns about.
 * The reason it is its OWN module remains the 2026-09-11 argument, and it
 * rules both endpoints: the GATE differs from the rest of `/api/setup`.
 * Every other setup write is public while no user exists, because the wizard
 * runs before an admin exists — but these are never public: an
 * unauthenticated caller on a fresh instance making the host fetch and run a
 * remote script is remote code execution, whatever the id allowlist says.
 * Each requires an admin COOKIE session ({@link resolveSetupActor} ===
 * "admin"); bearer keys 403 like every other admin surface. This is safe for
 * the wizard because the Add an Agent screen runs AFTER Create Your Account,
 * so the first person through already holds that cookie.
 */
function agentCommandEndpoint(kind: AgentInstallKind) {
  return new Elysia({ prefix: "/api/setup/agents" }).use(apiModels).post(
    `/:pluginId/${kind}`,
    async ({ request, params, status }) => {
      if ((await resolveSetupActor(request)) !== "admin") throw new ForbiddenError();
      // REFUSALS ARE DECIDED BEFORE A BYTE IS STREAMED. Once the body opens the
      // status is 200 and cannot be taken back, so anything that answers 4xx —
      // an unknown id, one with no command, one already running — has to be
      // settled here rather than discovered mid-stream.
      const refusal = await refuseAgentCommand(params.pluginId, kind, depsOverrides.get(kind));
      if (refusal) {
        return status(
          refusal.status,
          apiErrorBody({ code: codeForRefusalStatus(refusal.status), message: refusal.message }),
        );
      }

      return agentCommandStream(kind, params.pluginId, request);
    },
    {
      params: t.Object({
        pluginId: t.String({
          description:
            kind === "update"
              ? "Built-in plugin id whose harness CLI to update"
              : "Built-in plugin id whose agent CLI to install",
        }),
      }),
      // NO typed 200: this route streams. The body is NDJSON — one
      // `{"type":"line","text":…}` per line the command prints, then exactly
      // one `{"type":"done", …AgentInstallResult, harness}` or
      // `{"type":"error","message":…}`. `AgentInstallResultSchema` still
      // describes the `done` frame's payload and is where that shape lives; it
      // is simply no longer the shape of the whole body.
      // The two NOs are told apart by where they land: `ok:false` inside a
      // 200's `done` frame is a run that FAILED (it ran and exited non-zero,
      // or could not start); a 4xx is a REFUSAL, decided before the body
      // opened and before anything ran.
      response: {
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: kind === "update" ? "updateSetupAgent" : "installSetupAgent",
        tags: ["setup"],
        description:
          kind === "update"
            ? "Runs the vendor update command of one built-in agent CLI on the control-plane host, as the server's own user (falling back to re-running its install command). Admin cookie only, never public, audited as agent.update. STREAMS application/x-ndjson: a {type:line,text} per command line, then one terminal {type:done,...} with ok/exitCode/harness, or {type:error,message}."
            : "Runs the official installer of one built-in agent CLI on the control-plane host, as the server's own user. Admin cookie only, never public, audited. STREAMS application/x-ndjson while it runs: a {type:line,text} per line of installer output, then one terminal {type:done,...} carrying ok/exitCode/output/harness, or {type:error,message}. ok:false inside a done frame is a run that failed; a 4xx is a refusal decided before the body opened and before anything ran.",
      },
    },
  );
}

/**
 * The one streaming body both endpoints return once their refusal passed.
 * `harness` is re-probed AFTER the command exits so one round trip reports
 * both the run's log and the new detection state.
 */
function agentCommandStream(kind: AgentInstallKind, pluginId: string, request: Request): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      /** One NDJSON frame. A closed reader (the page navigated) must not throw into the command. */
      const send = (frame: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          // The reader is gone. The command carries on regardless — it is
          // changing this machine, and abandoning it half-done because nobody
          // is watching would be worse than finishing unobserved.
        }
      };
      try {
        const result = await runBuiltInAgentCommand(pluginId, kind, depsOverrides.get(kind), (line) =>
          send({ type: "line", text: line }),
        );
        // Best-effort actor id for the audit row; the gate above already
        // proved a valid admin cookie, so this just reads it back out.
        const actor = await resolveCookieSession(request.headers.get("cookie") ?? "");
        await audit({
          actorUserId: actor?.user.id ?? null,
          action: kind === "update" ? "agent.update" : "agent.install",
          targetType: "plugin",
          targetId: pluginId,
          metadataJson: JSON.stringify({ ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs }),
        });
        const installedHere = (await localPluginReports()).some((r) => r.id === pluginId && !r.broken);
        send({ type: "done", ...result, harness: await harnessInfo(pluginId, installedHere) });
      } catch (err) {
        // The status line is long gone, so a failure has to arrive as a
        // FRAME. A client that sees neither `done` nor `error` before the
        // stream ends treats that as a failure too — see the web hook.
        send({ type: "error", message: err instanceof Error ? err.message : `The ${kind} failed.` });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      // Nothing between here and the page may hold these frames back: the
      // whole point is that they arrive while the command is still going.
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

/** `POST /api/setup/agents/:pluginId/install` (spec 2026-09-11 § 7). */
export const setupAgentInstallRoute = agentCommandEndpoint("install");

/** `POST /api/setup/agents/:pluginId/update` (spec 2026-09-28 § 2). */
export const setupAgentUpdateRoute = agentCommandEndpoint("update");
