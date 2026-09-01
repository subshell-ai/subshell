import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { HttpError } from "@/api/auth-guard.js";
import { assertImportablePublicJwk } from "@/api/public-jwk.js";
import type { CreatedApiKey, NodeKeyMetadata } from "@/auth/apikey-store.js";
import { auth } from "@/auth.js";
import { APP_BASE_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { controlPublicJwkJson } from "@/services/nodes/control-keys.js";

/** Enrollment body (spec 2026-08-31 §5.2) — machine identity facts + the setup key. */
const EnrollBodySchema = t.Object({
  setupKey: t.String({
    minLength: 8,
    maxLength: 128,
    description: "One-time `nsk_…` setup key minted under Settings → Node setup keys",
  }),
  name: t.String({ minLength: 1, maxLength: 64, description: "Display name for the new node (unique per owner)" }),
  os: t.Union([t.Literal("linux"), t.Literal("darwin"), t.Literal("unknown")], {
    description: "Operating system reported by the agent (mirrors the `ready` frame validator)",
  }),
  arch: t.String({
    minLength: 1,
    maxLength: 64,
    description: "CPU architecture reported by the agent (e.g. x64, arm64)",
  }),
  hostname: t.String({ minLength: 1, maxLength: 128, description: "Machine hostname reported by the agent" }),
  agentVersion: t.String({ minLength: 1, maxLength: 32, description: "mote-agent version reporting in" }),
  publicKey: t.String({
    minLength: 16,
    maxLength: 2048,
    description: "JSON-serialized P-256 ECDH-ES PUBLIC JWK (no private component) for sealed delivery to this node",
  }),
});

/** What the agent needs to connect: its id, its one-time bearer key, the key to pin, the endpoint. */
const EnrollResponseSchema = t.Object({
  nodeId: t.String({ description: "Server-assigned node id (uuid)" }),
  nodeKey: t.String({ description: "Plaintext node bearer key — shown exactly once here; only its hash is stored" }),
  controlPublicKey: t.String({
    description: "JSON-serialized control-plane signing public JWK; the agent pins it to verify commands",
  }),
  wsUrl: t.String({ description: "WebSocket endpoint for this node (`wss://` when APP_BASE_URL is https)" }),
});

/** The agent's connect endpoint, derived from the instance's canonical URL (https → wss). */
function nodeWsUrl(): string {
  const url = new URL(APP_BASE_URL);
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/ws/node`;
}

/** True when a failed insert hit the per-owner unique name index (idx_nodes_owner_name). */
function isUniqueNameViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed") && msg.includes("nodes");
}

/**
 * `POST /api/nodes/enroll` — redeem a setup key into a provisioned node
 * (spec 2026-08-31 §5.2). PUBLIC by design: the single-use setup key IS the
 * credential, so no authGuard runs here (the `consume()` transaction is the
 * authentication step — one winner per plaintext).
 *
 * Write order is crash-safe: EVERYTHING validates before the key is spent
 * (body caps → JWK importability), then `consume` → node row → identity →
 * api key → bind. Steps after `consume` are not atomic with it: if any of
 * them throws, the setup key stays CONSUMED (honest: retry needs a fresh
 * key) — partially created rows are deleted best-effort and the caller gets
 * a 500. A duplicate (owner, name) surfaces from the unique index as 409
 * `NODE_NAME_TAKEN`; the spent key is not refunded either.
 */
export const enrollRoute = new Elysia().use(apiModels).post(
  "/enroll",
  async ({ body, status }) => {
    // ── Validate BEFORE consuming (pinned by tests: a bad body must leave the key redeemable).
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.publicKey);
    } catch {
      return status(
        400,
        apiErrorBody({ code: BackendErrorCodes.INPUT_VALIDATION_ERROR, message: "publicKey must be a JSON JWK" }),
      );
    }
    try {
      await assertImportablePublicJwk(parsed);
    } catch (err) {
      return status(
        400,
        apiErrorBody({
          code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
          message: err instanceof HttpError ? err.message : "publicKey must be a valid P-256 public JWK",
        }),
      );
    }

    // ── Consume: single-winner redemption. Invalid, expired, and already-used
    // all read as null from `consume()` — one honest code for all three (the
    // spec lists SETUP_KEY_INVALID/EXPIRED/CONSUMED; distinguishing them from
    // the response alone would probe key state for a holder of near-matching keys).
    const nodeId = crypto.randomUUID();
    const keyRow = await new NodeSetupKeysRepository(db).consume(body.setupKey, nodeId);
    if (!keyRow) {
      return status(
        401,
        apiErrorBody({
          code: BackendErrorCodes.SETUP_KEY_INVALID,
          message: "Setup key is invalid, expired, or already used.",
        }),
      );
    }

    // ── Provision. From here on the key is SPENT regardless of outcome.
    const nodes = new NodesRepository(db);
    let nodeRowCreated = false;
    try {
      await nodes.create({
        id: nodeId,
        ownerUserId: keyRow.ownerUserId,
        name: body.name,
        kind: "agent",
        status: "offline",
        os: body.os,
        arch: body.arch,
        hostname: body.hostname,
        agentVersion: body.agentVersion,
        publicKey: body.publicKey,
      });
      nodeRowCreated = true;
      await new IdentitiesRepository(db).register({
        principalId: `node:${nodeId}`,
        publicKey: body.publicKey,
        displayName: body.name,
      });
      // Node key: long-lived (no expiresIn — revocation is delete-node,
      // spec §5.4), least-privilege, and kind-tagged so REST refuses it
      // (auth-guard) and only /ws/node accepts it.
      const metadata: NodeKeyMetadata = { kind: "node", nodeId };
      const created = (await auth.api.createApiKey({
        body: {
          name: `node:${nodeId}`,
          userId: keyRow.ownerUserId,
          metadata,
          permissions: { nodes: ["read", "write"] },
        },
      })) as unknown as CreatedApiKey;
      await nodes.setApiKeyId(nodeId, created.id);
      await audit({
        actorUserId: keyRow.ownerUserId,
        action: "node.enroll",
        targetType: "node",
        targetId: nodeId,
        metadataJson: JSON.stringify({ name: body.name, setupKeyId: keyRow.id }),
      });
      return status(201, {
        nodeId,
        nodeKey: created.key,
        controlPublicKey: await controlPublicJwkJson(),
        wsUrl: nodeWsUrl(),
      });
    } catch (err) {
      if (isUniqueNameViolation(err)) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_NAME_TAKEN,
            message: `You already have a node named "${body.name}"`,
            metadataSafe: { name: body.name },
          }),
        );
      }
      // Unknown failure after the key was spent: best-effort rollback of the
      // partial rows, then a 500 that says the key is burned. The api key,
      // if it was minted, is unrecoverable here (no id) — /ws/node can never
      // have accepted it (no node row will exist), so it is inert.
      if (nodeRowCreated) {
        try {
          await db.deleteFrom("identities").where("principalId", "=", `node:${nodeId}`).execute();
        } catch {
          /* best-effort */
        }
        try {
          await nodes.deleteById(nodeId);
        } catch {
          /* best-effort */
        }
      }
      return status(
        500,
        apiErrorBody({
          code: BackendErrorCodes.INTERNAL_SERVER_ERROR,
          message:
            "Node enrollment failed after the setup key was consumed — the key is spent; issue a new one and retry.",
          causedBy: err,
        }),
      );
    }
  },
  {
    body: EnrollBodySchema,
    response: {
      201: EnrollResponseSchema,
      400: "ApiErrorResponse",
      401: "ApiErrorResponse",
      409: "ApiErrorResponse",
      500: "ApiErrorResponse",
    },
    detail: {
      operationId: "enrollNode",
      tags: ["nodes"],
      description:
        "Redeems a single-use setup key into an enrolled node (public — the setup key is the credential); returns the node id, its bearer key (once), the control public JWK, and the ws URL",
    },
  },
);
