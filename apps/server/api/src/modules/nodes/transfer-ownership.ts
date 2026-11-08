import { db } from "@/db/index.js";
import { audit } from "@/modules/audit.js";
import { setApiKeyOwner } from "@/modules/auth/apikey-store.js";
import { getRelayBroker } from "@/modules/ssh/relay-broker.js";
import { HttpError } from "@/shared/errors.js";

/**
 * The ownership handover act (spec 2026-11-07): one node row moves to another
 * account in a single transaction, and the machine never notices. The link
 * binding (`nodes.apiKeyId`) is untouched and its bearer key is RE-HOMED with
 * the row, so `/ws/node` keeps verifying the same key against the same id,
 * running panes keep their rows, and no socket is evicted. What does die:
 * recovery setup keys minted for this node but never used - they were the
 * outgoing owner's invitation, and handing a stranger's machine to a new
 * account through a still-live key is the fake success this act refuses.
 *
 * Why the apikey write rides THIS transaction: app and auth are two handles
 * on one SQLite file, and a write through `authDatabase()` would commit
 * outside the transaction - leaving a window where the row names bob and the
 * key still belongs to alice. `setApiKeyOwner` runs its raw SQL on `tx` for
 * exactly that reason (the rotate route's in-transaction apikey UPDATE is the
 * precedent).
 *
 * The caller (the route) has already refused `local`, non-owners, and bad
 * recipients; this module does no authorization of its own. A name collision
 * against the recipient's fleet surfaces as the index's own UNIQUE violation
 * (the route maps it to 409 `NODE_NAME_TAKEN`), which rolls the whole thing
 * back — nothing moves, then and there.
 */
export interface NodeTransferInput {
  /** The node being handed over. */
  nodeId: string;
  /** The current owner; the swap only lands while the row still says so. */
  fromUserId: string;
  /** The account taking ownership. */
  toUserId: string;
  /** When true, the outgoing owner comes back as exactly one `manage` grantee. */
  retainAccessAsManager: boolean;
  /** The node's bearer key row id, re-homed with the machine. */
  apiKeyId: string | null;
}

/**
 * Move the node, re-home its key, void unused recovery keys, optionally
 * share it back at `manage`, and audit the act. Ids only in the audit —
 * never key material. No live announce: `node.changed` is not a thing the
 * bus publishes, so the SPA learns by refetch, same as after a shares edit.
 */
export async function transferNodeOwnership(input: NodeTransferInput): Promise<void> {
  const { nodeId, fromUserId, toUserId, retainAccessAsManager, apiKeyId } = input;
  const now = new Date().toISOString();

  await db.transaction().execute(async (tx) => {
    // Compare-and-swap on the owner: whoever raced us to this row (a parallel
    // transfer, a delete-and-re-enroll) makes this a 0-row update, and the
    // caller is told to refresh rather than overwrite blind (rotate's shape).
    const moved = await tx
      .updateTable("nodes")
      .set({ ownerUserId: toUserId, updatedAt: now })
      .where("id", "=", nodeId)
      .where("ownerUserId", "=", fromUserId)
      .returning("id")
      .executeTakeFirst();
    if (!moved) throw new HttpError(409, "Node ownership changed; refresh and retry");

    // The giver's own rows leave the set whichever way the option went: a
    // round-trip transfer or a shares edit naming the owner can plant a row,
    // and `retainAccessAsManager: false` promised a clean break — a leftover
    // manage row would survive an act the giver explicitly declined. Every
    // OTHER grantee's row survives untouched, ids included.
    await tx.deleteFrom("nodeShares").where("nodeId", "=", nodeId).where("granteeUserId", "=", fromUserId).execute();
    if (retainAccessAsManager) {
      await tx
        .insertInto("nodeShares")
        .values({
          id: crypto.randomUUID(),
          nodeId,
          granteeUserId: fromUserId,
          permission: "manage",
          createdBy: fromUserId,
          createdAt: now,
        })
        .execute();
    }

    if (apiKeyId) await setApiKeyOwner(tx, apiKeyId, toUserId);

    await tx.deleteFrom("nodeSetupKeys").where("targetNodeId", "=", nodeId).where("usedAt", "is", null).execute();
  });

  // The shares route's mandatory revocation cut, same posture: whoever lost
  // launch access by this move (a clean-break giver, typically) must not keep
  // streaming through a relay brokered under the old authority. The broker's
  // read is authorization-only, so a retained manage grantee sails through it
  // untouched, and the node's own link and running panes stay as they were.
  await getRelayBroker().closeUnauthorizedForNode(nodeId);

  await audit({
    actorUserId: fromUserId,
    action: "node.owner_transfer",
    targetType: "node",
    targetId: nodeId,
    metadataJson: JSON.stringify({ fromUserId, toUserId, retainAccessAsManager }),
  });
}
