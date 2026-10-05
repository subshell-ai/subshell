import { IS_TEST } from "@/constants.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { SshGrantsRepository } from "@/services/ssh/ssh-grants.repository.js";
import { sshNodeGate } from "@/services/ssh/ssh-node.js";
import { SshPanesRepository } from "@/services/ssh/ssh-panes.repository.js";
import type {
  SshCaller,
  SshControlRequest,
  SshDecision,
  SshGrantedUseRequest,
  SshHumanConfigRequest,
  SshPaneSurfaceRequest,
  SshPolicy,
  SshSharingRequest,
} from "@/services/ssh/ssh-policy.js";
import { SshRunsRepository } from "@/services/ssh/ssh-runs.repository.js";

/**
 * THE SSH authorization implementation - the single seam `ssh-policy.ts`
 * defines, installed for every surface (REST now; the WS/preview/lifecycle
 * hooks ride the same instance when workstream C wires its pane gates).
 *
 * Deny-by-default is the structure, not a default branch: every `allow`
 * below is preceded by the named row reads that must CONFIRM the facts the
 * interface doc lists - the token's CURRENT key, the grant active at THIS
 * revision, the pane lifecycle, the node's live-and-not-maintenance state,
 * the control holder. Missing rows, a deleted connection under a grant, a
 * thrown dependency read: the refuse arm. Nothing caches a decision - each
 * gate re-asks at decision time, which is what §2's "rechecked" and the race
 * row of §6's matrix demand.
 *
 * The one pass-through stays as the interface wrote it: `gatePaneSurface`
 * allows a pane with NO `ssh_panes` row - "the SSH policy does not apply",
 * never "approved" - and that read is the whole extent of non-SSH logic here.
 */
export class DefaultSshPolicy implements SshPolicy {
  readonly #connections = new SshConnectionsRepository(db);
  readonly #grants = new SshGrantsRepository(db);
  readonly #runs = new SshRunsRepository(db);
  readonly #panes = new SshPanesRepository(db);
  readonly #subshells = new SubshellsRepository(db);

  /**
   * Human-config arm: cookie session or nothing (§2: "Human configuration,
   * discovery, grants, and control changes require a cookie session...
   * Machine credentials cannot call them"). Owner match is part of the
   * decision - admins do NOT float above another user's private connection.
   * `save`/`edit`/`delete_connection` carry the active-work refusal
   * (spec §2/§4: the human must stop or finish running work first).
   */
  async gateHumanConfig(req: SshHumanConfigRequest): Promise<SshDecision> {
    if (req.caller.actor !== "cookie") return { allow: false, code: "cookie_required" };

    if (req.connectionId !== undefined) {
      const conn = await this.#connections.findById(req.connectionId);
      if (!conn || conn.userId !== req.caller.userId) return { allow: false, code: "not_found" };

      if (req.action === "edit" || req.action === "delete_connection") {
        if (await this.#runs.hasActiveWork(conn.id)) return { allow: false, code: "active_work" };
      }
      // Human run/terminal acts ride the connecting node like the pane arm
      // does: ownership is necessary, node eligibility is the other half.
      if (req.action === "run_start" || req.action === "terminal_open" || req.action === "run_read") {
        const ask = req.action === "run_read" ? "dispatch_rpc" : "new_work";
        const gate = await sshNodeGate(req.caller, conn.nodeId, ask);
        if (!gate.allow) return gate;
      }
      return { allow: true };
    }

    // `save` names its target node in the request body (no connection row
    // yet); the route folds that through {@link sshNodeGate} with the SAME
    // arm this switch names, so the two entry points share one eligibility
    // implementation. Nothing further is confirmable without a row here.
    return { allow: true };
  }

  /**
   * Granted-pane arm: the full recheck, in order, each refusal named by what
   * its read found (or failed to find): pane identity is the presenting key
   * (`token_stale` when the row's CURRENT `apiKeyId` differs - a restarted
   * pane holds a new key and inherits nothing), lifecycle admits the act,
   * the active grant pins the connection's CURRENT revision
   * (`revision_mismatch` when an edit moved it), and the node is eligible
   * for work that dispatches. Human use never rides this arm - routes send
   * cookie actors through {@link gateHumanConfig}.
   */
  async gateGrantedUse(req: SshGrantedUseRequest): Promise<SshDecision> {
    const { caller, kind } = req;
    // Only a pane key can hold a grant. A cookie caller belongs to the human
    // arm; a system key resolves to a user who owns no panes. Either holds
    // no grant, which is exactly what this code says.
    if (caller.actor !== "subshell-key" || caller.subshellId === null || caller.apiKeyId === null) {
      return { allow: false, code: "not_granted" };
    }

    const pane = await this.#subshells.findById(caller.subshellId);
    if (!pane) return { allow: false, code: "not_found" };
    if (pane.userId !== caller.userId) return { allow: false, code: "not_found" };

    // The row's TWO liveness facts (the §25 input-route posture): a pane
    // parked at status-running/alive-0 self-exited and its key is already
    // reaped; dispatching new work through it would type into nothing.
    if (kind === "run_start" || kind === "terminal_open") {
      if (pane.status !== "running" || pane.alive !== 1) return { allow: false, code: "pane_lifecycle" };
    }

    // The grant binds the CURRENT issued key (spec §2: "its current
    // credential generation... Old tokens receive no grandfathering").
    if (pane.apiKeyId === null || pane.apiKeyId !== caller.apiKeyId) {
      return { allow: false, code: "token_stale" };
    }

    if (req.runId !== undefined) {
      // Run-scoped kinds resolve owner, revision, and initiating credential
      // through the row (the interface says so).
      const run = await this.#runs.findById(req.runId);
      if (!run || run.userId !== caller.userId) return { allow: false, code: "not_found" };
      if (run.apiKeyId !== caller.apiKeyId) {
        return { allow: false, code: run.apiKeyId === null ? "not_found" : "token_stale" };
      }
      // The run is still bound to a live grant: the connection must still
      // exist (its delete cascades the grant, and a grant-less history read
      // is a human act), the ACTIVE grant for THIS pane must pin the revision
      // the run was authorized against.
      // A HUMAN-initiated run has no credential to match against and no grant
      // ever authorized it - to a pane key it is simply not there.
      if (run.connectionId === null || run.initiatedBy !== "agent") return { allow: false, code: "not_found" };
      const conn = await this.#connections.findById(run.connectionId);
      if (!conn) return { allow: false, code: "not_granted" };
      const grant = await this.#grants.findActive(conn.id, caller.subshellId, caller.apiKeyId);
      if (!grant) return this.#revokedOrMissing(conn.id, caller);
      if (grant.connectionRevision !== run.connectionRevision) return { allow: false, code: "revision_mismatch" };
      // A read relays through the node, so the node must answer; a CANCEL does
      // not - offline cancellation stays pending and dispatches on reconnect
      // (spec §2), so refusing it here would make the pending rule unreachable.
      if (kind === "run_read") return await sshNodeGate(caller, conn.nodeId, "dispatch_rpc");
      return { allow: true };
    }

    if (req.connectionId === undefined) return { allow: false, code: "not_found" };
    const conn = await this.#connections.findById(req.connectionId);
    if (!conn || conn.userId !== caller.userId) return { allow: false, code: "not_found" };
    const grant = await this.#grants.findActive(conn.id, caller.subshellId, caller.apiKeyId);
    if (!grant) return this.#revokedOrMissing(conn.id, caller);
    if (grant.connectionRevision !== conn.revision) return { allow: false, code: "revision_mismatch" };
    if (kind === "run_start" || kind === "terminal_open") {
      return await sshNodeGate(caller, conn.nodeId, "new_work");
    }
    return { allow: true };
  }

  /**
   * Generic-pane-surface gate (spec §2's enumerated surfaces; workstream C
   * calls this from each hook site). An unmanaged pane passes - the policy
   * does not apply. A managed pane answers ONLY its owner (cookie) or the
   * credential that OPENED it (a bearer whose CURRENT key equals the row's
   * `api_key_id`); everyone else, admins and same-owner siblings included,
   * gets the 404 convention. On top of identity: the opening grant must
   * still be ACTIVE (revocation fences the pane's streams, §2), and a
   * human-controlled terminal blocks every agent read AND write - recorded
   * output may become visible again only after a human returns control.
   *
   * A pinned revision older than the connection's current one does NOT
   * fence an ALIVE pane (the frozen `ssh_panes` doc: an edit mid-session
   * does not move its argv); revocation does, which is why the grant is
   * re-asked rather than the revision compared.
   */
  async gatePaneSurface(req: SshPaneSurfaceRequest): Promise<SshDecision> {
    const pane = await this.#panes.findBySubshell(req.subshellId);
    if (!pane) return { allow: true }; // not a managed pane: the policy does not apply
    const conn = await this.#connections.findById(pane.connectionId);
    if (!conn) return { allow: false, code: "not_found" };

    const { caller } = req;
    if (caller.actor === "cookie") {
      // Humans: owner reads and acts freely (control never blocks a human;
      // takeover/return are `gateHumanConfig` acts). Admin status is not an
      // entry: a foreign managed pane is invisible (§2 privacy).
      const row = await this.#subshells.findById(req.subshellId);
      if (!row || row.userId !== caller.userId) return { allow: false, code: "not_found" };
      return { allow: true };
    }

    // Bearer actors: only the exact credential that opened this pane, and
    // only while that grant lives. Human-opened panes carry no credential,
    // so no bearer ever reaches them.
    if (caller.actor !== "subshell-key" || pane.apiKeyId === null || caller.apiKeyId !== pane.apiKeyId) {
      return { allow: false, code: "not_found" };
    }
    const grant = pane.grantId === null ? undefined : await this.#grants.findById(pane.grantId);
    if (!grant || grant.revokedAt !== null) {
      return { allow: false, code: grant ? "grant_revoked" : "not_granted" };
    }

    // Control state fences every read AND write stream (spec §3's rule, and
    // the interface doc's "a view-granted reader still reads nothing while
    // a human holds the terminal"). Lifecycle acts are not input streams:
    // restart (re-checked authorization, new session) and terminate/delete
    // ride identity + grant alone. Attach mint/redeem are reads.
    if (req.surface !== "restart" && req.surface !== "terminate" && req.surface !== "delete") {
      if (pane.controlOwner === "human") return { allow: false, code: "human_control" };
    }
    return { allow: true };
  }

  /**
   * Control gate for agent reads/writes on a managed pane: `human_control`
   * while a human holds input, allow otherwise. A pane with no managed row
   * has no control state to consult (allow - the policy does not apply).
   * Human takeover/return are NOT this gate's callers (they are
   * {@link gateHumanConfig} acts); a cookie actor passing through allows,
   * which is the interface's "Agent callers only" sentence honored by
   * absence of a human refusal, not by a human bypass.
   */
  async gateControl(req: SshControlRequest): Promise<SshDecision> {
    const pane = await this.#panes.findBySubshell(req.subshellId);
    if (!pane) return { allow: true };
    if (req.caller.actor === "cookie") return { allow: true };
    if (pane.controlOwner === "human") return { allow: false, code: "human_control" };
    return { allow: true };
  }

  /**
   * Sharing gate: v1 refuses sharing of managed SSH panes, to anyone,
   * always - the owner and `view` included (spec §2 verbatim, and the
   * interface doc: including both). Unmanaged panes pass to the ordinary
   * sharing rules; the policy does not apply there.
   */
  async gateSharing(req: SshSharingRequest): Promise<SshDecision> {
    const pane = await this.#panes.findBySubshell(req.subshellId);
    if (!pane) return { allow: true };
    return { allow: false, code: "sharing_unsupported" };
  }

  /** `grant_revoked` when the tuple's row exists revoked; `not_granted` when never issued. */
  async #revokedOrMissing(connectionId: string, caller: SshCaller): Promise<SshDecision> {
    if (caller.subshellId === null || caller.apiKeyId === null) return { allow: false, code: "not_granted" };
    const revoked = await this.#grants.findRevoked(connectionId, caller.subshellId, caller.apiKeyId);
    return { allow: false, code: revoked ? "grant_revoked" : "not_granted" };
  }
}

/** Module-level singleton (the code-style rule): the policy is stateless over the shared `db`. */
let instance: DefaultSshPolicy | undefined;

/** The installed SSH policy. Every surface reaches the decision through this. */
export function getSshPolicy(): SshPolicy {
  instance ??= new DefaultSshPolicy();
  return instance;
}

/**
 * Drop the memoized policy so a test starts from a clean singleton.
 * @internal
 */
export function resetSshPolicyForTests(): void {
  if (!IS_TEST) throw new Error("resetSshPolicyForTests is a test-only seam");
  instance = undefined;
}
