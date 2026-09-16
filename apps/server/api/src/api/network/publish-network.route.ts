import { BackendErrorCodes } from "@internal/backend-errors";
import { withPluginOutput } from "@internal/pane-runtime";
import { Elysia } from "elysia";
import { ndjsonResponse } from "@/api/network/ndjson.js";
import {
  auditNetwork,
  configurationRefusal,
  invalidateNetworkStatus,
  networkDeps,
  prepareNetworkAct,
  readinessRefusal,
  readNetworkStatus,
  requireNetworkAdmin,
  writePublishConfig,
} from "@/api/network/network-gate.js";
import { NetworkParamsSchema } from "@/api/network/schemas.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { setPluginGuards } from "@/plugins/access-guard.plugin.js";
import { apiModels } from "@/schema/index.js";
import { resolveNetworkGuard } from "@/services/network/resolve-guard.js";
import { networkContext, writeNetworkState } from "@/services/network/state.js";
import { armProcess } from "@/services/network/supervisor.js";

/**
 * `POST /api/network/:id/publish` (spec 2026-09-15 § 5.1, § 5.4).
 *
 * Makes this server reachable on a network the host has already joined, and
 * then makes the server's own configuration agree with that.
 *
 * **The order inside the `done` path is load-bearing.** The guard is installed
 * FIRST, before the supervised process that carries traffic is spawned: for a
 * `public-with-gate` plugin, any other order leaves an instant in which a
 * tunnel is alive and unguarded, which is the whole exposure this design
 * refuses to take. Unpublishing reverses it — process down first, guard off
 * last (`services/network/unpublish.ts`).
 *
 * **A refusal from the plugin is an ANSWER, not a failure.** `publish()` may
 * return a `PublishRefusal` naming what the operator has to do first; that
 * arrives as `done` with `ok: false` and the hint, because the act completed
 * and told us something, and an `error` frame would say the server broke.
 *
 * **The config write never removes an origin, and never overwrites a key the
 * environment owns.** Both rules live in `writePublishConfig`, which calls the
 * CLI's own `applyConfig` — the one writer, shared with `subshell-server
 * configure` and `PATCH /api/admin/server/config`. When a key IS owned by the
 * environment the publish still completes: the server really is reachable at
 * the address, and what could not follow is the file. `config.written: false`
 * with `unwritableKey` says which.
 */
export const publishNetworkRoute = new Elysia().use(apiModels).post(
  "/:id/publish",
  async ({ params, request, status }) => {
    await requireNetworkAdmin(request);
    const prepared = await prepareNetworkAct(params.id);
    if ("status" in prepared) {
      return status(prepared.status, apiErrorBody({ code: prepared.code, message: prepared.message }));
    }
    const { resolved, ctx, release } = prepared;
    const entry = resolved.entry;
    const id = entry.manifest.id;

    const publish = entry.plugin.publish;
    if (!publish) {
      release();
      // 404 rather than a 409: there is no publish operation at this path
      // for this plugin at all, which is the same "nothing here to act on"
      // the unknown-id branch answers. A 409 would suggest a state that
      // could change.
      return status(
        404,
        apiErrorBody({
          code: BackendErrorCodes.NOT_FOUND_ERROR,
          message: `${entry.manifest.name} does not publish this server on its network.`,
        }),
      );
    }

    const before = await readNetworkStatus(entry, ctx, { fresh: true });
    const refusal = readinessRefusal(before, entry.manifest.name) ?? configurationRefusal(entry, ctx);
    if (refusal) {
      release();
      return status(refusal.status, apiErrorBody({ code: refusal.code, message: refusal.message }));
    }

    return ndjsonResponse(async (send) => {
      send({ type: "line", text: `Publishing this server on ${entry.manifest.name}…` });
      // Wrapped so the vendor CLI's own output reaches this stream, the same
      // way the join route does it: `tailscale serve` prints what it did, and
      // a stream that narrated only our own steps would drop it.
      const result = await withPluginOutput(
        id,
        (text) => send({ type: "line", text }),
        () => publish.call(entry.plugin, ctx),
      );
      invalidateNetworkStatus(id);

      if ("refused" in result) {
        const after = await readNetworkStatus(entry, ctx, { fresh: true });
        send({ type: "line", text: result.refused.text });
        // `written: true` vacuously: nothing was asked of config.env, so
        // nothing failed to be written. A `false` here would send the page
        // looking for a config problem that does not exist.
        send({
          type: "done",
          ok: false,
          refused: result.refused,
          addresses: [],
          config: { changed: [], warnings: [], written: true },
          restartRequired: false,
          status: after,
        });
        return;
      }

      // A publish that reaches the open internet may not proceed without the
      // one enforcement point that bounds it. `exposure` is manifest data, so
      // this is decided without loading plugin code — and a plugin that
      // returned addresses but no guard is not a plugin to trust with the
      // difference. Nothing has been armed at this point, so refusing here
      // leaves the machine exactly as it was.
      // REBUILT AFTER `publish()`, not the one `prepareNetworkAct` made before
      // it. A plugin may store a secret while publishing, and `NetworkContext`
      // reports which secrets are set — so asking on the pre-publish context
      // would install a guard derived from state the publish has already
      // changed, while boot derives from the state after it. Two derivations,
      // one of which is stale: exactly the disagreement deleting
      // `PublishOutcome.guard` was meant to end.
      const published = await networkContext(id, entry);
      // ONE resolver, shared with the boot pass, so a `requestGuard` that
      // throws or returns null folds the same three ways in both places.
      const resolved = resolveNetworkGuard(entry, published);
      if (resolved.refused) {
        release();
        send({
          type: "done",
          ok: false,
          refused: {
            text: `${entry.manifest.name} publishes this server on the public internet and did not describe an identity check to put in front of it. Nothing was published.`,
          },
          addresses: [],
          config: { changed: [], warnings: [], written: true },
          restartRequired: false,
          status: before,
        });
        return;
      }

      // GUARD FIRST. See the docstring: the tunnel must never be able to
      // carry a request before the check on it is installed. Replacing by
      // OWNER rather than by hostname keeps a re-publish idempotent — a
      // re-publish after a settings change declares a different hostname, and
      // filtering on the new one would leave the old guard standing with
      // nothing able to remove it.
      if (resolved.guard) {
        setPluginGuards(id, [resolved.guard]);
        send({ type: "line", text: `Requiring a Cloudflare Access assertion for ${resolved.guard.hostname}.` });
      }
      if (result.process) {
        armProcess(id, result.process);
        send({ type: "line", text: "Started the tunnel process." });
      }

      await writeNetworkState(id, {
        published: true,
        addresses: result.addresses,
        port: networkDeps().port(),
        publishedAt: new Date().toISOString(),
      });

      const config = writePublishConfig({ origins: result.addresses.map((a) => a.url) });
      for (const warning of config.warnings) send({ type: "line", text: warning });

      const after = await readNetworkStatus(entry, ctx, { fresh: true });
      await auditNetwork(request, "network.publish", id, {
        addresses: result.addresses.map((a) => a.url),
      });
      send({
        type: "done",
        ok: true,
        addresses: result.addresses,
        config,
        // Always true: `applyConfig` writes a file the next boot reads, so
        // the new origins do not take effect until then —
        // even when nothing needed writing, the page offers the restart
        // rather than leaving an admin to discover a 403 on sign-in.
        restartRequired: true,
        status: after,
      });
    }, release);
  },
  {
    params: NetworkParamsSchema,
    // NO typed 200: this route streams. The body is NDJSON — {type:line,text}
    // frames, then one {type:done,ok,addresses,config,restartRequired,status}
    // (with `refused` when ok is false) or {type:error,message}.
    response: {
      400: "ApiErrorResponse",
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      404: "ApiErrorResponse",
      409: "ApiErrorResponse",
    },
    detail: {
      operationId: "publishNetwork",
      tags: ["network"],
      description:
        "Publishes this server on the network (admin cookie only): installs the plugin's request guard, arms its supervised process, records the publish, and adds the new origins to TRUSTED_ORIGINS through the CLI's own config writer. STREAMS application/x-ndjson, terminating in one done frame. A plugin refusal is done with ok:false and the hint; a config key the environment owns leaves config.written false with unwritableKey while the publish itself stands. Audited as network.publish.",
    },
  },
);
