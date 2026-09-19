import {
  NODE_PROTOCOL_VERSION,
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NO_SERVICE,
  NODE_RESULT_NOT_SUPERVISED,
  NODE_SERVICE_VERBS,
  type NodeServiceVerb,
} from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { readAllowedDirs } from "../allowed-dirs.js";
import { execService, type ServiceExecContext } from "../commands/service.js";
import { execUpdate, type UpdateExecContext } from "../commands/update.js";
import type { NodeConfig } from "../config.js";
import { runConfigure } from "../configure.js";
import { currentDebugLogging, setDebugLogging } from "../debug-logging.js";
import { log } from "../log.js";
import { AGENT_LOG_CAP_BYTES, agentLogPath, readNodeLogSlice } from "../log-file.js";
import { writeMaintenance } from "../maintenance.js";
import { defaultMaintenanceDeps, runMaintenance } from "../maintenance-cli.js";
import { DEFAULT_DEPS, queryService } from "../service.js";
import {
  failedMarkerPath,
  pendingMarkerPath,
  readMarker,
  releaseApiUrl,
  resolveNodeRelease,
  rollbackUpdate,
} from "../update.js";
import { NODE_VERSION } from "../version.js";
import { refuseRequest } from "./guards.js";
import { getDaemonState, requestDaemonRestart } from "./state.js";
import { buildLocalNodeView, liveRuntime } from "./view.js";

/**
 * The dashboard's local API — the node answering the control plane's
 * `/api/nodes/:id/*` contract about ITSELF.
 *
 * The contract IS the reuse mechanism: `@internal/node-admin`'s cards and
 * hooks are untouched because what they fetch here reads exactly like what
 * they fetch from the plane. Where the two backends genuinely differ, the
 * difference is real rather than papered over, and each is stated at its
 * route:
 *
 * - **`maintenance on` here kills.** The node's own CLI `on` stops every pane
 *   (flag first, so the plane never auto-restarts a killed row back onto this
 *   machine), while the plane's route never kills anything itself because its
 *   maintenance push races the report the CLI's deaths carry. On this machine
 *   the CLI's order is the local truth, so the route runs the CLI —
 *   `runMaintenance`, with `--yes` because the card already asked.
 * - **Mutations reuse the command executors**, narrowed to what they read
 *   (`ServiceExecContext`, `UpdateExecContext`): `execService` owns the
 *   supervision and pane-safety refusals and `execUpdate` owns the download
 *   verification, and a second implementation of either on this side is the
 *   drift those files' comments argue against.
 * - **There is no audit row.** The plane audits every mutation with a named
 *   actor; this surface has no actor beyond "whoever holds this machine's
 *   keyboard", and the machine's own record of its acts is its log file —
 *   which is why repointing logs a line here exactly as `subshell configure`
 *   does.
 * - **`serverUrl` is always present** on the detail view, because the config
 *   file is right here; the plane's view can only carry it when the node
 *   reported one.
 */

/** Every route refuses by id except the machine's own — a wrong id is a wrong node, not "this one". */
function isSelf(cfg: NodeConfig, id: string): boolean {
  return id === "self" || id === cfg.nodeId;
}

/** The same 404 shape the plane's routes answer with. */
function notFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A refusal with a status. The body carries the sentence under BOTH `message`
 * and `error`: `message` is the key `lib/api.ts`'s `parseErrorBody` reads, so
 * the shared cards' `errMessage` shows the clean sentence ("API 409: <sentence>")
 * exactly as it does for a plane 409 (`apiErrorBody`'s `{message}`) — not the
 * raw JSON; `error` is kept because that is the shape this surface's own
 * `notFound` and its tests speak.
 */
function refuse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The `CommandContext` subset `execService` reads, built from what the daemon published. */
function serviceCtx(): ServiceExecContext {
  return { runtime: getDaemonState().runtime, requestRestart: () => void requestDaemonRestart() };
}

/** The `CommandContext` subset `execUpdate` reads, for the same reason. */
function updateCtx(cfg: NodeConfig): UpdateExecContext {
  return {
    runtime: getDaemonState().runtime,
    config: cfg,
    requestRestart: () => void requestDaemonRestart(),
  };
}

/**
 * Would exiting THIS process be a restart or a stop? The update route asks
 * before installing; rollback asks before it would exit into nothing. Uses the
 * daemon's frozen report when a daemon is live, else re-proves it with one
 * manager query (the same fallback the update route uses).
 */
async function isSupervisedForRestart(): Promise<boolean> {
  const runtime = getDaemonState().runtime;
  if (runtime) return runtime.supervised;
  return queryService(DEFAULT_DEPS(async () => true))
    .then((s) => s.state === "running" && s.pid === process.pid)
    .catch(() => false);
}

/**
 * The node's refusal → the sentence the plane would have sent.
 *
 * `service-node.route.ts` owns this mapping for plane-driven acts (match by
 * EQUALITY on the wire constants, never by substring); the dashboard IS a
 * second caller of the same rule about the SAME machine, so it carries its
 * half rather than forwarding a bare constant the card renders as snake_case.
 * "That node" becomes "this node" because the reader is standing on it.
 */
function serviceRefusal(error: string): string {
  if (error === NODE_RESULT_NOT_SUPERVISED) {
    return "This node is not running under a service manager, so exiting it would stop it rather than restart it; restart it where it was started";
  }
  if (error === NODE_RESULT_NO_SERVICE) {
    return "This machine has no service definition installed, so there is nothing to start or stop; install one first";
  }
  if (error === NODE_RESULT_KILLS_PANES) {
    // The plane picks the wording from ITS knowledge of paneSafety; this
    // machine asked its own definition a route ago and can read the same
    // field, so the two spellings survive here too.
    const paneSafety = getDaemonState().runtime?.service.paneSafety;
    return paneSafety === "unknown"
      ? "This node's service definition could not be read, so whether this keeps its running subshells is unknown; act anyway with force, or repair the definition on this machine"
      : "This node's service definition would close every subshell running on it; reinstall the definition on this machine, or act anyway with force";
  }
  // Unrecognized (a manager's own words, an unknown verb): the plane falls
  // through to "unreachable" with the node's message; this side has nothing
  // smarter to say than the words it got.
  return error;
}

/**
 * Body of the service route → the plane's contract.
 *
 * A SUCCESS is `200 {ok:true}` (the install-text case is answered with a
 * `detail` at the call site, before this); a REFUSAL is a `409 {message}`,
 * mapping the node's wire constant to the same sentence the plane's
 * `service-node.route.ts` sends. This is deliberately NOT a 200-with-ok:false:
 * the shared `useNodeService` hook and `NodeServiceCard` resolve on any 2xx and
 * print `res.detail` as a success line, and reach their red-failure branch only
 * on a non-2xx — so on the plane a refusal is a 409 (rejected → red), and the
 * mirror must answer 409 too or the machine's own card would render "no service
 * definition installed" in the muted *done* slot as if it had worked.
 */
function serviceResult(result: { ok: true; data?: unknown } | { ok: false; error: string }): Response {
  if (result.ok) return Response.json({ ok: true });
  return refuse(409, serviceRefusal(result.error));
}

/**
 * The Elysia schema for one `service` command body. The verbs are spelled out
 * (TypeBox unions are static by shape) and the handler RE-CHECKS against
 * `NODE_SERVICE_VERBS`, so a verb added to the protocol fails this parser's
 * check loudly rather than reaching the manager as an unchecked string.
 */
const ServiceBody = t.Object({
  verb: t.Union(
    [t.Literal("start"), t.Literal("stop"), t.Literal("restart"), t.Literal("install"), t.Literal("uninstall")],
    { description: "The service-manager verb to run on this node" },
  ),
  force: t.Optional(t.Boolean({ description: "Proceed even when the definition would close running subshells" })),
});

/**
 * The guard every request passes, exported for `server.ts`'s static fallback:
 * a `.use()`d instance's lifecycle never reaches a later wildcard on the
 * outer one (live smokes: a foreign `Host:` got 200 on exactly that seam), so
 * this instance guards its own routes below and the fallback calls this
 * function explicitly. One rule, two call sites, no composition to get wrong.
 */
export function guardResponse(request: Request): Response | null {
  return refuseRequest({
    method: request.method,
    hostHeader: request.headers.get("host"),
    originHeader: request.headers.get("origin"),
    contentType: request.headers.get("content-type"),
  });
}

/**
 * The dashboard's `/api` surface, behind {@link guardResponse} on THIS
 * instance (Elysia lifecycle hooks are definition-ordered); every route below
 * is therefore already host/origin/content-type checked, and nothing in this
 * file re-checks — the guard is the one gate.
 */
export function buildRoutes(cfg: NodeConfig) {
  return new Elysia()
    .onBeforeHandle(({ request }) => guardResponse(request) ?? undefined)
    .get("/api/self", () => ({ id: cfg.nodeId, name: cfg.name }))
    .get("/api/self/state", async () => ({
      connected: getDaemonState().connected,
      lastHeartbeatAt: getDaemonState().lastHeartbeatAt,
      // The daemon's FROZEN report when a daemon is live (the Status page
      // then shows exactly what the plane is shown); the memoized fresh
      // collect when the dashboard runs without one.
      runtime: getDaemonState().runtime ?? (await liveRuntime()),
    }))
    .get("/api/nodes/:id", async ({ params }) =>
      isSelf(cfg, params.id) ? Response.json(await buildLocalNodeView(cfg)) : notFound(),
    )
    .get("/api/nodes/:id/allowed-dirs", ({ params }) =>
      // Read-only here by contract: the list is the plane's push (the launch
      // gate enforces the plane's copy first), so the SPA renders it with no
      // editor. The route exists because the card reads it.
      isSelf(cfg, params.id) ? Response.json({ dirs: readAllowedDirs(cfg.dataDir) }) : notFound(),
    )
    .get(
      "/api/nodes/:id/logs",
      async ({ params, query }) => {
        if (!isSelf(cfg, params.id)) return notFound();
        const fromByte = Math.max(0, Math.trunc(query.fromByte ?? 0));
        const maxBytes = Math.min(Math.max(1, Math.trunc(query.maxBytes ?? 64 * 1024)), AGENT_LOG_CAP_BYTES);
        // No cap on `fromByte` at the boundary: a cursor past EOF reads as
        // empty, and `readNodeLogSlice` clamps a negative one — the file's
        // own reader is the size authority.
        return Response.json(await readNodeLogSlice(agentLogPath(), fromByte, maxBytes));
      },
      {
        query: t.Object({
          fromByte: t.Optional(t.Numeric({ description: "Byte offset to read from (0 = start; clamped at EOF)" })),
          maxBytes: t.Optional(t.Numeric({ description: "Max bytes to return (capped at the agent log's own limit)" })),
        }),
      },
    )
    .put(
      "/api/nodes/:id/maintenance",
      async ({ params, body }) => {
        if (!isSelf(cfg, params.id)) return notFound();
        // `on` IS the CLI verb (census, flag-first, kills, re-probe), with
        // the confirmation pre-given because the card asked before sending.
        // `off` is a bare write — there is nothing to stop.
        if (body.on) {
          const r = await runMaintenance(
            cfg.dataDir,
            "on",
            { yes: true, json: true },
            defaultMaintenanceDeps(cfg.dataDir),
          );
          const parsed = JSON.parse(r.out) as {
            on: boolean;
            changedAt: string;
            stopped: string[];
            failed?: string[];
          };
          // The view is rebuilt AFTER the flip so its maintenance fields
          // carry it; `stopped`/`failed` ride beside it in the plane's
          // MaintenanceResult shape, absence of `failed` being the clean
          // case on both backends.
          const view = await buildLocalNodeView(cfg);
          return Response.json({
            ...view,
            stopped: parsed.stopped,
            ...(parsed.failed ? { failed: parsed.failed } : {}),
          });
        }
        writeMaintenance(cfg.dataDir, { on: false, changedAt: new Date().toISOString() });
        return Response.json({ ...(await buildLocalNodeView(cfg)), stopped: [] });
      },
      {
        body: t.Object({
          on: t.Boolean({ description: "true = enter maintenance (stops every subshell here); false = leave" }),
        }),
      },
    )
    .post(
      "/api/nodes/:id/service",
      async ({ params, body }) => {
        if (!isSelf(cfg, params.id)) return notFound();
        // Re-checked rather than trusted from the parser — the same
        // exclusion `execService` guards with, so a verb added to the
        // protocol cannot reach the manager as an unchecked string here.
        if (!(NODE_SERVICE_VERBS as readonly string[]).includes(body.verb)) {
          return serviceResult({ ok: false, error: `unknown service verb '${body.verb as string}'` });
        }
        // `install` answers `data` with the manager's success text; the plane
        // forwards it as the ok-body's `detail` and the card prints it —
        // carried here verbatim so both backends read the same card.
        const result = await execService(serviceCtx(), {
          type: "service",
          verb: body.verb as NodeServiceVerb,
          force: body.force,
        });
        if (result.ok && typeof result.data === "string" && result.data.trim().length > 0) {
          return Response.json({ ok: true, detail: result.data.trim().slice(0, 400) });
        }
        return serviceResult(result);
      },
      { body: ServiceBody },
    )
    .put(
      "/api/nodes/:id/logging",
      async ({ params, body }) => {
        if (!isSelf(cfg, params.id)) return notFound();
        try {
          // The plane's shape is the SETTING ECHO, not the effective state:
          // under `SUBSHELL_DEBUG_LOGGING` the set throws (environment wins)
          // and that refusal is the answer the card needs, verbatim.
          const state = await setDebugLogging(body.debug);
          log(`debug logging ${state.debug ? "enabled" : "disabled"} (dashboard)`);
          return Response.json({ debug: state.debug });
        } catch (err) {
          return refuse(409, err instanceof Error ? err.message : String(err));
        }
      },
      {
        body: t.Object({
          debug: t.Boolean({ description: "Whether debug-level lines reach the node's own log file" }),
        }),
      },
    )
    .patch(
      "/api/nodes/:id/config",
      async ({ params, body }) => {
        if (!isSelf(cfg, params.id)) return notFound();
        try {
          const next = await runConfigure({ server: body.serverUrl });
          log(`configured: server url is now ${next.serverUrl} (takes effect on the next restart)`);
          return Response.json({ serverUrl: next.serverUrl, restartRequired: true });
        } catch (err) {
          return refuse(409, err instanceof Error ? err.message : String(err));
        }
      },
      { body: t.Object({ serverUrl: t.String({ description: "Control-plane URL to dial on the next restart" }) }) },
    )
    .get("/api/self/update", async () => ({
      currentVersion: NODE_VERSION,
      protocolVersion: NODE_PROTOCOL_VERSION,
      // The CLI's own `--check` cannot say this about its plane and prints
      // a pointer instead; this page IS local, so it says whether a release
      // source exists at all and the Updates page renders that honestly.
      releaseConfigured: releaseApiUrl() !== null,
      debugLogging: currentDebugLogging().debug,
      pending: await readMarker(pendingMarkerPath(cfg.dataDir)),
      lastFailure: await readMarker(failedMarkerPath(cfg.dataDir)),
      connected: getDaemonState().connected,
    }))
    .post(
      "/api/self/update",
      async ({ body }) => {
        // The supervision refusal must not wait for the release source to
        // answer: `execUpdate` would refuse the same way, but only after a
        // network round trip, and on the FOREGROUND `subshell run` the
        // frozen runtime report can say "unsupervised" immediately and
        // re-proves it with one manager query when it says otherwise.
        const runtime = getDaemonState().runtime;
        if (runtime && !runtime.supervised) {
          return refuse(409, serviceRefusal(NODE_RESULT_NOT_SUPERVISED));
        }
        if (!runtime) {
          const supervised = await queryService(DEFAULT_DEPS(async () => true))
            .then((s) => s.state === "running" && s.pid === process.pid)
            .catch(() => false);
          if (!supervised) {
            return refuse(
              409,
              "This node is not running under a service manager, so exiting it would stop it rather than restart it; update it with `subshell update` and restart it where it was started",
            );
          }
        }
        // One resolution pass, then `execUpdate` — the plane-commanded
        // installer, with its pane-safety refusal, its signature
        // re-verification, its marker and `.previous` — running the LOCAL
        // source the CLI's `--to` uses. The offer's manifest travels base64
        // through the frozen frame shape, which is exactly what makes this
        // path the same code path as the plane's.
        let offer;
        try {
          offer = await resolveNodeRelease(body.to);
        } catch (err) {
          // "no release source", "no asset for this host", "not reachable":
          // the resolution failed before any trust or bytes moved, and the
          // sentence is the actionable part.
          return refuse(409, err instanceof Error ? err.message : String(err));
        }
        // `already at <v>` and the downgrade-needs-force refusal belong to
        // `applyUpdate`, which `execUpdate` runs — this route adds no
        // version arithmetic of its own, so there is one rule per question.
        const result = await execUpdate(updateCtx(cfg), {
          type: "update",
          version: offer.version,
          url: offer.url,
          sha256: offer.sha256,
          force: body.force,
          manifest: offer.manifest.bytes.toString("base64"),
          manifestSig: offer.manifest.sig,
        });
        if (!result.ok) return refuse(409, serviceRefusal(result.error));
        // `execUpdate` already asked the daemon to exit — the daemon's
        // requestRestart defers RESTART_EXIT_DELAY_MS so this response
        // leaves first. Nothing here waits, and nothing here exits.
        return Response.json({ ok: true, version: offer.version });
      },
      {
        body: t.Object({
          to: t.Optional(t.String({ description: "Specific published version to install (blank = newest release)" })),
          force: t.Optional(t.Boolean({ description: "Allow a downgrade / proceed past the pane-safety refusal" })),
        }),
      },
    )
    .post("/api/self/update/rollback", async () => {
      try {
        // A hand-run `subshell update --rollback` resolves the binary
        // through the real ladder; so does this. Refusing because nothing
        // was installed is `rollbackUpdate`'s sentence, not an invention
        // of this route.
        const r = await rollbackUpdate(cfg.dataDir);
        // The file swap is always safe to do — the running process keeps its
        // in-memory version until it next boots. EXITING is not. The CLI's
        // `--rollback` never restarts for exactly this reason, and the update
        // route three handlers up refuses to exit an unsupervised node; this
        // path must not be the one that silently turns a rollback into a stop
        // on a `subshell run` in a terminal (nothing would respawn it). So ask
        // the daemon to exit only where the manager would bring it back, and
        // otherwise report `restarted:false` — the card then tells the operator
        // to restart it where it was started.
        const restarted = (await isSupervisedForRestart()) ? requestDaemonRestart() : false;
        return Response.json({ ok: true, to: r.to, restarted });
      } catch (err) {
        return refuse(409, err instanceof Error ? err.message : String(err));
      }
    });
}
