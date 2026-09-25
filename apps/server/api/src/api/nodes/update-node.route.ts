import { BackendErrorCodes } from "@internal/backend-errors";
import {
  hostReleaseTarget,
  NODE_RESULT_DIGEST_MISMATCH,
  NODE_RESULT_DOWNLOAD_FAILED,
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_MANIFEST_UNVERIFIED,
  NODE_RESULT_NOT_COMPILED,
  NODE_RESULT_NOT_SUPERVISED,
  NODE_RESULT_VERSION_MISMATCH,
  NODE_SIGNED_UPDATES_PROTOCOL_VERSION,
  type NodeTarget,
  semverLt,
} from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { APP_BASE_URL } from "@/constants.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { artifactStat, diskArtifactSha256, staleArtifactRefusal } from "@/lib/node-artifacts.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { getHeld, getLive } from "@/services/nodes/node-registry.js";
import { NodeRpcError, sendCommand, UPDATE_COMMAND_TIMEOUT_MS } from "@/services/nodes/node-rpc.js";
import { mintUpdateToken } from "@/services/nodes/update-tokens.js";
import { beginUpdate, updateOutcomeUnknown, updateRefused, updateSwapped } from "@/services/nodes/update-tracker.js";
import { autoFetchEnabled, compatibleNodeRelease, fetchDigest } from "@/services/releases.js";

const UpdateBodySchema = t.Object({
  force: t.Optional(
    t.Boolean({
      description: "Update even though the node's service definition would take live panes down on the restart",
    }),
  ),
});

const UpdateResponseSchema = t.Object({
  ok: t.Literal(true, { description: "The node accepted the update and is restarting into the new binary" }),
  from: t.String({ description: "The node version that was running there" }),
  to: t.String({ description: "The version installed" }),
  url: t.String({
    description:
      "The download URL the node was given, WITHOUT its single-use token, so a page can warn when this server's APP_BASE_URL names loopback and a remote node therefore dialled itself",
  }),
});

/** One refusal, as an API code and a sentence a person can act on. */
interface Refusal {
  code: BackendErrorCodes;
  message: string;
}

/**
 * The node's refusal → an API code and message.
 *
 * Matched on `NodeRpcError.detail` — the node's `result.error` VERBATIM — by
 * equality against the protocol's own constants, exactly as
 * `service-node.route.ts` does and for the same reason: `err.message` wraps
 * that string in a sentence this module does not own, so a substring match
 * would change meaning the day the sentence is reworded.
 *
 * `unsupported` is the one that matters most here, because it is the ORDINARY
 * answer from the machines this feature exists for: a node below the floor
 * has no `update` executor, so a held node running anything older than 0.9.0
 * lands here. The message names the verb to type at the keyboard, which is the
 * only remedy left for it.
 */
function refusalFor(err: NodeRpcError, paneSafety: "keeps" | "kills" | "unknown" | undefined): Refusal {
  if (err.code === "offline") {
    return { code: BackendErrorCodes.NODE_OFFLINE, message: err.message };
  }
  if (err.code === "unsupported") {
    return {
      code: BackendErrorCodes.NODE_AGENT_TOO_OLD,
      message:
        "That node predates the update command, so this server cannot replace it from here; update this node by hand with `subshell update` on that machine",
    };
  }
  if (err.detail === NODE_RESULT_NOT_SUPERVISED) {
    return {
      code: BackendErrorCodes.NODE_NOT_SUPERVISED,
      message:
        "That node is not running under a service manager, so nothing would restart it into the new binary; update it where it was started",
    };
  }
  if (err.detail === NODE_RESULT_KILLS_PANES) {
    return {
      code: BackendErrorCodes.NODE_RESTART_KILLS_PANES,
      // Only `kills` earns the certain sentence; `unknown` and `undefined`
      // (no frozen runtime report at all) are both "nobody read the
      // definition" and say so — the `service-node.route.ts` rule, mirrored.
      message:
        paneSafety === "kills"
          ? "That node's service definition would close every subshell running on it when it restarts; reinstall the definition on that machine, or update anyway with force"
          : "That node's service definition could not be read, so whether the restart keeps its running subshells is unknown; update anyway with force, or repair the definition on that machine",
    };
  }
  if (err.detail === NODE_RESULT_NOT_COMPILED) {
    return {
      code: BackendErrorCodes.NODE_UPDATE_FAILED,
      message:
        "That node runs from a source checkout rather than a compiled binary, so there is no file to replace; update that checkout instead",
    };
  }
  if (err.detail === NODE_RESULT_DOWNLOAD_FAILED) {
    return {
      code: BackendErrorCodes.NODE_UPDATE_FAILED,
      message:
        "That node could not download the new binary from this server. Check that the address it dials is reachable from that machine, then try again. The download link is single-use and a fresh one is minted each time",
    };
  }
  if (err.detail === NODE_RESULT_DIGEST_MISMATCH) {
    return {
      code: BackendErrorCodes.NODE_UPDATE_FAILED,
      message:
        "The bytes that node downloaded did not match the published digest, so nothing was installed there. Its binary is untouched",
    };
  }
  if (err.detail === NODE_RESULT_VERSION_MISMATCH) {
    return {
      code: BackendErrorCodes.NODE_UPDATE_FAILED,
      message:
        "The binary that node downloaded reports a different version from the one this server offered, so it was not installed. Its binary is untouched",
    };
  }
  if (err.detail === NODE_RESULT_MANIFEST_UNVERIFIED) {
    // The node refused on the PUBLISHER's signature. The plane verified the
    // same manifest before sending, so this detail arriving here means the
    // two ends disagree about the release — which names the node's build
    // (an old pubkey baked in) or the release source (two assets for one
    // tag), not this command.
    return {
      code: BackendErrorCodes.NODE_UPDATE_FAILED,
      message:
        "That node refused the release because the publisher signature on its manifest did not verify against the key compiled into its binary, so nothing was installed there. Its binary is untouched",
    };
  }
  if (err.code === "failed") {
    return { code: BackendErrorCodes.NODE_UPDATE_FAILED, message: err.message };
  }
  return { code: BackendErrorCodes.NODE_UNREACHABLE, message: err.message };
}

/**
 * `POST /api/nodes/:id/update` — replace an enrolled node's own binary
 * (spec 2026-09-15 §5.3).
 *
 * **This is the route a HELD node exists for.** A node the plane refuses for
 * its version or its protocol is no longer dropped: `node-ws-handler` holds its
 * socket, offline for every purpose but this one, and `sendCommand` routes to
 * the held socket when there is no live one. So the machine that most needs
 * updating — the one this server cannot otherwise talk to at all — is reachable
 * from a browser rather than only from a shell on it.
 *
 * Gate: cookie only, owner or `edit` (`nodeCanConfigure`) — the same gate
 * `service restart` carries, because that is what this is: a restart with a
 * file swap in front of it. The honest note is about AVAILABILITY rather than
 * confidentiality, and it is the restart route's note verbatim: an `edit`
 * grantee may briefly take every subshell on a machine they do not own
 * offline, the owner's and other grantees' included.
 *
 * `local` → 400 BEFORE the permission check, for the reason every node-service
 * route gives: the control-plane host updates itself through
 * `/api/admin/server/update`, and routing it here would hand a node's `edit`
 * grantee a way to replace the control plane's own binary.
 *
 * **The URL carries a single-use token, not a node credential.** A node key can
 * do nothing on REST (security §5.5) and that stays true — `update-tokens.ts`
 * mints a value good for one download of one triple for ten minutes, which the
 * node presents instead.
 */
export const updateNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/update",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node updates are restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (gate.row.kind === "local") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "The control-plane host updates with the server, from Server Settings → Updates",
          }),
        );
      }
      if (!nodeCanConfigure(gate.access)) throw new ForbiddenError();

      // Reachable at all? A held socket counts — it is the case this exists
      // for — and it is checked HERE rather than being left to `sendCommand`'s
      // own offline rejection so the refusal precedes the release lookup and
      // the token mint, neither of which is worth doing for a dark machine.
      const live = getLive(gate.row.id);
      const held = getHeld(gate.row.id);
      if (!live && !held) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_OFFLINE,
            message: "That node is not connected, so nothing can be sent to it; it will not update until it dials back",
          }),
        );
      }

      // Protocol before anything else (spec 2026-09-17 §6): a node below 12
      // parses the `update` command but IGNORES `manifest`/`manifestSig`, so
      // sending it the signed release would silently install on the old
      // trust rule — the exact downgrade this whole change closes. Held rows
      // carry the protocol the refused socket reported; a never-ready row has
      // null, and "we do not know it checks signatures" is answered the same
      // way as "we know it does not".
      const protocol = held?.protocolVersion ?? gate.row.protocolVersion ?? null;
      if (protocol === null || protocol < NODE_SIGNED_UPDATES_PROTOCOL_VERSION) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_AGENT_TOO_OLD,
            message: `That node predates signed updates${protocol === null ? "" : ` (it speaks protocol ${protocol}, signed updates need ${NODE_SIGNED_UPDATES_PROTOCOL_VERSION})`}, so this server will not order it to install an unchecked binary; update it by hand with \`subshell update\` on that machine, which verifies the publisher signature itself`,
          }),
        );
      }

      // WHICH version to offer is `compatibleNodeRelease`, never "the newest":
      // installing a node this plane cannot talk to would enrol, reconnect
      // and be held forever — which is the exact state this route exists to
      // get a machine OUT of, so producing it here would be a loop.
      const { release, reason, manifest } = await compatibleNodeRelease().catch((err: unknown) => ({
        release: null,
        reason: err instanceof Error ? err.message : String(err),
        manifest: null,
      }));
      // `manifest` is present exactly when `release` is — a release only
      // clears `compatibleNodeRelease` once its signature verified — but the
      // null-narrowing is spelled here rather than trusted, because what
      // follows puts those bytes on the wire.
      if (!release || manifest === null) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_UPDATE_UNAVAILABLE,
            message: `This server cannot offer a node release: ${reason ?? "no compatible release was found"}`,
          }),
        );
      }

      // Nothing to do, stated BEFORE the artifact and digest work: a node
      // already on the newest offerable release would re-download and
      // reinstall the same ~70 MB binary, and one AHEAD of it would silently
      // downgrade. A node that never reported a version falls through: an
      // update may be exactly what fixes the ignorance. Equality is spelled
      // as two failing `semverLt`s rather than a string compare; the
      // comparator reads only numeric segments, so a build suffix is the same
      // release here, which is exactly right for an offer that installs one
      // artifact per number. That this gate sits AFTER the protocol check is
      // deliberate and spec-pinned (2026-09-17 §6, "protocol before anything
      // else"): below-protocol cannot be updated from here whatever its
      // version, and the page must say so even about a node that needs
      // nothing. The Updates table states its reasons in its own order
      // instead, because there up-to-date outranks the protocol sentence;
      // both answers are true for their own surface.
      // Prefer the HELD record's version when both exist (the admin rows read
      // row-then-held, this route held-then-row): `applyReady` persists before
      // either gate runs, so the two cannot disagree in practice — the
      // asymmetry is about which one is NEWER when they ever do, and a held
      // socket's fresh handshake outranks the DB row it refused from.
      const reported = held?.agentVersion ?? gate.row.agentVersion ?? null;
      if (reported !== null && !semverLt(reported, release.version)) {
        if (!semverLt(release.version, reported)) {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.NODE_UP_TO_DATE,
              message: `This node is already running ${release.version}, the newest release this server can offer`,
            }),
          );
        }
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.UPDATE_DOWNGRADE,
            message: `This node reports ${reported}, which is newer than the newest release this server can offer (${release.version})`,
          }),
        );
      }

      // The platform to fetch, from what the node reported about itself. A
      // held node's facts come off the held record — its `ready` was parsed
      // before the gates refused it, which is what makes this answerable for
      // exactly the machines that need it.
      const os = held?.os ?? gate.row.os;
      const arch = held?.arch ?? gate.row.arch;
      const target: NodeTarget | null = os && arch ? hostReleaseTarget(os, arch) : null;
      if (target === null) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_UPDATE_UNAVAILABLE,
            message: `No subshell binary is published for ${os ?? "unknown"}/${arch ?? "unknown"}, so this node cannot be updated from here`,
          }),
        );
      }

      // The node downloads from THIS server, so the artifact has to be on disk
      // or fetchable before the command goes out — otherwise the node gets a
      // 404 and reports a download failure whose real cause is here.
      if (!artifactStat(target) && !autoFetchEnabled()) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_UPDATE_UNAVAILABLE,
            message: `This server has no ${target} node binary published and fetches no releases (SUBSHELL_RELEASE_URL is empty); publish one with \`bun run release:cli-node\`, or update that machine by hand`,
          }),
        );
      }

      let sha256: string;
      try {
        sha256 = await fetchDigest(target);
      } catch (err) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_UPDATE_UNAVAILABLE,
            message: `This server could not read the published digest for ${target}, so it will not tell a node to install unverified bytes: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      }

      // The coherent-offer guarantee now lives in the SERVING path
      // (2026-09-21, amending the #122 guard): the update token carries THIS
      // digest, and the download route serves the verified release bytes
      // whenever the disk cache holds anything else, so a plane that can
      // fetch no longer refuses here; refusing would send an operator to
      // fix by hand what the plane now fixes itself. What remains is the
      // air-gapped backstop: a plane that fetches nothing has no release
      // bytes to serve instead, so a stale artifact would still be the bytes
      // the node downloads, and such an offer is refused before the command
      // goes out. (With SUBSHELL_RELEASE_URL empty the release lookup above
      // refuses first, because a URL install requires a signed manifest and
      // an air-gapped plane has none to send; this branch is the written
      // backstop should that ever change.)
      if (!autoFetchEnabled()) {
        // A read error is refused the way the digest read above is, never
        // papered over, and a non-Error throw must not masquerade as a
        // digest mismatch: convert here so the branches below can only ever
        // mean "could not verify".
        const onDisk = await diskArtifactSha256(target).catch((err: unknown) =>
          err instanceof Error ? err : new Error(String(err)),
        );
        if (onDisk instanceof Error) {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.NODE_UPDATE_UNAVAILABLE,
              message: `This server could not verify its published ${target} node binary against the release it offers, so it will not order an uncheckable install: ${onDisk.message}`,
            }),
          );
        }
        if (onDisk !== null && onDisk !== sha256) {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.NODE_UPDATE_UNAVAILABLE,
              message: staleArtifactRefusal(target),
            }),
          );
        }
      }

      // The SAME base the enroll script bakes, so the loopback trap is the one
      // an operator already knows about — and the response echoes the url
      // (tokenless) so the page can say "this node was told to dial 127.0.0.1"
      // rather than leaving a remote machine's failure unexplained.
      const base = APP_BASE_URL.replace(/\/+$/, "");
      const publicUrl = `${base}/api/downloads/node/${target}`;
      const token = mintUpdateToken(gate.row.id, target, sha256);

      const from = reported ?? "unknown";
      // Read BEFORE sending: the command is about to take this socket down,
      // and this is what decides the WORDING of a pane-safety refusal.
      const paneSafety = live?.agent?.runtime?.service.paneSafety;
      // The tracker opens its entry the instant the order is real (design
      // 2026-09-25): AFTER every 409 gate above, because a refused offer
      // ordered nothing and must not render as an update in flight, and BEFORE
      // `sendCommand`, because a refresh during the ~70 MB download is the
      // case this whole module exists for.
      beginUpdate(gate.row.id, { from, to: release.version });
      try {
        await sendCommand(
          gate.row.id,
          {
            type: "update",
            version: release.version,
            url: `${publicUrl}?update_token=${token}`,
            sha256,
            // The verified manifest travels WITH the order (spec 2026-09-17
            // §6): the envelope's signature still says WHO ordered it, and
            // these two fields are what let the node check WHAT will run —
            // bytes the release source published and the publisher signed,
            // not bytes this server happens to hold. `manifest` is base64 of
            // the exact bytes the plane verified; the node verifies the
            // signature over them itself, against its own compiled-in pubkey.
            manifest: Buffer.from(manifest.bytes, "utf8").toString("base64"),
            manifestSig: manifest.sig,
            ...(body.force === true ? { force: true } : {}),
          },
          // A download, not a tmux round trip: the default 10 s deadline would
          // time out every real update. The override is per-command rather
          // than a raised default — see UPDATE_COMMAND_TIMEOUT_MS.
          { timeoutMs: UPDATE_COMMAND_TIMEOUT_MS },
        );
      } catch (err) {
        if (err instanceof NodeRpcError) {
          // A TIMEOUT is the one failure that may not be one. Every other
          // refusal here is the node SAYING it did nothing; a timeout is the
          // node saying nothing at all, and this command's deadline is five
          // minutes because it contains a ~70 MB download — so a node whose
          // link is slower than that installs the binary, restarts, and comes
          // back on the new version while this request answers 409. Without
          // this row a real binary replacement would have no audit trail and
          // an error on the admin's screen.
          //
          // Its own action name, not `node.update`, because the two are
          // different claims: one says a node was updated, this one says
          // nobody knows. The reader is a person asking "why is that machine
          // on a version nothing recorded".
          if (err.code === "timeout") {
            // The tracker's twin of the `node.update.unknown` row below: the
            // entry stays observable as working so the stall clock runs and a
            // late `ready` can still resolve it (update-tracker.ts).
            updateOutcomeUnknown(gate.row.id);
            await audit({
              actorUserId: user.id,
              action: "node.update.unknown",
              targetType: "node",
              targetId: gate.row.id,
              metadataJson: JSON.stringify({ from, to: release.version, forced: body.force === true }),
            });
          }
          const refusal = refusalFor(err, paneSafety);
          // Every OTHER `NodeRpcError` is the node SAYING it did nothing, so
          // the entry closes as failed with the sentence this 409 carries. A
          // non-RPC throw re-raises untouched: the entry is left working and
          // stalls, which is the honest answer to a failure nobody witnessed.
          if (err.code !== "timeout") updateRefused(gate.row.id, refusal.message);
          return status(409, apiErrorBody({ code: refusal.code, message: refusal.message }));
        }
        throw err;
      }

      await audit({
        actorUserId: user.id,
        action: "node.update",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ from, to: release.version, forced: body.force === true }),
      });
      // The swap is confirmed — the node answered before it exits (the agent
      // quits ~500 ms after this 202). `restarting` until its next `ready`.
      updateSwapped(gate.row.id);
      return status(202, { ok: true as const, from, to: release.version, url: publicUrl });
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: UpdateBodySchema,
      response: {
        202: UpdateResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "updateNode",
        tags: ["nodes"],
        description:
          "Replace an enrolled node's own binary with the release this server can talk to, and restart it into the new version. Works on a HELD node (one the plane refuses for its version or protocol), which is the case it exists for. 409 when offline, when no compatible release can be offered, when there is no artifact for that platform, when a plane that cannot fetch holds a published binary that is not the release offered, when the node already runs the newest offerable release (NODE_UP_TO_DATE) or reports a newer one (UPDATE_DOWNGRADE), and for every refusal the node itself raises",
      },
    },
  );
