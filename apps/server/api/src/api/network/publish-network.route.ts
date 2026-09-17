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
} from "@/api/network/network-gate.js";
import { NetworkParamsSchema } from "@/api/network/schemas.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { setPluginGuards } from "@/plugins/access-guard.plugin.js";
import { apiModels } from "@/schema/index.js";
import { syncNetworkOrigins } from "@/services/network/origins.js";
import { resolveNetworkGuard } from "@/services/network/resolve-guard.js";
import { networkContext, writeNetworkState } from "@/services/network/state.js";
import { armProcess } from "@/services/network/supervisor.js";

/**
 * `POST /api/network/:id/publish` (spec 2026-09-15 § 5.1, § 5.4).
 *
 * Makes this server reachable on a network the host has already joined, and
 * then makes it a trusted origin for sign-in the moment the record says so.
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
 * **Nothing is written to config.env.** The addresses become trusted origins
 * the moment the record says published, through the registry
 * (`services/trusted-origins.ts`); there is no restart and no key the
 * environment could own.
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
        send({ type: "done", ok: false, refused: result.refused, addresses: [], status: after });
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
      // Trusted NOW, from the record just written — for a `public-with-gate`
      // network this is the line that makes its hostname an origin, and it runs
      // after the guard is installed and never before. The fresh re-read below
      // observes the same addresses again; this call is what makes the trust
      // independent of that read succeeding.
      await syncNetworkOrigins(id, entry.manifest.network);

      const after = await readNetworkStatus(entry, ctx, { fresh: true });
      await auditNetwork(request, "network.publish", id, {
        addresses: result.addresses.map((a) => a.url),
      });
      send({ type: "done", ok: true, addresses: result.addresses, status: after });
    }, release);
  },
  {
    params: NetworkParamsSchema,
    // NO typed 200: this route streams. The body is NDJSON — {type:line,text}
    // frames, then one {type:done,ok,addresses,status} (with `refused` when
    // ok is false) or {type:error,message}.
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
        "Publishes this server on the network (admin cookie only): installs the plugin's request guard, arms its supervised process, records the publish, and the addresses are trusted for sign-in immediately. STREAMS application/x-ndjson, terminating in one done frame {ok, addresses, status}; a plugin refusal is done with ok:false and the hint. Audited as network.publish.",
    },
  },
);
