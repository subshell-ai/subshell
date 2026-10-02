import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { runTransfer, type TransferEndpoint } from "@/services/transfers.service.js";

/**
 * `POST /api/transfers` (spec 2026-10-01 §5): copy (or diff-sync) a directory
 * tree between two AGENT nodes, relayed by the plane through the encrypted
 * node link. The gate stack, in order and each for its own reason:
 *
 * - `requirePerm("transfers", "write")` - the new token key, with NO legacy
 *   pass (the ruling's whole point: pre-feature panes 403 until restart;
 *   the `prompts` concession is not a template for a file-move grant).
 * - STRICT ownership of BOTH endpoint nodes: the caller's account must OWN
 *   them - `resolveLaunchNode`'s machine-actor posture made the rule for
 *   every actor, human included: no admin boost, no shares. A transfer is
 *   the widest reach a node grants (reading one tree, writing another), and
 *   it is refused for anyone but the machine's owner. A foreign or absent
 *   row is the usual 404, never a 403-shaped oracle.
 * - `local` is refused BY NAME with a 400 (ruling: agent-node to agent-node
 *   only; there is no half-implemented plane-filesystem endpoint, and the
 *   browser is nowhere in this API).
 * - maintenance / no live connection are 409s UP FRONT, both endpoints
 *   checked before any frame moves (a transfer that discovers the
 *   destination offline three windows in wastes a source archive).
 *
 * The transfer itself is `transfers.service.ts`; this route only gates,
 * audits (facts, never contents: node ids, paths, byte and entry counts,
 * sync flag, outcome - spec §10) and maps the outcome to the response.
 * Refusals ride `throwApiError` like the node routes' 409 family: the
 * status is the CODE's, decided in one table, not this handler's.
 */

/** One endpoint as the request names it. */
const EndpointSchema = t.Object({
  nodeId: t.String({ description: "Agent node id; the caller must own it (local and foreign rows are refused)" }),
  path: t.String({ description: "Absolute directory ON that node; the node's operator allowlist is the authority" }),
});

const TransferBodySchema = t.Object({
  from: EndpointSchema,
  to: EndpointSchema,
  sync: t.Optional(
    t.Boolean({
      description: "True diffs on per-file SHA-256 and ships only changed files; default false copies the whole tree",
    }),
  ),
});

const TransferResultSchema = t.Object({
  sync: t.Boolean({ description: "Echo of the request mode" }),
  archiveBytes: t.Number({ description: "Compressed archive bytes relayed (0 for a no-op sync)" }),
  files: t.Number({ description: "Files extracted at the destination" }),
  bytes: t.Number({ description: "Uncompressed body bytes written at the destination" }),
  changed: t.Number({ description: "Sync only: rows the diff marked changed" }),
});

/** Resolve + gate one endpoint; every refusal names the endpoint's own reason. */
async function gateEndpoint(which: "from" | "to", ep: TransferEndpoint, userId: string): Promise<TransferEndpoint> {
  if (!ep.path.startsWith("/")) {
    throwApiError({
      code: BackendErrorCodes.BAD_REQUEST,
      message: `the ${which} path must be absolute on the node (no ~ expansion)`,
      doNotLog: true,
    });
  }
  const row = await new NodesRepository(db).findById(ep.nodeId);
  if (!row || row.ownerUserId !== userId) {
    throwApiError({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found", doNotLog: true });
  }
  if (row.kind === "local") {
    throwApiError({
      code: BackendErrorCodes.BAD_REQUEST,
      message: "transfers run between agent nodes; the control-plane host is not a transfer endpoint",
      doNotLog: true,
    });
  }
  if (row.maintenance === 1) {
    throwApiError({
      code: BackendErrorCodes.NODE_IN_MAINTENANCE,
      message: `${row.name} is in maintenance and takes no transfers`,
      doNotLog: true,
    });
  }
  if (!getLive(row.id)) {
    // A refused agent is HELD, not live (protocol §11.12), so the plain
    // offline sentence would send the caller to "bring it online" when the
    // truth is the row already knows: the version its last `ready` recorded
    // (node-ws-handler writes it BEFORE the compatibility gate, so a held
    // node has it). Name the update remedy for that case (spec R12's whole
    // point); everything else is genuinely just offline.
    if (row.protocolVersion !== null && row.protocolVersion !== NODE_PROTOCOL_VERSION) {
      throwApiError({
        code: BackendErrorCodes.NODE_AGENT_TOO_OLD,
        // "as last reported": the row records the last `ready`'s protocol and
        // cannot tell a held-now agent from a dead one that dialed back on the
        // old version before it stopped dialing at all; either way updating is
        // the action, so the remedy names itself without a false present tense.
        message: `the agent on ${row.name} spoke protocol v${row.protocolVersion} as last reported; update the node (the Nodes page asks a human)`,
        doNotLog: true,
      });
    }
    throwApiError({
      code: BackendErrorCodes.NODE_OFFLINE,
      message: `node ${row.name} has no live connection`,
      doNotLog: true,
    });
  }
  return ep;
}

export const postTransferRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/",
    async ({ body, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "transfers", "write");
      const from = await gateEndpoint("from", body.from, user.id);
      const to = await gateEndpoint("to", body.to, user.id);
      if (from.nodeId === to.nodeId && from.path === to.path) {
        throwApiError({
          code: BackendErrorCodes.BAD_REQUEST,
          message: "the transfer endpoints are the same directory",
          doNotLog: true,
        });
      }
      const sync = body.sync ?? false;
      await audit({
        actorUserId: user.id,
        action: "transfer.create",
        targetType: "transfer",
        targetId: null,
        metadataJson: JSON.stringify({
          fromNodeId: from.nodeId,
          toNodeId: to.nodeId,
          fromPath: from.path,
          toPath: to.path,
          sync,
        }),
      });
      try {
        const result = await runTransfer({ from, to, sync });
        await audit({
          actorUserId: user.id,
          action: "transfer.complete",
          targetType: "transfer",
          targetId: null,
          metadataJson: JSON.stringify({
            fromNodeId: from.nodeId,
            toNodeId: to.nodeId,
            fromPath: from.path,
            toPath: to.path,
            sync,
            outcome: "ok",
            archiveBytes: result.archiveBytes,
            files: result.files,
            bytes: result.bytes,
            changed: result.changed,
          }),
        });
        return result;
      } catch (err) {
        // The outcome row records FAILURE without echoing the sentence (an
        // agent refusal can carry a path the auditor already has).
        await audit({
          actorUserId: user.id,
          action: "transfer.complete",
          targetType: "transfer",
          targetId: null,
          metadataJson: JSON.stringify({
            fromNodeId: from.nodeId,
            toNodeId: to.nodeId,
            fromPath: from.path,
            toPath: to.path,
            sync,
            outcome: "failed",
          }),
        });
        throw err;
      }
    },
    {
      body: TransferBodySchema,
      response: {
        200: TransferResultSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "createTransfer",
        tags: ["transfers"],
        description:
          "Relay a directory tree between two agent nodes the caller owns (whole-tree copy, or diff-sync on per-file SHA-256); extraction is additive and nothing at the destination is ever deleted",
      },
    },
  );
