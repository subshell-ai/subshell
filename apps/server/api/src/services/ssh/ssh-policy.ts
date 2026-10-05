import type { SshErrorCode } from "@internal/subshell-protocol";
import type { GuardActor } from "@/api/auth-guard.js";

/**
 * THE SSH authorization contract (SSH-SUPPORT.md §2: "One SSH authorization
 * policy used by all REST, WebSocket, preview, log, lifecycle, and sharing
 * surfaces").
 *
 * This file is an INTERFACE ONLY by Gate A decree: the implementation is
 * workstream D's, and until it is installed EVERY decision here answers the
 * refuse arm. Two rules bind whoever implements and whoever calls:
 *
 * 1. DENY IS THE DEFAULT. The only arms that return `allow` are the ones
 *    whose facts they name are all CONFIRMED present and current. Missing
 *    rows, unreadable state, a timeout in a dependency: refuse. Implementers
 *    may NOT weaken this to availability. The spec is explicit - "Do not
 *    merge a placeholder authorization helper that returns success. Refusals
 *    are the default until the full policy is installed."
 * 2. CALLERS MAY NOT RE-IMPLEMENT A CHECK THIS INTERFACE NAMES. If the gate
 *    covers it (token identity, pane lifecycle, revision match, node
 *    eligibility, control state, grant state), the surface calls the gate -
 *    a local copy is the drift §2 lists as the top bypass risk.
 *
 * The one arm that reads like a pass-through is deliberate: a pane with no
 * `ssh_panes` row is not a managed SSH terminal, and `gatePaneSurface` allows
 * for it - "the SSH policy does not apply", never "the SSH policy approved".
 * That single check is the whole extent of non-SSH logic in this seam.
 */

/** The named refusal set for policy decisions. */
export const SSH_POLICY_CODES = [
  /** A human configuration act (discovery, resolution, save, grants, control return) requires a cookie session; every machine credential and every non-cookie actor is refused. */
  "cookie_required",
  /** The resource is foreign or gone - the 404 convention, expressed as a decision so every surface maps invisibility identically. */
  "not_found",
  /** The pane holds no active grant for this connection revision. */
  "not_granted",
  /** The grant row exists but is revoked: new dispatch stops here, and the caller's queued input is fenced at the node. */
  "grant_revoked",
  /** The presenting token is not the pane's CURRENT issued key (a restart rotated it): grants bind the key identity, so old tokens receive no grandfathering. */
  "token_stale",
  /** The connection's current revision differs from the one the grant/run/pane pinned (an edit invalidates prior-revision grants). */
  "revision_mismatch",
  /** The pane is not in a lifecycle state that admits the act (not running, already terminated, or parked at alive-0). */
  "pane_lifecycle",
  /** The connecting node is offline, in maintenance, deleted, or otherwise not eligible to take this work. */
  "node_ineligible",
  /** A human holds input control: agent reads and writes on every API/stream are blocked until the human returns control. */
  "human_control",
  /** v1 refuses sharing SSH panes and connections, to anyone, always (spec §2: "Sharing SSH panes is refused in v1"). */
  "sharing_unsupported",
  /** The connection has active runs or managed panes: edit and delete are refused until the human stops or finishes them (spec §2/§4). */
  "active_work",
] as const;

/** One named policy refusal. */
export type SshPolicyCode = (typeof SSH_POLICY_CODES)[number];

/**
 * The decision every gate returns. `allow` carries nothing - if a surface
 * needs facts back (the pinned revision, the control generation), it reads
 * them from its own already-loaded row AFTER the decision, never from here,
 * so a decision cannot smuggle state the caller forgot to re-check.
 */
export type SshDecision =
  | { allow: true }
  | {
      allow: false;
      /** The named refusal; maps to an HTTP status + code at the surface (404 for `not_found`, 403 for the rest, per the foreign/invisible convention). */
      code: SshPolicyCode;
      /**
       * Optional wire-level elaboration (e.g. a connection-save refused for a
       * config setting carries `unsupported_setting`). Display metadata only;
       * the POLICY decision is `code`. Never carries command text, output,
       * config contents, or secrets.
       */
      detail?: SshErrorCode;
    };

/**
 * A caller's resolved identity as the guard saw it, passed in plain data so
 * the policy never re-reads the request. `userId` follows the guard's
 * resolution (a subshell key resolves to its OWNER); that is exactly why
 * `subshellId`/`apiKeyId` ride beside it: owner identity is necessary and
 * NOT sufficient for pane use, which checks the key row.
 */
export interface SshCaller {
  /** Credential kind as auth-guard derived it (node keys never reach REST). */
  actor: GuardActor;
  /** The resolved user id behind the credential. */
  userId: string;
  /** `sess:<id>` principal for a subshell key; null for cookie and system-key actors. */
  principal: string | null;
  /** The presenting api-key's id for bearer actors; null for cookie. */
  apiKeyId: string | null;
  /** The subshell a subshell-key is bound to; null otherwise. */
  subshellId: string | null;
  /** Admin flag from the guard (never an override here - §2: admin status does not bypass the SSH rules). */
  isAdmin: boolean;
}

/**
 * The human acts that require a cookie session, explicitly (SSH-SUPPORT.md
 * §4's caller column: config acts AND the run/terminal acts a human performs
 * for their own connections - "Owning human or explicitly granted pane").
 * A human at a run/terminal act passes through THIS seam, not `gateGrantedUse`:
 * the policy is one seam for every surface, and the human arm simply checks
 * ownership/eligibility where the pane arm checks the grant tuple.
 */
export type SshHumanConfigAction =
  | "discover"
  | "resolve"
  | "test"
  | "save"
  | "edit"
  | "delete_connection"
  | "grant"
  | "revoke"
  | "take_control"
  | "return_control"
  | "run_start"
  | "run_read"
  | "run_cancel"
  | "terminal_open"
  | "terminal_read";

/** Input to {@link SshPolicy.gateHumanConfig}. */
export interface SshHumanConfigRequest {
  caller: SshCaller;
  /** The act being attempted. */
  action: SshHumanConfigAction;
  /** Connection being edited/deleted, when the action names one (for the owner + active-work checks). */
  connectionId?: string;
}

/** The pane uses that ride a grant rather than a cookie session. */
export type SshGrantedUseKind =
  | "connection_view"
  | "run_start"
  | "run_read"
  | "run_cancel"
  | "terminal_open"
  | "terminal_read";

/** Input to {@link SshPolicy.gateGrantedUse}. */
export interface SshGrantedUseRequest {
  caller: SshCaller;
  /** The operation the pane token is attempting. */
  kind: SshGrantedUseKind;
  /** Connection targeted (start/open/view name one; read/cancel resolve through the run). */
  connectionId?: string;
  /** Run targeted, for the run-scoped kinds (the row supplies owner, revision, and initiating credential). */
  runId?: string;
}

/**
 * Every generic pane surface the SSH policy must cover (spec §2: "list
 * previews, detail reads, logs, captures, live updates, attach-token minting
 * and redemption, input, exec, prompt injection, restart, termination,
 * deletion, and sharing"). One value per hook site; the surface list is
 * frozen so "did we gate it?" is a census, not a memory test.
 */
export const SSH_PANE_SURFACES = [
  "list_preview",
  "detail",
  "log",
  "capture",
  "live",
  "attach_mint",
  "attach_redeem",
  "input",
  "exec",
  "prompt",
  "restart",
  "terminate",
  "delete",
] as const;

/** One gated generic-pane surface. */
export type SshPaneSurface = (typeof SSH_PANE_SURFACES)[number];

/** Input to {@link SshPolicy.gatePaneSurface}. */
export interface SshPaneSurfaceRequest {
  caller: SshCaller;
  /** The pane targeted. */
  subshellId: string;
  /** Which surface is asking. */
  surface: SshPaneSurface;
}

/** The input-control intents an agent may attempt on a managed pane. */
export type SshControlIntent = "agent_read" | "agent_write";

/** Input to {@link SshPolicy.gateControl}. */
export interface SshControlRequest {
  caller: SshCaller;
  /** The managed pane. */
  subshellId: string;
  /** Read (log/live/capture/detail) or write (input/exec/prompt) - both blocked under human control, and this names which for the refusal. */
  intent: SshControlIntent;
}

/** Input to {@link SshPolicy.gateSharing}. */
export interface SshSharingRequest {
  caller: SshCaller;
  /** The pane whose share list is being written. */
  subshellId: string;
}

/**
 * The single SSH policy seam. Every surface - REST, WS, preview, log,
 * lifecycle, sharing, MCP behind its REST calls - routes its decision here.
 *
 * Implementations MUST re-ask live facts at decision time (the token's
 * CURRENT key, the grant's active state, the revision, the node's
 * eligibility, the pane's control state): a decision cached across a
 * revocation or a takeover is the race §6's matrix tests for. Where the spec
 * speaks "rechecked", THIS is the recheck.
 */
export interface SshPolicy {
  /**
   * Human-config gate: `cookie_required` for every non-cookie actor, §2
   * verbatim ("Human configuration, discovery, grants, and control changes
   * require a cookie session... Machine credentials cannot call them").
   * Cookie admins do NOT float above it for other users' rows: owner match
   * is part of this decision, and `save`/`edit`/`delete_connection` also
   * carry the active-work refusal.
   */
  gateHumanConfig(req: SshHumanConfigRequest): Promise<SshDecision>;

  /**
   * Granted-pane read/use gate: the full recheck - token identity (the
   * pane's CURRENT issued key), pane lifecycle, grant active for THIS
   * connection revision, and node eligibility (spec §2: "Every operation
   * rechecks the token, pane lifecycle, owner, grant, connection revision,
   * and node eligibility"). Human use is gated too, through this same
   * interface's other arm: {@link gateHumanConfig} with its `run_start` /
   * `run_read` / `run_cancel` / `terminal_open` / `terminal_read` actions.
   * This method is the granted-pane arm, not an exit from the policy.
   */
  gateGrantedUse(req: SshGrantedUseRequest): Promise<SshDecision>;

  /**
   * Generic-pane-surface gate: allows unmanaged panes (not an SSH pane -
   * the policy does not apply), and for managed panes composes
   * {@link gateGrantedUse} facts with {@link gateControl} - a `view`-granted
   * reader still reads nothing while a human holds the terminal.
   * `attach_redeem` is gated HERE as well as at mint: machine-minted attach
   * tokens keep their caller identity and are rechecked against SSH grants
   * and control state when redeemed (spec §2).
   */
  gatePaneSurface(req: SshPaneSurfaceRequest): Promise<SshDecision>;

  /**
   * Control gate: agent reads and writes on every API/stream are refused
   * while `control_owner` is human (spec §3: recorded output may become
   * visible again only after a human returns control). Agent callers only;
   * human takeover/return are {@link gateHumanConfig} acts.
   */
  gateControl(req: SshControlRequest): Promise<SshDecision>;

  /**
   * Sharing gate: `sharing_unsupported` for every managed pane, v1, always
   * - including the owner and including `view`. Unmanaged panes pass to the
   * ordinary sharing rules (the SSH policy does not apply).
   */
  gateSharing(req: SshSharingRequest): Promise<SshDecision>;
}
