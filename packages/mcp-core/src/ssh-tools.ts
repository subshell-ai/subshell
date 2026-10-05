import { isSshErrorCode, type SshConnectionSnapshotWire, type SshRunLifecycle } from "@internal/subshell-protocol";
import { z } from "zod";
import { ApiError } from "./api-client.js";
import type { ToolDeps } from "./tools.js";
import { describeToolError } from "./tools.js";

/**
 * The SSH-family MCP tools (SSH-SUPPORT.md §4): six thin passthroughs over
 * the frozen `/api/ssh` surface, one per capability the spec names. The
 * shapes below MIRROR `apps/server/api/src/services/ssh/ssh-api-types.ts`
 * field-for-field - that file is law, this one is its Apache-licensed read
 * (mcp-core may not import AGPL server code, so the views are redeclared
 * here with the frozen names; the snapshot and lifecycle TYPES come from
 * `@internal/subshell-protocol`, which is the shared contract itself).
 *
 * What lives HERE is nothing but honesty: the args are snake_case and the
 * bodies camelCase (the house split), bounds are the server's alone (the
 * terminal-tools precedent: a schema bound would refuse where REST clamps),
 * no tool ever retries a lost or refused call (a resend is a NEW decision,
 * never a replay), and refusals map by EQUALITY on the named code riding
 * the error body's `metadata.sshCode` (not_granted, token_stale, quota_runs,
 * …), never by parsing a sentence. Authorization itself is the server's:
 * the coarse `ssh` scope on this pane's token plus a human-issued
 * per-connection grant, rechecked on every operation; the MCP layer only
 * tells the truth about the 403/404 that come back.
 */

/* ------------------------------------------------------------------ */
/* Local mirrors of the server-side enums (frozen names)                */
/* ------------------------------------------------------------------ */

/** The two sides of the human/agent boundary, mirroring the frozen `SshActorSide`. */
export const SSH_ACTOR_SIDES = ["human", "agent"] as const;
export type SshActorSide = (typeof SSH_ACTOR_SIDES)[number];

/**
 * Terminal-exec observation states, mirroring the frozen
 * `SshExecObservationState`. The exec's truth is the MARKER, so this is a
 * fact about OBSERVATION: `outstanding` (typed, still watched; a caller's
 * wait timing out leaves it here), `completed` (the marker landed),
 * `unknown` (observation lost: restart, death, budget) never renamed.
 */
export const SSH_EXEC_OBSERVATION_STATES = ["outstanding", "completed", "unknown"] as const;
export type SshExecObservationState = (typeof SSH_EXEC_OBSERVATION_STATES)[number];

/**
 * The policy refusal names, mirroring the frozen `SshPolicyCode` set from
 * the server's `ssh-policy.ts` (redeclared locally: mcp-core cannot import
 * it). These ride the error body's `metadata.sshCode`; `describeSshToolError`
 * recognizes them by equality so the SSH-aware sentences below answer a
 * refusal the generic map would dress in pane-vocabulary.
 */
export const SSH_POLICY_REFUSAL_CODES = [
  "cookie_required",
  "not_found",
  "not_granted",
  "grant_revoked",
  "token_stale",
  "revision_mismatch",
  "pane_lifecycle",
  "node_ineligible",
  "human_control",
  "sharing_unsupported",
  "active_work",
] as const;

/** Whether `value` is one of the mirrored policy names (the protocol's own guard covers `SshErrorCode`). */
export function isSshPolicyCode(value: unknown): value is (typeof SSH_POLICY_REFUSAL_CODES)[number] {
  return typeof value === "string" && (SSH_POLICY_REFUSAL_CODES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Local mirrors of the frozen REST views (pass-through reads)          */
/* ------------------------------------------------------------------ */

/** A stored connection, mirroring the frozen `SshConnectionView` (the CURRENT revision's fields). */
export interface SshConnectionView {
  /** Connection id (uuid): the only handle any SSH tool accepts for a destination */
  id: string;
  /** Connecting node id (the route's "via" hop) */
  nodeId: string;
  /** Human display label */
  displayName: string;
  /** The current approved snapshot (identity PATHS on the node, never key contents) */
  snapshot: SshConnectionSnapshotWire;
  /** Remote-directory default; null = destination login default */
  remoteDir: string | null;
  /** Current revision (grants pin their own; an edit invalidates the old ones) */
  revision: number;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last revision-bearing update */
  updatedAt: string;
}

/** One granted row as `list_ssh_connections` answers it: the REST row plus the display-only destination. */
export interface SshGrantedConnectionView extends SshConnectionView {
  /** Destination rendered from the snapshot for DISPLAY ("deploy@app-02.example.net:22"); never routable input (agent requests carry connection ids only) */
  destination: string;
}

/** `list_ssh_connections` output: the `SshConnectionListView` shape, granted rows only. */
export interface SshGrantedConnectionListView {
  /** Connections with an ACTIVE grant bound to this pane's current key, newest first; empty means none granted */
  connections: SshGrantedConnectionView[];
}

/** A run, mirroring the frozen `SshRunView` verbatim (already camelCase; the tools pass it through untouched). */
export interface SshRunView {
  /** Server-allocated opaque run id */
  id: string;
  /** Source connection; null after the connection was deleted */
  connectionId: string | null;
  /** Connection revision pinned at dispatch */
  connectionRevision: number;
  /** Connecting node id; null after the node was deleted */
  nodeId: string | null;
  /** Immutable destination snapshot used for this run */
  snapshot: SshConnectionSnapshotWire;
  /** Who initiated (an agent-opened run says agent) */
  initiatedBy: SshActorSide;
  /** Lifecycle; `unknown` is honest and never dressed as failed or succeeded */
  status: SshRunLifecycle;
  /** True = cancellation requested through the plane */
  cancelRequested: boolean;
  /** True = the LOCAL supervised ssh stopped; remote descendants are never confirmed */
  cancelLocalConfirmed: boolean;
  /** True = the execution deadline fired */
  deadlineHit: boolean;
  /** The deadline the run was dispatched with (ms) */
  deadlineMs: number;
  /** Observed remote exit status; null unless observed */
  remoteStatus: number | null;
  /** True only when `remoteStatus` is a CONFIRMED remote result; ssh's ambiguous 255 alone never earns true */
  remoteStatusConfirmed: boolean;
  /** Local ssh exit code; null unless it exited */
  localExitCode: number | null;
  /** Signal name that killed the local ssh; null unless signalled */
  localExitSignal: string | null;
  /** The command as dispatched */
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

/** A bounded output window plus fresh run facts, mirroring the frozen `SshRunOutputView`. */
export interface SshRunOutputView {
  /** The run's facts, current at answer time */
  run: SshRunView;
  /** Decoded stdout bytes for this window (output is DATA, never HTML) */
  stdout: string;
  /** Decoded stderr bytes */
  stderr: string;
  /** stdout offset to pass next */
  stdoutNext: number;
  /** stderr offset to pass next */
  stderrNext: number;
  /** stdout total retained */
  stdoutTotal: number;
  /** stderr total retained */
  stderrTotal: number;
  /** True when retention drain dropped bytes; this window is not the whole transcript */
  truncated: boolean;
  /** True when a requested offset points past retained output: restart from 0, never reuse the dead cursor */
  cursorExpired: boolean;
}

/** A managed SSH terminal pane, mirroring the frozen `SshTerminalView`. */
export interface SshTerminalView {
  /** The new pane's subshell id: follow-on control rides the ordinary pane tools behind the SSH policy */
  subshellId: string;
  /** Connection the terminal connects */
  connectionId: string;
  /** Revision pinned at open */
  connectionRevision: number;
  /** Who opened it (decides the initial control owner) */
  initiatedBy: SshActorSide;
  /** Who holds input now (agent-opened panes start in agent control; only humans return it) */
  controlOwner: SshActorSide;
  /** Current input generation (the node-enforced takeover fence counter) */
  controlGeneration: number;
  /** Current log generation (rotation cursor namespace) */
  logGeneration: number;
  /** ISO 8601 open time */
  createdAt: string;
}

/** One `exec_in_terminal` record, mirroring the frozen `SshTerminalExecView` (read-only recovery). */
export interface SshTerminalExecView {
  /** Execution id (uuid; the recovery handle) */
  id: string;
  /** The pane the command was typed into */
  subshellId: string;
  /** Observation state; `outstanding` means still watched, not hung */
  state: SshExecObservationState;
  /** Marker-reported exit status; null unless completed */
  exitCode: number | null;
  /** Bounded captured output tail (newest kept); null until the record resolves */
  output: string | null;
  /** True when the tail dropped older lines */
  outputTruncated: boolean;
  /** Log offset past the sentinel (or where observation stopped); read_subshell_log's from_byte resumes there */
  nextByte: number | null;
  /** The pane's input generation at typing time (a takeover moved it; this record's receipt says so) */
  inputGeneration: number;
  /** ISO 8601 typing time */
  createdAt: string;
  /** ISO 8601 resolution time; null while outstanding */
  resolvedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Handlers (thin `deps.api` calls; the server holds every bound)       */
/* ------------------------------------------------------------------ */

/**
 * Render the destination from an approved snapshot for DISPLAY
 * ("deploy@app-02.example.net:22"). This is presentation, never input:
 * agent requests name connection IDs, never hosts (spec §2).
 */
function renderDestination(snapshot: SshConnectionSnapshotWire): string {
  return `${snapshot.user === null ? "" : `${snapshot.user}@`}${snapshot.host}:${snapshot.port}`;
}

/**
 * `list_ssh_connections`: the connections granted to THIS pane. The
 * server's filtered read does the granting (an active grant bound to this
 * pane's current key and a still-matching revision); an ungranted same-owner
 * connection is simply absent, and no config file contents ever ride.
 */
export async function listSshConnections(deps: ToolDeps): Promise<SshGrantedConnectionListView> {
  const view = await deps.api.req<{ connections: SshConnectionView[] }>("/api/ssh/connections");
  return {
    connections: view.connections.map((c) => ({ ...c, destination: renderDestination(c.snapshot) })),
  };
}

/** Args of `execute_ssh_command` (snake_case per the frozen MCP block). */
export interface ExecuteSshCommandArgs {
  /** Connection to run on (a uuid from list_ssh_connections; never a raw host) */
  connection_id: string;
  /** The remote command (the one intentional shell code in the contract) */
  command: string;
  /** Per-run absolute remote directory; absent = the connection's default */
  remote_dir?: string;
  /** Deadline in ms; the server clamps (default 5 min, max 1 h) */
  deadline_ms?: number;
}

/**
 * `execute_ssh_command`: START one structured run; the answer is the run
 * record promptly (`status: "accepted"`), output arrives later through
 * read_ssh_command. Nothing here retries: a refusal or a lost answer means
 * the caller re-decides, it does not replay (a resend is a NEW run, and
 * commands that ran once must not run twice on a guess).
 */
export async function executeSshCommand(deps: ToolDeps, args: ExecuteSshCommandArgs): Promise<SshRunView> {
  return await deps.api.req<SshRunView>("/api/ssh/runs", {
    method: "POST",
    body: {
      connectionId: args.connection_id,
      command: args.command,
      ...(args.remote_dir !== undefined ? { remoteDir: args.remote_dir } : {}),
      ...(args.deadline_ms !== undefined ? { deadlineMs: args.deadline_ms } : {}),
    },
  });
}

/** Args of `read_ssh_command`. */
export interface ReadSshCommandArgs {
  /** Opaque run id from execute_ssh_command */
  run_id: string;
  /** stdout byte offset to read from (0 restarts after cursorExpired) */
  stdout_from_byte?: number;
  /** stderr byte offset to read from */
  stderr_from_byte?: number;
  /** Combined cap across both streams (server-clamped, not refused) */
  max_bytes?: number;
  /** Long-poll budget ms (server-capped at 30 s); a wait is neither an error nor a cancel */
  wait_ms?: number;
}

/**
 * `read_ssh_command`: bounded incremental output plus fresh run facts.
 * A timed-out wait answers the current window with the run still `running`:
 * reading, waiting, or closing NEVER cancels (spec: the run outlives the
 * read). Forward the client signal so an abandoned call releases the
 * backend socket mid long-poll.
 */
export async function readSshCommand(
  deps: ToolDeps,
  args: ReadSshCommandArgs,
  signal?: AbortSignal,
): Promise<SshRunOutputView> {
  const { run_id, ...window } = args;
  return await deps.api.req<SshRunOutputView>(
    `/api/ssh/runs/${encodeURIComponent(run_id)}/output`,
    camelQuery(window, signal),
  );
}

/** Args of `cancel_ssh_command`. */
export interface CancelSshCommandArgs {
  /** Opaque run id */
  run_id: string;
}

/**
 * `cancel_ssh_command`: REQUEST cancellation. The returned run view carries
 * the honest half: `cancelLocalConfirmed` is about the LOCAL supervised ssh,
 * and remote descendants are unconfirmed by contract (commands can daemonize
 * or outlive the connection; nothing here claims otherwise).
 */
export async function cancelSshCommand(deps: ToolDeps, args: CancelSshCommandArgs): Promise<SshRunView> {
  return await deps.api.req<SshRunView>(`/api/ssh/runs/${encodeURIComponent(args.run_id)}/cancel`, {
    method: "POST",
  });
}

/** Args of `open_ssh_terminal`. */
export interface OpenSshTerminalArgs {
  /** Connection to connect (a uuid from list_ssh_connections) */
  connection_id: string;
  /** Initial grid columns, when the opener knows one */
  cols?: number;
  /** Initial grid rows */
  rows?: number;
}

/**
 * `open_ssh_terminal`: create a managed interactive SSH pane. The answer is
 * the pane identity; follow-on input and output ride the ordinary pane tools
 * (send_to_subshell, read_subshell_log) behind the SSH policy. An
 * agent-opened pane starts in agent control; a human takeover blocks agent
 * reads and writes until a human returns it.
 */
export async function openSshTerminal(deps: ToolDeps, args: OpenSshTerminalArgs): Promise<SshTerminalView> {
  return await deps.api.req<SshTerminalView>("/api/ssh/terminals", {
    method: "POST",
    body: {
      connectionId: args.connection_id,
      ...(args.cols !== undefined ? { cols: args.cols } : {}),
      ...(args.rows !== undefined ? { rows: args.rows } : {}),
    },
  });
}

/** Args of `get_terminal_execution`. */
export interface GetTerminalExecutionArgs {
  /** The pane the exec was typed into */
  subshell_id: string;
  /** Execution id from the exec_in_terminal answer */
  execution_id: string;
}

/**
 * `get_terminal_execution`: recover an existing `exec_in_terminal` result
 * by execution id, READ-ONLY (its one side effect is re-arming observation
 * of an outstanding record; it mutates no command). `unknown` is reported as
 * `unknown`, never renamed to completed or failed.
 */
export async function getTerminalExecution(
  deps: ToolDeps,
  args: GetTerminalExecutionArgs,
): Promise<SshTerminalExecView> {
  return await deps.api.req<SshTerminalExecView>(
    `/api/subshells/${encodeURIComponent(args.subshell_id)}/execs/${encodeURIComponent(args.execution_id)}`,
  );
}

/** Build the GET init: camelCase query params (the REST grammar), only the present ones, plus the signal. */
function camelQuery(
  window: Omit<ReadSshCommandArgs, "run_id">,
  signal?: AbortSignal,
): { query: Record<string, unknown>; signal?: AbortSignal } {
  const query: Record<string, unknown> = {};
  if (window.stdout_from_byte !== undefined) query.stdoutFromByte = window.stdout_from_byte;
  if (window.stderr_from_byte !== undefined) query.stderrFromByte = window.stderr_from_byte;
  if (window.max_bytes !== undefined) query.maxBytes = window.max_bytes;
  if (window.wait_ms !== undefined) query.waitMs = window.wait_ms;
  return { query, ...(signal ? { signal } : {}) };
}

/* ------------------------------------------------------------------ */
/* Honest error mapping                                                 */
/* ------------------------------------------------------------------ */

/**
 * The named SSH refusal riding an error body's `metadata.sshCode` (both
 * frozen code sets, matched by EQUALITY), or null when nothing named it.
 */
export function sshRefusalCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const code = err.metadata?.sshCode;
  if (isSshErrorCode(code) || isSshPolicyCode(code)) return code;
  return null;
}

/**
 * Map an SSH-family failure to the sentence an agent acts on. The server
 * already answers every named refusal with an honest fixed sentence
 * (protocol `SSH_ERROR_DESCRIPTIONS` / policy sentences) and rides the code
 * in `metadata.sshCode`; this adds the SSH-aware framing the generic
 * {@link describeToolError} cannot know: a 404 here is an invisible
 * run/connection/execution and a missing grant answers exactly like one
 * (no-enumeration), so pointing at `list_subshells` would be a lie; a bare
 * 403 is the coarse scope or a human-control block, whose remedy is a human.
 * Everything un-named (the 401 token death, generic 409, 5xx) falls through
 * to the shared map unchanged. No branch ever retries: this is a rephrasing,
 * not a loop.
 */
export function describeSshToolError(err: unknown): Error {
  if (err instanceof ApiError) {
    const code = sshRefusalCode(err);
    if (code !== null && code !== "not_found") {
      return new Error(`subshell: ssh refusal (${code}): ${err.message}`);
    }
    if (code === "not_found" || err.status === 404) {
      return new Error(
        `subshell: not found: that SSH run, connection, or execution id is not visible to this pane (a missing, revoked, or stale-revision grant answers exactly like a wrong id: 404 never says which). list_ssh_connections lists what is granted; run and execution ids come from this pane's own execute_ssh_command / exec_in_terminal answers.`,
      );
    }
    if (err.status === 403) {
      return new Error(
        `subshell: ssh refused for this pane: ${err.message}; SSH needs the ssh scope on this pane's token AND a human-issued grant for this connection. Neither is self-serviceable from inside a pane, and never restart your own pane to try to fix it.`,
      );
    }
    return describeToolError(err);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/* ------------------------------------------------------------------ */
/* Tool input schemas (named consts per the code-style rule)            */
/* ------------------------------------------------------------------ */

/** `list_ssh_connections`: no arguments; this pane's grants decide the list (there is no "all"). */
export const ListSshConnectionsToolSchema = z.object({});

/**
 * `execute_ssh_command`. Deliberately NO length/deadline bounds (the
 * terminal-tools precedent): the server caps the command and clamps the
 * deadline, and a schema bound would refuse where REST clamps.
 */
export const ExecuteSshCommandToolSchema = z.object({
  connection_id: z
    .string()
    .min(1)
    .describe(
      "Granted connection id from list_ssh_connections; raw hosts, users, ports, and aliases are never accepted",
    ),
  command: z.string().min(1).describe("The remote command line: the one intentional shell code in this contract"),
  remote_dir: z
    .string()
    .optional()
    .describe("Absolute directory ON THE DESTINATION overriding the connection default; omit to use the default"),
  deadline_ms: z
    .number()
    .int()
    .optional()
    .describe("Execution deadline in ms; the server clamps (default 5 min, max 1 h)"),
});

/** `read_ssh_command`: run id plus the byte window; every bound is the server's (clamp, not refuse). */
export const ReadSshCommandToolSchema = z.object({
  run_id: z.string().min(1).describe("Opaque run id from execute_ssh_command"),
  stdout_from_byte: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("stdout offset to continue from (previous stdoutNext; 0 restarts after cursorExpired)"),
  stderr_from_byte: z.number().int().nonnegative().optional().describe("stderr offset to continue from"),
  max_bytes: z
    .number()
    .int()
    .optional()
    .describe(
      "Combined cap across both streams for this window (server default and max 256 KiB; clamped, not refused)",
    ),
  wait_ms: z
    .number()
    .int()
    .optional()
    .describe(
      "Long-poll budget in ms (server cap 30000); a wait that times out answers the current window and CANCELS NOTHING",
    ),
});

/** `cancel_ssh_command`: which run to ask to stop. */
export const CancelSshCommandToolSchema = z.object({
  run_id: z.string().min(1).describe("Opaque run id from execute_ssh_command"),
});

/** `open_ssh_terminal`: connection id plus an optional initial grid; grid bounds are the server's. */
export const OpenSshTerminalToolSchema = z.object({
  connection_id: z
    .string()
    .min(1)
    .describe("Granted connection id from list_ssh_connections; only ids, never destination strings"),
  cols: z.number().int().optional().describe("Initial columns, when known"),
  rows: z.number().int().optional().describe("Initial rows, when known"),
});

/** `get_terminal_execution`: which pane, which execution record. */
export const GetTerminalExecutionToolSchema = z.object({
  subshell_id: z.string().min(1).describe("The pane the exec was typed into"),
  execution_id: z.string().min(1).describe("Execution id from the exec_in_terminal answer (its durable record id)"),
});
