import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { serverSubshellsEnabled } from "@/services/server-as-node.js";
import type { SshCaller, SshDecision } from "@/services/ssh/ssh-policy.js";

/**
 * The node-eligibility seam for the SSH feature - ONE implementation the
 * policy and every node-scoped route share (`ssh-policy.ts` rule 2: a local
 * copy of a named check is the drift §2 lists as the bypass risk, and the
 * policy's `SshDecision` cannot see a bare `nodeId`, so the node-scoped acts
 * - discovery, resolution, save, test - call THIS beside their gate rather
 * than re-deriving eligibility per surface).
 *
 * The two questions §2/§3 separate:
 * - **configure**: only the node OWNER may configure connections through an
 *   enrolled agent node (admin status does not reach it); the built-in `local`
 *   node answers to an admin subject to its maintenance flag. A foreign row
 *   is `not_found` - the usual non-enumerating convention.
 * - **new work** (resolve/test dispatch, run start, terminal open): not in
 *   maintenance, and a LIVE agent socket. Refused agents are HELD, never
 *   live, so a held node takes no SSH work - exactly the existing posture.
 *
 * `local` DISPATCH (run start, terminal launch) is refused for all actors in
 * Wave 1: the in-process twin of the SSH runtime lands with the B+coordinator
 * local-launcher integration (named in the task-D report as an integration
 * request). Configure on `local` stays open so the rows and admin flow exist
 * the moment dispatch lands.
 */

const nodes = new NodesRepository(db);

/** What an act asks of the node behind it. */
export type SshNodeAsk =
  /** Configure-arm ownership facts only (a row write; no dispatch). */
  | "configure"
  /** Ownership AND the machine able to answer a short RPC now (discovery/resolve/test). */
  | "dispatch_rpc"
  /** Ownership AND the machine eligible for NEW work: not in maintenance, live (run start, terminal open). */
  | "new_work";

/**
 * Answer the SSH node-eligibility question for one caller and node, in
 * decision form the same as the policy's (a node-scoped route can fold the
 * result into its refusal without inventing a second error shape).
 * `allow` means the arm's named facts are ALL confirmed - anything else
 * refuses (deny-by-default governs here exactly as in `ssh-policy.ts`).
 */
export async function sshNodeGate(caller: SshCaller, nodeId: string, ask: SshNodeAsk): Promise<SshDecision> {
  const row = await nodes.findById(nodeId);
  if (!row) return { allow: false, code: "not_found" };
  if (row.kind === "local") {
    // §2's admin arm: an admin may configure private connections through the
    // built-in node; a non-admin never reaches it as a config target (an
    // invisible-to-config row answers 404, per the node's own local posture
    // where config acts are cookie-admin). "Subject to its existing
    // launch-enabled rule" is `allow_server_subshells`, read live like the
    // launch path reads it.
    if (!caller.isAdmin) return { allow: false, code: "not_found" };
    if (!(await serverSubshellsEnabled(db))) return { allow: false, code: "node_ineligible" };
  } else if (row.ownerUserId !== caller.userId) {
    // Owner-only configure; an admin is NOT a shortcut on an enrolled node.
    return { allow: false, code: "not_found" };
  }
  if (row.maintenance === 1) return { allow: false, code: "node_ineligible" };
  if (ask !== "configure") {
    if (row.kind === "local") return { allow: false, code: "node_ineligible" };
    if (!getLive(row.id)) return { allow: false, code: "node_ineligible" };
  }
  return { allow: true };
}

/** The node table row behind a connection, for the policy's node-arm reads. */
export async function sshNodeRow(nodeId: string): Promise<NodeTable | undefined> {
  return await nodes.findById(nodeId);
}
