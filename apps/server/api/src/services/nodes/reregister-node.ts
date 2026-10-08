import { sql } from "kysely";
import type { CreatedApiKey, NodeKeyMetadata } from "@/auth/apikey-store.js";
import { setApiKeyEnabled } from "@/auth/apikey-store.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { NodeSetupKeyTable } from "@/db/types/node-setup-keys.db-types.js";
import { audit } from "@/services/audit.js";
import { disconnectNode, getLive, REVOKED_CLOSE_CODE } from "@/services/nodes/node-registry.js";
import { failConnPendings } from "@/services/nodes/node-rpc.js";

/** Replace machine credentials while retaining the node's registry relationships. */
export async function reregisterNode(
  key: NodeSetupKeyTable,
  machine: {
    publicKey: string;
    os: string;
    arch: string;
    hostname: string;
    agentVersion: string;
  },
  encryptPublicKey: string | null,
  /**
   * The ES256 relay signing half (spec 2026-10-08 §4.2): re-registration is a
   * fresh enrollment-grade trust event, so it REPLACES the slot rather than
   * preserving it. The machine's on-disk keypairs normally survive the
   * re-registration, so the replacement is normally the same bytes; null is
   * the pre-M2 posture until the §4.3 bootstrap reports.
   */
  signingPublicKey: string | null,
): Promise<{ nodeId: string; nodeKey: string; name: string }> {
  const nodeId = key.targetNodeId;
  if (!nodeId) throw new Error("Re-registration needs an existing node");
  const old = await new NodesRepository(db).findById(nodeId);
  if (old?.kind !== "agent" || old.ownerUserId !== key.ownerUserId || old.apiKeyId !== key.targetApiKeyId) {
    throw new Error("The re-registration target no longer exists or belongs to this key's owner");
  }
  const metadata: NodeKeyMetadata = { kind: "node", nodeId };
  const created = (await getAuth().api.createApiKey({
    body: {
      name: `node:${nodeId}`,
      userId: old.ownerUserId,
      metadata,
    },
  })) as unknown as CreatedApiKey;
  let name = old.name;
  try {
    await db.transaction().execute(async (tx) => {
      // Compare-and-swap: a concurrent rotation/re-registration must not be
      // silently overwritten with credentials based on an obsolete snapshot.
      const updated = await tx
        .updateTable("nodes")
        .set({
          ...machine,
          encryptPublicKey,
          apiKeyId: created.id,
          status: "offline",
          inventoryJson: null,
          inventoryAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where("id", "=", nodeId)
        .where("ownerUserId", "=", key.ownerUserId)
        .where("apiKeyId", key.targetApiKeyId === null ? "is" : "=", key.targetApiKeyId)
        .returning(["id", "name"])
        .executeTakeFirst();
      if (!updated) throw new Error("Node credentials changed; issue a new re-registration key and retry");
      name = updated.name;
      // Both identity halves rotate together, inside the same transaction that
      // swaps the credentials (§4.2).
      await new IdentitiesRepository(tx).register({
        principalId: `node:${nodeId}`,
        publicKey: machine.publicKey,
        signingPublicKey,
        displayName: name,
      });
      // Auth uses a separate handle to the SAME SQLite file. Revoke through
      // this transaction so a failed write rolls back the binding and identity
      // together rather than leaving two credential generations half-applied.
      if (old.apiKeyId) {
        await sql`UPDATE apikey SET enabled = 0, "updatedAt" = ${new Date().toISOString()} WHERE id = ${old.apiKeyId}`.execute(
          tx,
        );
      }
      // Outstanding recovery keys cannot replace the newly registered machine.
      await tx.deleteFrom("nodeSetupKeys").where("targetNodeId", "=", nodeId).where("usedAt", "is", null).execute();
    });
  } catch (err) {
    setApiKeyEnabled(created.id, false);
    throw err;
  }
  const evicted = getLive(nodeId);
  await disconnectNode(nodeId, REVOKED_CLOSE_CODE, "node re-registered");
  if (evicted) failConnPendings(evicted, "offline", "node re-registered");
  await audit({
    actorUserId: key.ownerUserId,
    action: "node.reregister",
    targetType: "node",
    targetId: nodeId,
    metadataJson: JSON.stringify({ setupKeyId: key.id, oldApiKeyId: old.apiKeyId, newApiKeyId: created.id }),
  });
  return { nodeId, nodeKey: created.key, name };
}
