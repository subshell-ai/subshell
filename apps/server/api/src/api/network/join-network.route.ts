import { BackendErrorCodes } from "@internal/backend-errors";
import { withPluginOutput } from "@internal/pane-runtime";
import { Elysia, t } from "elysia";
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
import { apiModels } from "@/schema/index.js";
import { syncNetworkOrigins } from "@/services/network/origins.js";
import { writeNetworkState } from "@/services/network/state.js";
import { getLogger } from "@/utils/logger.js";

/**
 * How long the implicit-publish gap-re-read gives the peer table.
 *
 * NetBird 0.66.4 was MEASURED to answer `status` with its addresses the
 * instant a join lands (§ 10.4), so this is not a poll for the ordinary case
 * — it is one honest second read for the case the measurement cannot promise,
 * long enough for a table to settle and short enough to stay inside the
 * stream a browser is holding open.
 */
const PUBLISH_IMPLICIT_REPOLL_MS = 1_200;

const JoinBodySchema = t.Object(
  {
    credential: t.Optional(
      t.String({
        description:
          "A pre-authentication credential pasted by the operator. Absent asks for the interactive flow instead, which a plugin declaring interactiveLogin answers with a URL; PRESENT BUT BLANK is a 400 — it is neither flow",
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
 * **EXISTENCE is the route's, though, and a present-but-blank `credential` is
 * a 400 before the stream opens.** Absent means "sign me in interactively";
 * present means "I pasted a key". A field present with nothing in it is
 * neither, and both readings of it are wrong: run as a credential join it
 * hands the plugin an empty secret, run as interactive it starts a sign-in
 * flow nobody asked for. The mode the AUDIT records turns on exactly this
 * fork, so the fork gets a refusal rather than a fallback.
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

    // A pasted-but-blank credential is decided up front, before even the
    // status read: it is a defect in the CALLER, not in the daemon's state,
    // and the answer does not depend on anything the plugin could say.
    if (body.credential !== undefined && body.credential.trim() === "") {
      release();
      return status(
        400,
        apiErrorBody({
          code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
          message: "The credential is empty. Paste the credential, or omit it to sign in interactively.",
        }),
      );
    }

    // Fresh, not memoised: this decides whether an act may run at all, and
    // a three-second-old answer is the wrong basis for that.
    const before = await readNetworkStatus(entry, ctx, { fresh: true });
    // `"join"`: required SECRETS are exempt here because join is the act that
    // stores them (the credential paste-box); required non-secret settings are
    // still demanded. See `configurationRefusal`.
    const refusal = readinessRefusal(before, entry.manifest.name) ?? configurationRefusal(entry, ctx, "join");
    if (refusal) {
      release();
      return status(refusal.status, apiErrorBody({ code: refusal.code, message: refusal.message }));
    }

    // Exhaustive by construction: a present credential is non-blank by the
    // 400 above, so truthy here means exactly "pasted", and absent means
    // exactly "interactive" — which is what the audit row's `mode` claims.
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
        let after = await readNetworkStatus(entry, ctx, { fresh: true });
        if (outcome.state === "needs-login") {
          send({ type: "line", text: `Open ${outcome.loginUrl} to finish signing in.` });
        }

        /**
         * JOIN IS THE PUBLISH (spec § 5.3, amended 2026-09-16). For a
         * `publishImplicit` network the join itself made the addresses answer;
         * the separate press that used to live under a heading nobody needed
         * would only re-record what membership already did — so the record
         * happens HERE and the registry follows it. An explicit-publish
         * network's join records NOTHING: those presses carry real costs
         * (public CT logs, a public tunnel) and stay user-decided.
         */
        if (resolved.manifest.publishImplicit === true && after.state === "joined" && after.addresses.length === 0) {
          // The gap, once: measured immediate on 0.66.4, but one daemon on
          // one day is not a promise. If the re-read still has no address,
          // the row goes on joined-and-unrecorded and the card's fallback
          // line is the operator's window to press.
          await new Promise((resolve) => setTimeout(resolve, PUBLISH_IMPLICIT_REPOLL_MS));
          invalidateNetworkStatus(id);
          after = await readNetworkStatus(entry, ctx, { fresh: true });
        }
        if (resolved.manifest.publishImplicit === true && after.state === "joined" && after.addresses.length > 0) {
          // ONE captured set, pinned: the record, the config write and the
          // audit row ALL speak of `addresses` — the read that confirmed
          // membership. The reload below exists only to put a fresh status on
          // the done frame; a future refactor must never widen `addresses`
          // back onto that third read, because an audit row naming addresses
          // different from the ones actually recorded and trusted is a
          // second truth about one act — exactly what `by: "join"` prevents.
          const addresses = after.addresses;
          try {
            await writeNetworkState(id, {
              published: true,
              addresses,
              port: networkDeps().port(),
              publishedAt: new Date().toISOString(),
            });
            await syncNetworkOrigins(id, resolved.manifest);
            invalidateNetworkStatus(id);
            after = await readNetworkStatus(entry, ctx, { fresh: true });
            // Two acts, two rows: the audit vocabulary counts `network.publish`,
            // and an auto-publish that left no row would make that count wrong
            // on exactly the networks where it fires most. `by: "join"` names
            // why a publish row and a join row share one press.
            await auditNetwork(request, "network.publish", id, {
              addresses: addresses.map((address) => address.url),
              by: "join",
            });
          } catch (err) {
            // The JOIN succeeded. A failed auto-publish must not rewrite it
            // into an error frame — the machine is genuinely on the network,
            // and the row lands in the gap state, which already carries its
            // one line and the recording press. Half-failure inside the block
            // (recorded but not audited, or written but not reported) is
            // exactly why the fallback press is idempotent by design: the
            // publish route re-records the same addresses and the registry
            // re-follows.
            const reason = err instanceof Error ? err.message : String(err);
            getLogger().withError(err).warn(`network "${id}": the join succeeded but its auto-publish failed`);
            send({
              type: "line",
              text: `Joined ${entry.manifest.name}, but the server could not record the publish: ${reason}. The card keeps a "${entry.manifest.network?.labels?.publish ?? "Publish"}" press for exactly this.`,
            });
          }
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
        "Joins this host to the network, with a pasted credential or interactively (admin cookie only). STREAMS application/x-ndjson: {type:line,text} frames, then one {type:done,outcome,status} or {type:error,message}. A malformed credential is the plugin's own refusal and arrives as an error frame, because the body is already open by then — but a PRESENT-BUT-BLANK one is 400 before the stream opens, because which flow the request IS cannot be guessed from an empty field. For a publishImplicit network the join IS the publish: it records the publish, which trusts the addresses for sign-in at once, and audits its own network.publish row (by: join); an explicit-publish network's join records nothing. Audited as network.join with the mode and the outcome — never the credential.",
    },
  },
);
