import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia } from "elysia";
import { ndjsonResponse } from "@/api/network/ndjson.js";
import {
  auditNetwork,
  invalidateNetworkStatus,
  networkDeps,
  prepareNetworkAct,
  readNetworkStatus,
  requireNetworkAdmin,
} from "@/api/network/network-gate.js";
import { NetworkParamsSchema } from "@/api/network/schemas.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";

/**
 * `POST /api/network/:id/install` — runs the vendor's own installer for one
 * network plugin's CLI, on the control-plane host, as the server's user.
 *
 * A near-copy of `setup-agent-install.route.ts`, and deliberately so: the two
 * are the same act on the same machine with the same gate, differing only in
 * where the command comes from. This one reads it from the network plugin's
 * `subshell.install` manifest block.
 *
 * **The request body contributes nothing to what runs.** The id is the only
 * input a caller supplies, and it selects a plugin whose command was fixed
 * when the plugin was built. That is what keeps "the server installs the CLI"
 * from being a way to run a command of the caller's choosing.
 *
 * **There is no `sudo` check here, and adding one would be duplication rather
 * than defence.** `parseManifest` (in `@subshell-ai/plugin-api`) REFUSES an
 * `install.command` that begins with `sudo` at load time, so a manifest that
 * reached this route cannot carry one — a plugin declaring a privileged
 * installer fails to load entirely, and its privileged steps live in
 * `network.privileged`, which is only ever rendered to copy. Re-checking here
 * would suggest the parser's refusal is advisory.
 *
 * **Nothing shipping today exercises this route.** Tailscale declares no
 * `install` block and cannot: every Tailscale install path needs root. The
 * first real user is `brew install cloudflared` on macOS. It is built now
 * because the page renders the button conditionally on `install` being
 * present, and a button wired to a 404 is worse than shipping both or
 * neither.
 *
 * `ok: false` inside a `done` frame is a run that FAILED — the installer ran
 * and said no. A 4xx is a refusal decided before the body opened and before
 * anything ran.
 */
export const installNetworkRoute = new Elysia().use(apiModels).post(
  "/:id/install",
  async ({ params, request, status }) => {
    await requireNetworkAdmin(request);
    const prepared = await prepareNetworkAct(params.id);
    if ("status" in prepared) {
      return status(prepared.status, apiErrorBody({ code: prepared.code, message: prepared.message }));
    }
    const { resolved, ctx, release } = prepared;
    const entry = resolved.entry;
    const id = entry.manifest.id;

    const install = entry.manifest.install;
    if (!install || install.command.trim() === "") {
      release();
      // 404 rather than 409, matching the publish route's "this plugin has no
      // such operation": a plugin that declares no installer has nothing here
      // to act on, and the state cannot change to make it appear. This is the
      // COMMON case today, not an edge.
      return status(
        404,
        apiErrorBody({
          code: BackendErrorCodes.NOT_FOUND_ERROR,
          message: `${entry.manifest.name} has no installer the server can run; follow its own instructions instead.`,
        }),
      );
    }

    return ndjsonResponse(async (send) => {
      send({ type: "line", text: `Installing ${entry.manifest.name} with its own installer…` });
      // A vendor's install hint is a SHELL LINE (`brew install cloudflared`,
      // `curl … | sh`), so it is run through `sh -c` exactly as the agent
      // installer runs a harness's. Callers with a fixed argv — the tmux
      // table — hand the runner the argv directly and never grow a shell.
      const result = await networkDeps().runInstall(["sh", "-c", install.command], (line) =>
        send({ type: "line", text: line }),
      );
      // The memo first, then the probe. `status()` is what says whether the
      // CLI is on this machine, and a row still reading `not-installed`
      // after a successful install is the defect this drops the memo for —
      // the same reason the tmux route calls `invalidateDeployFacts()`.
      invalidateNetworkStatus(id);
      const after = await readNetworkStatus(entry, ctx, { fresh: true });
      await auditNetwork(request, "network.install", id, {
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
      // The OUTPUT rides the frame and never the audit row: an installer's
      // stdout can legitimately carry a token or a path someone typed into
      // their own shell profile moments earlier, and the audit log is the
      // one record kept forever.
      send({ type: "done", ...result, status: after });
    }, release);
  },
  {
    params: NetworkParamsSchema,
    // NO typed 200: this route streams. The body is NDJSON — a
    // {"type":"line","text":…} per line the installer prints, then exactly one
    // {"type":"done", ok, exitCode, output, durationMs, status} or
    // {"type":"error","message":…}.
    response: {
      400: "ApiErrorResponse",
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      404: "ApiErrorResponse",
      409: "ApiErrorResponse",
    },
    detail: {
      operationId: "installNetwork",
      tags: ["network"],
      description:
        "Runs this network plugin's own declared installer on the control-plane host, as the server's user (admin cookie only, audited). The command comes from the plugin's manifest and never from the request. STREAMS application/x-ndjson: {type:line,text} frames, then one {type:done,ok,exitCode,output,durationMs,status} carrying a freshly probed status, or {type:error,message}. 404 when the plugin declares no installer the server may run, which is every plugin whose install needs root.",
    },
  },
);
