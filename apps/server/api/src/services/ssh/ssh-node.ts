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
 *   maintenance, and reachable now - a LIVE agent socket for an enrolled node.
 *   Refused agents are HELD, never live, so a held node takes no SSH work -
 *   exactly the existing posture. The built-in `local` node is always reachable
 *   (it runs in-process), so it clears this arm without a socket.
 *
 * `local` is always LIVE in-process: the built-in node runs the SAME
 * pane-runtime the agent daemon wraps (`ssh-local.ts` dispatches every `ssh_*`
 * verb directly, review I3), so there is no link to be offline and no socket
 * to check. A `local` target that is not in maintenance is therefore eligible
 * for `dispatch_rpc` and `new_work` exactly as an online agent is; the
 * maintenance flag and the launch-enabled rule still gate it (the two rows
 * below apply to every kind).
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
    // §2's admin arm, expressed by ACTOR: a COOKIE actor touching the built-in
    // node must be an admin (only admins may configure/discover/test through
    // it; a non-admin cookie is invisible-to-config and answers 404). A BEARER
    // here has ALREADY been gated by `gateGrantedUse` (an explicit per-pane
    // grant on a connection that can only exist under the admin who owns it),
    // so its remaining local facts are the launch-enabled rule and the
    // maintenance flag - not admin status. This adds no door: a bearer cannot
    // mint a grant, and `gateHumanConfig` refuses every machine credential
    // before it reaches this arm for a config ask. "Subject to its existing
    // launch-enabled rule" is `allow_server_subshells`, read live like the
    // launch path reads it.
    if (caller.actor === "cookie" && !caller.isAdmin) return { allow: false, code: "not_found" };
    if (!(await serverSubshellsEnabled(db))) return { allow: false, code: "node_ineligible" };
  } else if (row.ownerUserId !== caller.userId) {
    // Owner-only configure; an admin is NOT a shortcut on an enrolled node.
    return { allow: false, code: "not_found" };
  }
  if (row.maintenance === 1) return { allow: false, code: "node_ineligible" };
  if (ask !== "configure") {
    // Only an AGENT target can be offline: a refused agent is HELD (never
    // live), so a held node takes no SSH work - the existing posture. `local`
    // has no link to be down (it runs in-process, `ssh-local.ts`), so once the
    // maintenance flag above clears it, it is eligible exactly as an online
    // agent is (review I3: this is where Wave 1 refused `local` dispatch for
    // every ask; the eligibility it was waiting on has now landed).
    if (row.kind !== "local" && !getLive(row.id)) return { allow: false, code: "node_ineligible" };
  }
  return { allow: true };
}

/** The node table row behind a connection, for the policy's node-arm reads. */
export async function sshNodeRow(nodeId: string): Promise<NodeTable | undefined> {
  return await nodes.findById(nodeId);
}
