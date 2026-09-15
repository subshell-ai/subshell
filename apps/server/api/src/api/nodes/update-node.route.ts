import { BackendErrorCodes } from "@internal/backend-errors";
import {
  hostReleaseTarget,
  NODE_RESULT_DIGEST_MISMATCH,
  NODE_RESULT_DOWNLOAD_FAILED,
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NOT_COMPILED,
  NODE_RESULT_NOT_SUPERVISED,
  NODE_RESULT_VERSION_MISMATCH,
  type NodeTarget,
} from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { APP_BASE_URL } from "@/constants.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { artifactStat } from "@/lib/node-artifacts.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { getHeld, getLive } from "@/services/nodes/node-registry.js";
import { NodeRpcError, sendCommand, UPDATE_COMMAND_TIMEOUT_MS } from "@/services/nodes/node-rpc.js";
import { mintUpdateToken } from "@/services/nodes/update-tokens.js";
import { autoFetchEnabled, compatibleNodeRelease, fetchDigest } from "@/services/releases.js";

const UpdateBodySchema = t.Object({
  force: t.Optional(
    t.Boolean({
      description: "Update even though the node's service definition would take live panes down on the restart",
    }),
  ),
});

const UpdateResponseSchema = t.Object({
  ok: t.Literal(true, { description: "The agent accepted the update and is restarting into the new binary" }),
  from: t.String({ description: "The agent version that was running there" }),
  to: t.String({ description: "The version installed" }),
  url: t.String({
    description:
      "The download URL the node was given, WITHOUT its single-use token — so a page can warn when this server's APP_BASE_URL names loopback and a remote node therefore dialled itself",
  }),
});

/** One refusal, as an API code and a sentence a person can act on. */
interface Refusal {
  code: BackendErrorCodes;
  message: string;
}

/**
 * The agent's refusal → an API code and message.
 *
 * Matched on `NodeRpcError.detail` — the agent's `result.error` VERBATIM — by
 * equality against the protocol's own constants, exactly as
 * `service-node.route.ts` does and for the same reason: `err.message` wraps
 * that string in a sentence this module does not own, so a substring match
 * would change meaning the day the sentence is reworded.
 *
 * `unsupported` is the one that matters most here, because it is the ORDINARY
 * answer from the machines this feature exists for: an agent below the floor
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
        "That agent predates the update command, so this server cannot replace it from here; update this node by hand with `subshell update` on that machine",
    };
  }
  if (err.detail === NODE_RESULT_NOT_SUPERVISED) {
    return {
      code: BackendErrorCodes.NODE_NOT_SUPERVISED,
      message:
        "That agent is not running under a service manager, so nothing would restart it into the new binary; update it where it was started",
    };
  }
  if (err.detail === NODE_RESULT_KILLS_PANES) {
    return {
      code: BackendErrorCodes.NODE_RESTART_KILLS_PANES,
      message:
        paneSafety === "unknown"
          ? "That node's service definition could not be read, so whether the restart keeps its running subshells is unknown; update anyway with force, or repair the definition on that machine"
          : "That node's service definition would close every subshell running on it when it restarts; reinstall the definition on that machine, or update anyway with force",
    };
  }
  if (err.detail === NODE_RESULT_NOT_COMPILED) {
    return {
      code: BackendErrorCodes.NODE_UPDATE_FAILED,
      message:
        "That agent runs from a source checkout rather than a compiled binary, so there is no file to replace; update that checkout instead",
    };
  }
  if (err.detail === NODE_RESULT_DOWNLOAD_FAILED) {
    return {
      code: BackendErrorCodes.NODE_UPDATE_FAILED,
      message:
        "That node could not download the new binary from this server. Check that the address it dials is reachable from that machine, then try again — the download link is single-use and a fresh one is minted each time",
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
  if (err.code === "failed") {
    return { code: BackendErrorCodes.NODE_UPDATE_FAILED, message: err.message };
  }
  return { code: BackendErrorCodes.NODE_UNREACHABLE, message: err.message };
}

/**
 * `POST /api/nodes/:id/update` — replace an enrolled node's agent binary
 * (spec 2026-09-15 §5.3).
 *
 * **This is the route a HELD node exists for.** An agent the plane refuses for
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
 * agent presents instead.
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

      // WHICH version to offer is `compatibleNodeRelease`, never "the newest":
      // installing an agent this plane cannot talk to would enrol, reconnect
      // and be held forever — which is the exact state this route exists to
      // get a machine OUT of, so producing it here would be a loop.
      const { release, reason } = await compatibleNodeRelease().catch((err: unknown) => ({
        release: null,
        reason: err instanceof Error ? err.message : String(err),
      }));
      if (!release) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_UPDATE_UNAVAILABLE,
            message: `This server cannot offer a node release: ${reason ?? "no compatible release was found"}`,
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
      // or fetchable before the command goes out — otherwise the agent gets a
      // 404 and reports a download failure whose real cause is here.
      if (!artifactStat(target) && !autoFetchEnabled()) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_UPDATE_UNAVAILABLE,
            message: `This server has no ${target} agent binary published and fetches no releases (SUBSHELL_RELEASE_URL is empty); publish one with \`bun run release:node\`, or update that machine by hand`,
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

      // The SAME base the enroll script bakes, so the loopback trap is the one
      // an operator already knows about — and the response echoes the url
      // (tokenless) so the page can say "this node was told to dial 127.0.0.1"
      // rather than leaving a remote machine's failure unexplained.
      const base = APP_BASE_URL.replace(/\/+$/, "");
      const publicUrl = `${base}/api/downloads/node/${target}`;
      const token = mintUpdateToken(gate.row.id, target);

      const from = held?.agentVersion ?? gate.row.agentVersion ?? "unknown";
      // Read BEFORE sending: the command is about to take this socket down,
      // and this is what decides the WORDING of a pane-safety refusal.
      const paneSafety = live?.agent?.runtime?.service.paneSafety;
      try {
        await sendCommand(
          gate.row.id,
          {
            type: "update",
            version: release.version,
            url: `${publicUrl}?update_token=${token}`,
            sha256,
            ...(body.force === true ? { force: true } : {}),
          },
          // A download, not a tmux round trip: the default 10 s deadline would
          // time out every real update. The override is per-command rather
          // than a raised default — see UPDATE_COMMAND_TIMEOUT_MS.
          { timeoutMs: UPDATE_COMMAND_TIMEOUT_MS },
        );
      } catch (err) {
        if (err instanceof NodeRpcError) {
          const refusal = refusalFor(err, paneSafety);
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
          "Replace an enrolled node's agent binary with the release this server can talk to, and restart it into the new version. Works on a HELD node — one the plane refuses for its version or protocol — which is the case it exists for. 409 when offline, when no compatible release can be offered, when there is no artifact for that platform, and for every refusal the agent itself raises",
      },
    },
  );
