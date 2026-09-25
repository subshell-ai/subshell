import { BackendErrorCodes } from "@internal/backend-errors";
import { NODE_NAME_MAX_UNITS, normalizeNodeName } from "@internal/subshell-protocol";
import { ensureSodium } from "@internal/subshell-protocol/node-link-crypto";
import { Elysia, t } from "elysia";
import { HttpError } from "@/api/auth-guard.js";
import { assertImportablePublicJwk } from "@/api/public-jwk.js";
import type { CreatedApiKey, NodeKeyMetadata } from "@/auth/apikey-store.js";
import { getAuth } from "@/auth.js";
import { APP_BASE_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { isUniqueNameViolation } from "@/lib/node-errors.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { controlPublicJwkJson } from "@/services/nodes/control-keys.js";
import { nodeEncryptionPublicKey } from "@/services/nodes/node-encryption-keys.js";

/** Enrollment body (spec 2026-08-31 §5.2) — machine identity facts + the setup key. */
const EnrollBodySchema = t.Object({
  setupKey: t.String({
    minLength: 8,
    maxLength: 128,
    description: "One-time `nsk_…` setup key, minted on the Nodes page (Add node) and listed there until used",
  }),
  // `_UNITS`, not the cap itself: JSON Schema counts UTF-16 code units, and a
  // `64` here would 400 a name the rule below accepts — an astral character is two
  // units. `normalizeNodeName` is what enforces 64 characters.
  name: t.String({
    minLength: 1,
    maxLength: NODE_NAME_MAX_UNITS,
    description:
      "Display name for the new node (unique per owner), chosen ON THE MACHINE becoming the node: `subshell setup` asks for it there, `--name` answers for a script. Control characters are stripped and whitespace collapsed",
  }),
  os: t.Union([t.Literal("linux"), t.Literal("darwin"), t.Literal("unknown")], {
    description: "Operating system reported by the node (mirrors the `ready` frame validator)",
  }),
  arch: t.String({
    minLength: 1,
    maxLength: 64,
    description: "CPU architecture reported by the node (e.g. x64, arm64)",
  }),
  hostname: t.String({ minLength: 1, maxLength: 128, description: "Machine hostname reported by the node" }),
  agentVersion: t.String({ minLength: 1, maxLength: 32, description: "subshell version reporting in" }),
  publicKey: t.String({
    minLength: 16,
    maxLength: 2048,
    description: "JSON-serialized P-256 ECDH-ES PUBLIC JWK (no private component) for sealed delivery to this node",
  }),
  // Optional so a pre-v14 one-liner still enrolls (spec 2026-09-24 §5): the row
  // then stores NULL and the node registers its static on first connect. A
  // PRESENT value is decoded and length-checked below — like `publicKey` above,
  // BEFORE the setup key is spent.
  encryptPublicKey: t.Optional(
    t.String({
      minLength: 43,
      maxLength: 44,
      description:
        "Base64 X25519 PUBLIC key for /ws/node link encryption (the node's long-term static, spec 2026-09-24 §3); absent enrolls the node in legacy mode until it registers on first connect",
    }),
  ),
});

/** What the agent needs to connect: its id, its one-time bearer key, the key to pin, the endpoint. */
const EnrollResponseSchema = t.Object({
  nodeId: t.String({ description: "Server-assigned node id (uuid)" }),
  nodeKey: t.String({ description: "Plaintext node bearer key; shown exactly once here; only its hash is stored" }),
  controlPublicKey: t.String({
    description: "JSON-serialized control-plane signing public JWK; the node pins it to verify commands",
  }),
  // Always present (NOT optional): a v14 agent treats its absence as a
  // malformed response and refuses to enroll, which is the fail-closed posture
  // for the encrypted link (spec 2026-09-24 §3 — the agent must never silently
  // provision without the pin).
  controlEncryptPublicKey: t.String({
    description:
      "Base64 X25519 PUBLIC key: the control plane's static for /ws/node link encryption; the node pins it as `controlEncryptPublicKey`",
  }),
  wsUrl: t.String({
    description:
      "WebSocket endpoint for this node: APP_BASE_URL's scheme (https → wss) and pathname (subpath mounts preserved) with `/ws/node` appended",
  }),
});

/**
 * The agent's connect endpoint, derived from the instance's canonical URL:
 * `https → wss`, `http → ws`, with the APP_BASE_URL **pathname preserved**
 * (minus any trailing slashes) so a reverse-proxy subpath mount
 * (`https://host/subshell`) yields `wss://host/subshell/ws/node` — the 17c follow-up:
 * this URL is persisted agent-side as the authoritative dial target, so
 * dropping the path strands every node behind a subpath mount.
 * @param baseUrl - the instance's canonical URL; defaults to {@link APP_BASE_URL}
 * @internal the parameter exists for the unit test; callers pass nothing
 */
export function nodeWsUrl(baseUrl: string = APP_BASE_URL): string {
  const url = new URL(baseUrl);
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}${url.pathname.replace(/\/+$/, "")}/ws/node`;
}

/**
 * `POST /api/nodes/enroll` — redeem a setup key into a provisioned node
 * (spec 2026-08-31 §5.2). PUBLIC by design: the single-use setup key IS the
 * credential, so no authGuard runs here (the `consume()` transaction is the
 * authentication step — one winner per plaintext).
 *
 * Write order is crash-safe: EVERYTHING validates before the key is spent
 * (setup-key state peek → body caps → JWK importability), then `consume` →
 * node row → identity → api key → bind. Steps after `consume` are not atomic
 * with it: if any of them throws, the setup key stays CONSUMED (honest: retry
 * needs a fresh
 * key) — partially created rows are deleted best-effort and the caller gets
 * a 500. A duplicate (owner, name) surfaces from the unique index as 409
 * `NODE_NAME_TAKEN`; the spent key is not refunded either.
 */
export const enrollRoute = new Elysia().use(apiModels).post(
  "/enroll",
  async ({ body, status }) => {
    // ── Key state first (ledger 17a, the P1-T6 simplification undone): a read-only
    // `peekByKey` BEFORE body validation maps the three 401 codes the spec lists —
    // absent → SETUP_KEY_INVALID, spent → SETUP_KEY_CONSUMED, past expiry →
    // SETUP_KEY_EXPIRED. The peek flips nothing (consume below stays the single-
    // winner step), so ordering it ahead of the JWK checks cannot burn a key.
    const peek = await new NodeSetupKeysRepository(db).peekByKey(body.setupKey);
    if (!peek) {
      return status(
        401,
        apiErrorBody({
          code: BackendErrorCodes.SETUP_KEY_INVALID,
          // Wording preserved verbatim from the one-honest-code era (pinned by tests).
          message: "Setup key is invalid, expired, or already used.",
          doNotLog: true,
        }),
      );
    }
    if (peek.usedAt !== null) {
      return status(
        401,
        apiErrorBody({
          code: BackendErrorCodes.SETUP_KEY_CONSUMED,
          message: "Setup key has already been used.",
          doNotLog: true,
        }),
      );
    }
    if (peek.expiresAt <= new Date().toISOString()) {
      return status(
        401,
        apiErrorBody({
          code: BackendErrorCodes.SETUP_KEY_EXPIRED,
          message: "Setup key has expired.",
          doNotLog: true,
        }),
      );
    }

    // ── Validate BEFORE consuming (pinned by tests: a bad body must leave the key redeemable).
    //
    // The name first, and normalized: this is the one door through which a node acquires
    // its name now that the mint dialog stopped asking (the machine supplies it, so it
    // arrives from a prompt, from `--name`, from the desktop field, or from a body a
    // script wrote). Same rule as rename — the shared `normalizeLabel` binding, and an
    // empty result is a refusal rather than a blank row. An OVER-long name is capped
    // by that rule rather than refused, which is what rename has always done; every
    // real client bounces it first (the CLI's preflight, the desktop field, `setup`'s
    // prompt) precisely so nobody watches their name get shorter. Before `consume`,
    // because a single-use key must not be spent by a body that cannot be stored (the
    // same argument the publicKey checks below make).
    const name = normalizeNodeName(body.name);
    if (!name) {
      return status(
        400,
        apiErrorBody({
          code: BackendErrorCodes.BAD_REQUEST,
          message: "A node name needs at least one printable character",
        }),
      );
    }

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

    // The link-encryption static (spec 2026-09-24 §3), validated in the SAME
    // pre-consume position as publicKey above — a malformed body must not burn
    // the single-use key. Shape is schema-checked (43-44 chars); the decode
    // here is what proves 32 bytes. `from_base64` throws on non-base64; a
    // wrong length is the other refusal. The STORED value is the canonical
    // re-encode of the decoded bytes, so the row's pin is always in the exact
    // spelling the handshake's byte comparison will see.
    let encryptPublicKey: string | null = null;
    if (body.encryptPublicKey !== undefined) {
      try {
        const sodium = await ensureSodium();
        const decoded = sodium.from_base64(body.encryptPublicKey);
        if (decoded.length !== 32) {
          return status(
            400,
            apiErrorBody({
              code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
              message: "encryptPublicKey must decode to 32 bytes (an X25519 public key)",
            }),
          );
        }
        encryptPublicKey = sodium.to_base64(decoded);
      } catch {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
            message: "encryptPublicKey must be a base64-encoded 32-byte X25519 public key",
          }),
        );
      }
    }

    // ── Consume: single-winner redemption — the transactional flip is still the
    // authentication step. The peek above already mapped invalid/consumed/expired,
    // so a null here means the key changed state between peek and consume (a
    // concurrent winner); that race answers with the generic SETUP_KEY_INVALID.
    const nodeId = crypto.randomUUID();
    const keyRow = await new NodeSetupKeysRepository(db).consume(body.setupKey, nodeId);
    if (!keyRow) {
      return status(
        401,
        apiErrorBody({
          code: BackendErrorCodes.SETUP_KEY_INVALID,
          message: "Setup key is invalid, expired, or already used.",
          // The race sibling of the three peek 401s above — still an expected
          // enrollment failure, so uniformly not logged (review wave consistency).
          doNotLog: true,
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
        name,
        kind: "agent",
        status: "offline",
        os: body.os,
        arch: body.arch,
        hostname: body.hostname,
        agentVersion: body.agentVersion,
        publicKey: body.publicKey,
        // Decoded-and-revalidated above (or null for a pre-v14 enroll) — never
        // the raw body string.
        encryptPublicKey,
      });
      nodeRowCreated = true;
      await new IdentitiesRepository(db).register({
        principalId: `node:${nodeId}`,
        publicKey: body.publicKey,
        displayName: name,
      });
      // Node key: long-lived (no expiresIn — revocation is delete-node,
      // spec §5.4) and kind-tagged so REST refuses it (auth-guard) and only
      // /ws/node accepts it. Deliberately NO permissions map (security-
      // actionable item 10): the kind guard rejects every node key before any
      // permission is read, and `/ws/node`'s chain reads metadata only — a
      // grant list here is a map nothing consults, and worse than nothing,
      // because widening that guard would silently activate it.
      const metadata: NodeKeyMetadata = { kind: "node", nodeId };
      const created = (await getAuth().api.createApiKey({
        body: {
          name: `node:${nodeId}`,
          userId: keyRow.ownerUserId,
          metadata,
        },
      })) as unknown as CreatedApiKey;
      await nodes.setApiKeyId(nodeId, created.id);
      await audit({
        actorUserId: keyRow.ownerUserId,
        action: "node.enroll",
        targetType: "node",
        targetId: nodeId,
        metadataJson: JSON.stringify({ name, setupKeyId: keyRow.id }),
      });
      return status(201, {
        nodeId,
        nodeKey: created.key,
        controlPublicKey: await controlPublicJwkJson(),
        controlEncryptPublicKey: await nodeEncryptionPublicKey(),
        wsUrl: nodeWsUrl(),
      });
    } catch (err) {
      if (isUniqueNameViolation(err)) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_NAME_TAKEN,
            message: `You already have a node named "${name}"`,
            metadataSafe: { name },
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
            "Node enrollment failed after the setup key was consumed; the key is spent; issue a new one and retry.",
          causedBy: err,
          // 5xx is a server fault — log it loudly (apiErrorBody defaults to "debug", which hides it).
          logLevel: "error",
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
        "Redeems a single-use setup key into an enrolled node (public, the setup key is the credential); returns the node id, its bearer key (once), the control public JWK, the control link-encryption public key (spec 2026-09-24 §3), and the ws URL",
    },
  },
);
