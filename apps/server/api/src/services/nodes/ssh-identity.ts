import { assertImportableSigningJwk } from "@/api/public-jwk.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { audit } from "@/services/audit.js";
import { sshRegisterIdentity } from "@/services/nodes/ssh-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * The §4.3 signing-key bootstrap (spec 2026-10-08): nodes that enrolled
 * before M2 hold a signing keypair on disk but have never reported its
 * public half. On `ready`, a machine whose `signingPublicKey` slot is EMPTY
 * is asked once ({@link sshRegisterIdentity}) over its already-authenticated
 * link, and the answer lands through {@link deliverSigningKey}.
 *
 * **The guard that makes this safe is the anti-silent-rotation rule.** A
 * report that DIFFERS from a key already on file is refused, NOT stored:
 * the machine that rotated its identity unilaterally must never repair its
 * own history by overwriting the record the relay verifies against (the
 * peer-side repair path is §4.5, a separate deliberate owner act). Same
 * bytes, or a first fill, are the only writes this seam can ever cause -
 * plus {@link IdentitiesRepository.fillSigningPublicKey}'s CAS, which makes
 * even a raced double-report answerable: whoever lands first owns the slot.
 *
 * No key VALUE ever enters a log line or an audit row (Global Constraint);
 * the audit names the node and `via: "link"`, and the warnings name the node
 * and the shape of the problem.
 */

/**
 * File one machine's reported signing public key into its `node:` identity
 * record. The whole guard table (spec 2026-10-08 §4.3):
 *
 * | slot holds | report | → |
 * |---|---|---|
 * | nothing | importable public JWK | store it, audit `node.ssh_identity.register` (`via: "link"`), return it |
 * | the SAME bytes | same bytes | no-op success, return it (idempotent: every re-report of a stable key is quiet) |
 * | a DIFFERENT key | anything else | REFUSE: return the existing bytes, overwrite nothing |
 * | anything | unparseable / non-importable / private-carrying JWK | refuse BEFORE any write, return null (the enroll lesson: nothing that fails the import gate is stored) |
 *
 * A node with no identity row at all gets `null`: the row is enroll's
 * artifact (its encryption half is the seal key); this seam never invents
 * one.
 *
 * @param nodeId - the node the report is about (the socket's authenticated
 *   identity at every call site; never a frame's self-claim)
 * @param signingPublicKey - the machine's JSON-serialized public JWK, as the
 *   agent answered it (wire-validated string; importability checked HERE)
 * @returns the key now on file (stored, or the existing one the report was
 *   refused against), or null when nothing is on file and nothing was stored
 */
export async function deliverSigningKey(nodeId: string, signingPublicKey: string): Promise<string | null> {
  const { repos } = getRequestlessContext();
  // Validate BEFORE touching the row: a malformed report is refused exactly
  // like the enroll route refuses it, and the refusal never reaches the DB.
  // assertImportableSigningJwk carries the public-store rule (EC/P-256 shape,
  // real curve-point import for ES256, and NO `d` - a "public" key that is
  // secretly a private one is refused, not stored).
  let parsedKey: unknown;
  try {
    parsedKey = JSON.parse(signingPublicKey);
  } catch {
    parsedKey = null;
  }
  try {
    await assertImportableSigningJwk(parsedKey);
  } catch {
    // The refuse line names the machine and the shape, never the payload.
    logger.warn(`ssh identity: node ${nodeId} reported an unusable signing key; nothing stored`);
    return null;
  }

  const principalId = `node:${nodeId}`;
  const row = await repos.identities.findByPrincipal(principalId);
  if (!row) {
    logger.warn(`ssh identity: node ${nodeId} has no identity record; refusing to invent one`);
    return null;
  }
  if (row.signingPublicKey !== null) {
    // The slot is owned. Same bytes: the quiet idempotent yes. Different
    // bytes: the §4.3 own-registration refusal - return the EXISTING key and
    // change nothing, whatever the caller expected.
    if (row.signingPublicKey !== signingPublicKey) {
      logger.warn(
        `ssh identity: node ${nodeId} reported a signing key DIFFERENT from the one on file; ` +
          "keeping the existing key (a genuine change needs a re-enroll plus per-peer re-pairs, spec §4.2/§4.5)",
      );
    }
    return row.signingPublicKey;
  }

  // The CAS write: only this call's UPDATE can flip the empty slot, so two
  // racy reports (two `ready` frames) cannot double-store or clobber.
  const stored = await repos.identities.fillSigningPublicKey(principalId, signingPublicKey);
  if (!stored) {
    const after = await repos.identities.findByPrincipal(principalId);
    return after?.signingPublicKey ?? null;
  }
  await audit({
    actorUserId: null, // the link delivered it; no human asked
    action: "node.ssh_identity.register",
    targetType: "node",
    targetId: nodeId,
    // ids/via only, never the key value (docs/security.md §10).
    metadataJson: JSON.stringify({ via: "link" }),
  });
  return signingPublicKey;
}

/**
 * The `ready`-time bootstrap body (spec 2026-10-08 §4.3): ask a node that has
 * never delivered its signing key, once, and file the answer.
 *
 * The NO-SPAM gate is the first read: a slot that already holds a key (the
 * overwhelming steady state) answers without a command, so an agent that
 * reconnects hourly costs nothing after its first contact. A node with NO
 * identity row is skipped too - there is no slot to fill and no write this
 * seam may make.
 *
 * Swallows its own failures (offline/timeout/unsupported are routine at
 * `ready`; a machine that did not answer simply asks again on the next
 * contact), so the fire-and-forget call site can be a bare statement.
 *
 * @param nodeId - the socket's authenticated identity, never a frame's claim
 */
export async function bootstrapSshIdentityOnReady(nodeId: string): Promise<void> {
  if (nodeId === LOCAL_NODE_ID) return; // no socket to ask over
  try {
    const { repos } = getRequestlessContext();
    const row = await repos.identities.findByPrincipal(`node:${nodeId}`);
    if (!row || row.signingPublicKey !== null) return; // no slot, or already filled
    const reported = await sshRegisterIdentity(nodeId);
    await deliverSigningKey(nodeId, reported);
  } catch (err: unknown) {
    // `debug`, not warn: an offline mid-boot or an agent that has not
    // upgraded into the command is the ordinary case, and the next `ready`
    // retries by construction.
    logger.withError(err).debug(`ssh identity: §4.3 bootstrap for node ${nodeId} did not land; retrying next ready`);
  }
}
