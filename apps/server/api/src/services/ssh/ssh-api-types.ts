import type { SshConnectionSnapshotWire, SshErrorCode, SshRunLifecycle } from "@internal/subshell-protocol";
import type { SshActorSide } from "@/db/types/ssh-actor-side.js";
import type { SshExecObservationState } from "@/db/types/ssh-exec-observation-state.js";

/**
 * The frozen SSH REST/MCP surface SHAPES (SSH-SUPPORT.md §4: "Define schemas
 * once server-side"; the REST table's rows). Workstreams D (routes), E (MCP
 * tools) and F (SPA) build against these field names - they are law after
 * Gate A, exactly like the wire types in `@internal/subshell-protocol`.
 *
 * Conventions these follow, stated so no one re-litigates them per file:
 * camelCase bodies everywhere REST (the house rule; MCP args stay snake_case,
 * see the commented section at the bottom); every non-2xx is the global
 * `ApiErrorResponse` (`{errId, code, message, statusCode, ...}` from
 * `schema/error.type.ts`), so no shape below carries an error arm; foreign
 * resources 404, insufficient-but-visible 403; refusals carry the named
 * `SshErrorCode`/`SshPolicyCode` value in `code`/metadata so MCP prose and
 * SPA copy map by equality, never by parsing a sentence.
 *
 * NO t schemas here: co-location puts each route's `t.*` schemas in its own
 * route file (workstream D); this module is the shared TS shape those
 * schemas serialize to.
 */

/* ------------------------------------------------------------------ */
/* /api/ssh/discovery  (human cookie only)                              */
/* ------------------------------------------------------------------ */

/**
 * `GET /api/ssh/discovery?nodeId=…` response: alias NAMES on the selected
 * eligible node - never config file contents (spec §2). `includeCycle` is a
 * reviewable fact (the human should know their config has a cycle), and
 * `truncated` says the parse stopped at the discovery cap.
 */
export interface SshDiscoveryView {
  /** Alias names, sorted, wildcard-only entries excluded */
  aliases: string[];
  /** An include cycle was detected during the bounded parse */
  includeCycle: boolean;
  /** The alias cap was hit; more exist */
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/* /api/ssh/connections  (writes human cookie; reads owner + granted)  */
/* ------------------------------------------------------------------ */

/**
 * `POST /api/ssh/connections/resolve` body: resolve one alias on a node into
 * the approved snapshot (a human action, and it discloses that trusted local
 * config can run helpers before the human saves).
 */
export interface SshResolveRequest {
  /** The connecting node to parse on */
  nodeId: string;
  /** The alias to resolve */
  alias: string;
}

/**
 * `POST /api/ssh/connections/resolve` response. A named refusal is a 200:
 * "this config needs a ProxyCommand" is the answer to the question, not a
 * transport failure (same grammar as the wire outcome).
 */
export type SshResolveView =
  | {
      /** The alias normalized cleanly. */
      accepted: true;
      /** The snapshot the human reviews; saving it (below) is a separate act. */
      snapshot: SshConnectionSnapshotWire;
      /** The connecting OS account name when the node could report it (the §3 review sentence). */
      connectingAccount?: string;
    }
  | {
      /** Resolution refused: the config needs more than the approved normalization can run, or the destination is unusable. */
      accepted: false;
      /** Named limitation ({@link SshErrorCode} subset). */
      code: SshErrorCode;
      /** Config keywords that blocked, when the code names several. */
      settings: string[];
    };

/** `POST /api/ssh/connections/test` body: probe a (not yet saved) snapshot with the node's FIXED benign probe. */
export interface SshTestConnectionRequest {
  /** The connecting node to run the probe on */
  nodeId: string;
  /** The approved snapshot to probe */
  snapshot: SshConnectionSnapshotWire;
}

/**
 * `POST /api/ssh/connections/test` response. `passed:false` is 200 with a
 * named code; a failure with no code is contractually impossible (the wire
 * validator refuses it).
 */
export type SshTestConnectionView = { passed: true } | { passed: false; code: SshErrorCode };

/** `POST /api/ssh/connections` body: save a resolved snapshot as a connection (revision 1). */
export interface SshCreateConnectionRequest {
  /** Connecting node id; the owner's node (or `local` for admins, per §2) */
  nodeId: string;
  /** Display label ("Staging"); normalized and capped server-side */
  displayName: string;
  /** The human-approved snapshot; re-validated by the node's grammar server-side before it is stored */
  snapshot: SshConnectionSnapshotWire;
  /** Optional absolute remote start directory */
  remoteDir?: string | null;
}

/** `PATCH /api/ssh/connections/:id` body: an edit. A `snapshot` change creates a NEW revision and invalidates grants; omitted fields stay as stored. */
export interface SshUpdateConnectionRequest {
  /** New display label; omitted = unchanged */
  displayName?: string;
  /** New remote-directory default; null clears it; omitted = unchanged */
  remoteDir?: string | null;
  /** Replacement snapshot at a new revision; omitted = no reconnection change */
  snapshot?: SshConnectionSnapshotWire;
}

/** A stored connection, as every connections read answers it. */
export interface SshConnectionView {
  /** Connection id (uuid) */
  id: string;
  /** Connecting node id (SPA renders the route: "…via <node name>") */
  nodeId: string;
  /** Human display label */
  displayName: string;
  /** The CURRENT approved snapshot */
  snapshot: SshConnectionSnapshotWire;
  /** Remote-directory default; null = destination login default */
  remoteDir: string | null;
  /** Current revision (grants/runs pin their own) */
  revision: number;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last revision-bearing update */
  updatedAt: string;
}

/** `GET /api/ssh/connections` response (owner's list; a granted pane's filtered list uses the same shape, own-visible rows only). */
export interface SshConnectionListView {
  /** Connections visible to the caller, newest first */
  connections: SshConnectionView[];
}

/** `DELETE /api/ssh/connections/:id` response: the delete happened (active work was refused first, spec §4). */
export interface SshDeleteConnectionView {
  /** Echo: the connection is gone. */
  deleted: true;
}

/* ------------------------------------------------------------------ */
/* /api/ssh/connections/:id/grants  (owning human cookie only)          */
/* ------------------------------------------------------------------ */

/** `POST …/grants` body: grant the connection's CURRENT revision to one live pane. */
export interface SshGrantRequest {
  /** The pane to grant (must be running; the key identity is resolved server-side from the pane's CURRENT issued key) */
  subshellId: string;
}

/** A grant row as reads answer it. */
export interface SshGrantView {
  /** Grant id (uuid) */
  id: string;
  /** Granted connection */
  connectionId: string;
  /** Pinned revision (the edit-invalidates-grants fact) */
  connectionRevision: number;
  /** Granted pane */
  subshellId: string;
  /** The pane's key identity the grant is bound to */
  apiKeyId: string;
  /** The human who granted it (email display resolved by the SPA from /api/users) */
  grantedByUserId: string;
  /** ISO 8601 grant time */
  grantedAt: string;
  /** ISO 8601 revocation time; null = active */
  revokedAt: string | null;
  /** Convenience mirror of `revokedAt === null` (the list renders it constantly; recomputing invites drift) */
  active: boolean;
}

/** `GET …/grants` response. */
export interface SshGrantListView {
  /** Grant rows for this connection - active and revoked history - newest first */
  grants: SshGrantView[];
}

/** `DELETE …/grants/:subshellId` response: the active grant (if any) is revoked; queued input is fenced node-side. */
export interface SshRevokeGrantView {
  /** Echo: a live grant was revoked (false when none was active). */
  revoked: boolean;
}

/* ------------------------------------------------------------------ */
/* /api/ssh/runs  (owning human or explicitly granted pane)             */
/* ------------------------------------------------------------------ */

/** `POST /api/ssh/runs` body: start one structured command on the caller's granted connection. */
export interface SshRunStartRequest {
  /** Connection to run on; raw hosts/options/aliases are NOT accepted here (spec §2: only connection IDs) */
  connectionId: string;
  /** The remote command (the one intentional shell code; capped at the wire limit server-side) */
  command: string;
  /** Per-run absolute remote directory overriding the connection default; null uses the default; omitted = default */
  remoteDir?: string | null;
  /** Deadline in ms; server-clamped to [1, SSH_RUN_DEADLINE_MAX_MS], default SSH_RUN_DEADLINE_DEFAULT_MS */
  deadlineMs?: number;
}

/** A run as every runs read answers it: the plane's mirror of the node's facts. */
export interface SshRunView {
  /** Server-allocated opaque run id */
  id: string;
  /** Source connection; null after the connection was deleted (the snapshot copy below is the permanent destination fact) */
  connectionId: string | null;
  /** Connection revision pinned at dispatch */
  connectionRevision: number;
  /** Connecting node id; null after the node was deleted */
  nodeId: string | null;
  /** Immutable destination snapshot used for this run (rendered for review; never re-routed from) */
  snapshot: SshConnectionSnapshotWire;
  /** Who initiated */
  initiatedBy: SshActorSide;
  /** The lifecycle state; `unknown` is honest, never dressed as failed or succeeded */
  status: SshRunLifecycle;
  /** True = cancellation requested through the plane */
  cancelRequested: boolean;
  /** True = local supervised ssh stopped; remote descendants are never confirmed */
  cancelLocalConfirmed: boolean;
  /** True = the execution deadline fired */
  deadlineHit: boolean;
  /** The deadline the run was dispatched with (ms) */
  deadlineMs: number;
  /** Observed remote exit status; null unless observed */
  remoteStatus: number | null;
  /** True when `remoteStatus` is a confirmed remote result (255 alone never earns true) */
  remoteStatusConfirmed: boolean;
  /** Local ssh exit code; null unless it exited */
  localExitCode: number | null;
  /** Signal name that killed the local ssh; null unless signalled */
  localExitSignal: string | null;
  /** The command as dispatched (owner and granted pane only; never rides logs/audit/pushes) */
  command: string;
  /** Remote directory the run started in; null = destination login default */
  remoteDir: string | null;
  /** ISO 8601 dispatch-accepted time */
  createdAt: string;
  /** ISO 8601 first `running` observation; null until then */
  startedAt: string | null;
  /** ISO 8601 terminal observation; null while accepted/running */
  finishedAt: string | null;
}

/** `GET /api/ssh/runs` response: the caller's recent runs, newest first (server-bounded tail). */
export interface SshRunListView {
  /** Runs visible to the caller (human owner: their own; granted pane: its own initiated runs) */
  runs: SshRunView[];
}

/**
 * `GET /api/ssh/runs/:id/output` query (all optional; absent means 0,0 /
 * default window / no wait): bounded incremental read of the node-retained
 * output. A closing browser or a timed-out read NEVER cancels the run.
 */
export interface SshRunOutputQuery {
  /** stdout byte offset to read from */
  stdoutFromByte?: number;
  /** stderr byte offset to read from */
  stderrFromByte?: number;
  /** Combined cap across both streams (default and max `SSH_OUTPUT_WINDOW_MAX_BYTES`, clamp not refuse) */
  maxBytes?: number;
  /** Long-poll budget ms (default 0, max `SSH_READ_LONG_POLL_MAX_MS`); waiting is not an error and not a cancel */
  waitMs?: number;
}

/** `GET /api/ssh/runs/:id/output` response: the window plus the full run facts. */
export interface SshRunOutputView {
  /** The run's facts (same shape as every runs read, always current at answer time) */
  run: SshRunView;
  /** Decoded stdout bytes for this window (UTF-8 lossy, the terminal-render rule; output is DATA, never HTML) */
  stdout: string;
  /** Decoded stderr bytes */
  stderr: string;
  /** stdout offset to pass next */
  stdoutNext: number;
  /** stderr offset to pass next */
  stderrNext: number;
  /** stdout total retained; a `next` past it reads `cursorExpired` */
  stdoutTotal: number;
  /** stderr total retained */
  stderrTotal: number;
  /** True when retention drain dropped bytes; the transcript here is not the whole transcript */
  truncated: boolean;
  /**
   * True when a requested offset points past retained output (the run's
   * output was swept or rotated): the caller must restart from 0, never
   * silently reuse the dead cursor (spec §3's explicit cursor-expired rule).
   */
  cursorExpired: boolean;
}

/** `POST /api/ssh/runs/:id/cancel` response: the cancellation is requested/relayed; the run view carries what the node confirmed. */
export type SshRunCancelView = SshRunView;

/* ------------------------------------------------------------------ */
/* /api/ssh/terminals  (create managed SSH pane)                        */
/* ------------------------------------------------------------------ */

/** `POST /api/ssh/terminals` body: open a managed SSH terminal pane. */
export interface SshTerminalCreateRequest {
  /** Connection to connect; only IDs, never destination strings (spec §2) */
  connectionId: string;
  /** Initial grid, when the opener knows one */
  cols?: number;
  /** Initial rows */
  rows?: number;
}

/**
 * The managed pane as create answers it. The pane is a private surface from
 * here on: every generic pane route consults the SSH policy for it, and
 * `controlOwner` decides what an agent may see at all (human-opened panes
 * start human-controlled).
 */
export interface SshTerminalView {
  /** The new pane's subshell id (rendering, geometry, and attach ride the ordinary pane routes behind the policy) */
  subshellId: string;
  /** Connection the terminal connects */
  connectionId: string;
  /** Revision pinned at open */
  connectionRevision: number;
  /** Who opened it (decides the initial control owner; spec §3) */
  initiatedBy: SshActorSide;
  /** Current input control */
  controlOwner: SshActorSide;
  /** Current input generation (node-enforced fence counter) */
  controlGeneration: number;
  /** Current log generation (rotation cursor namespace) */
  logGeneration: number;
  /** ISO 8601 open time */
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* control/status operations on EXISTING pane routes                    */
/* ------------------------------------------------------------------ */

/**
 * `POST /api/subshells/:id/ssh-control` body: the takeover/return act. Only
 * humans act here (both directions require a cookie session); the generation
 * is the server's to raise, never the caller's to choose. (The policy-side
 * same-intent input lives in `ssh-policy.ts` as `SshControlRequest`; these
 * are different types serving different seams.)
 */
export interface SshPaneControlRequest {
  /** The mode to move the pane to. */
  mode: SshActorSide;
}

/** `POST /api/subshells/:id/ssh-control` response: the new control state (generation already raised; stale queued input is fenced node-side). */
export interface SshControlView {
  /** The pane */
  subshellId: string;
  /** Who holds input now */
  controlOwner: SshActorSide;
  /** The generation after this transition */
  controlGeneration: number;
}

/**
 * `GET /api/subshells/:id/execs/:execId` response: the read-only
 * `get_terminal_execution` status shape (spec §3: execution IDs, persistent
 * outstanding state, read-only status operation; a status read that changes
 * NOTHING).
 */
export interface SshTerminalExecView {
  /** Execution id (uuid; the recovery handle) */
  id: string;
  /** The pane */
  subshellId: string;
  /** Observation state; `outstanding` means "still being watched", not "hung" */
  state: SshExecObservationState;
  /** Marker-reported exit status; null unless `completed` */
  exitCode: number | null;
  /** Bounded captured output tail (null until resolved); newest kept past the cap */
  output: string | null;
  /** True when the tail dropped older lines */
  outputTruncated: boolean;
  /** Log offset past the sentinel (or where observation stopped); the `from_byte` to continue from */
  nextByte: number | null;
  /** The input generation at typing time (the takeover fence's receipt) */
  inputGeneration: number;
  /** ISO 8601 typing time */
  createdAt: string;
  /** ISO 8601 resolution time; null while outstanding */
  resolvedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* MCP tool shapes (reference text; mcp-core is Apache and REDECLARES   */
/* these locally - this block is the single source of the names)        */
/* ------------------------------------------------------------------ */

// MCP conventions (mirror of `packages/mcp-core/src/terminal-tools.ts`):
// tool ARGS are snake_case, the plane's REST bodies stay camelCase, and the
// tools add NO bounds the server also enforces (every protocol decision
// lives server-side). Thin passthroughs over the shapes above; refusals ride
// `describeToolError`'s code-to-prose map, so a named `SshErrorCode` reads
// as an honest sentence, never a stack trace.
//
// list_ssh_connections
//   input:  {} (the caller's grants decide the list; there is no "all")
//   output: the `SshConnectionListView` shape, granted rows only (spec §2:
//     "MCP lists only the connections granted to the caller"), with
//     `displayName` plus the destination rendered from `snapshot` for display
//     ("deploy@app-02.example.net:22" - display, never routable input).
//
// execute_ssh_command
//   input:  { "connection_id": "uuid", "command": "…", "remote_dir"?: "abs path", "deadline_ms"?: int }
//   output: the `SshRunView` shape verbatim (already camelCase, the REST view
//     as-is); returns promptly with "status":"accepted".
//   refusals: not_granted / token_stale / quota_runs / node_ineligible /
//     storage_full, named, never a guessed retry.
//
// read_ssh_command
//   input:  { "run_id": "opaque", "stdout_from_byte"?: int, "stderr_from_byte"?: int, "max_bytes"?: int, "wait_ms"?: int }
//   output: the `SshRunOutputView` shape verbatim (run facts + window + cursorExpired).
//   honesty: a timed-out wait answers an empty window (status still running);
//     closing the read NEVER cancels.
//
// cancel_ssh_command
//   input:  { "run_id": "opaque" }
//   output: the `SshRunView` (`cancelRequested`/`cancelLocalConfirmed` tell
//     the truth; remote descendants stay unconfirmed by contract).
//
// open_ssh_terminal
//   input:  { "connection_id": "uuid", "cols"?: int, "rows"?: int }
//   output: the `SshTerminalView` (agent-opened panes start in agent control;
//     quota_terminals names the refusal).
//
// get_terminal_execution
//   input:  { "subshell_id": "…", "execution_id": "uuid" }
//   output: the `SshTerminalExecView` (read-only recovery of an
//     exec_in_terminal result; `unknown` is reported as `unknown`, never renamed).
//
// No SSH-specific input/log tools are added: the existing pane tools reach
// SSH terminals through the same generic-surface policy gate (spec §4).
