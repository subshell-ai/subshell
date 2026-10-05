/**
 * SSH node wire commands (SSH-SUPPORT.md §4: "Node wire commands cover human
 * config discovery/resolution, test, run start/status/read/cancel, SSH
 * terminal launch, and input-control generation transitions").
 *
 * These are the `cmd` arms of {@link NodeCommandBody}; they ride the existing
 * signed/encrypted command transport unchanged - signing proves WHO ordered
 * it, this file freezes WHAT was ordered. Like the transfer family before
 * them, a short RPC starts or asks for a bounded slice of work; NOTHING here
 * is one long RPC held open past the plane's response deadline (the run's
 * output lives on the node, and the plane drives read loops).
 *
 * The commands are TRANSPORT-AGNOSTIC plain objects: the server-hosted
 * `local` node executes the same runtime in-process against these exact
 * bodies, so nothing may assume a socket, a jti, or a signature - those are
 * the transport's, and they live outside the body.
 *
 * Every snapshot-bearing command is validated through
 * {@link parseSshConnectionSnapshot} AT THE PARSE, before dispatch: a frame
 * the grammar cannot express is refused exactly like every other malformed
 * frame, and the executor never sees a `ProxyCommand` to "just render".
 *
 * Hand-rolled in the `node-frames.ts` style; imports no `node:` builtin;
 * lives in the Metro-safe barrel. Result ENVELOPE types are here (they are
 * part of the command's contract); their `parse*` validators live in
 * `node-results.ts` beside every other result validator (the four-site rule
 * in the integration maps).
 */

import { isBool, isInt, isRecord, isStr } from "./guards.js";
import { parseSshConnectionSnapshot, type SshConnectionSnapshotWire } from "./ssh-config.js";
import type { SshErrorCode } from "./ssh-errors.js";
import {
  SSH_COMMAND_MAX_CHARS,
  SSH_MAX_DISCOVERED_ALIASES,
  SSH_NAME_MAX_CHARS,
  SSH_OUTPUT_WINDOW_MAX_BYTES,
  SSH_READ_LONG_POLL_MAX_MS,
  SSH_RUN_DEADLINE_MAX_MS,
} from "./ssh-limits.js";

/* ------------------------------------------------------------------ */
/* control state                                                       */
/* ------------------------------------------------------------------ */

/**
 * Who holds input control of a managed SSH terminal. Humans can take over
 * immediately; ONLY humans return control to agents (SSH-SUPPORT.md §3).
 */
export const SSH_CONTROL_MODES = ["agent", "human"] as const;

/** One side of the input-control boundary. */
export type SshControlMode = (typeof SSH_CONTROL_MODES)[number];

/**
 * `result.error` from an input or prompt-delivery the node refused because its
 * per-pane generation had moved on: a takeover or a revocation fenced it.
 *
 * Bare, like every `NODE_RESULT_*` constant - the plane matches
 * `NodeRpcError.detail` by EQUALITY, and the same refusal on every input
 * surface is what makes "fence stale queued input" one fact rather than
 * several heuristics.
 */
export const NODE_RESULT_SSH_GENERATION_STALE = "stale input generation";

/* ------------------------------------------------------------------ */
/* run lifecycle facts (SSH-SUPPORT.md §3, Structured commands)        */
/* ------------------------------------------------------------------ */

/**
 * Run lifecycle as a runtime list. `accepted` means the node DURABLY recorded
 * the request before spawning; a crash between acceptance and spawn reads
 * back `unknown`, never a retry. `unknown` must not masquerade as failed or
 * successful - that honesty is why it exists beside `completed`, not under
 * either.
 */
export const SSH_RUN_LIFECYCLES = ["accepted", "running", "completed", "unknown"] as const;

/** One lifecycle state from {@link SSH_RUN_LIFECYCLES}. */
export type SshRunLifecycle = (typeof SSH_RUN_LIFECYCLES)[number];

/**
 * The lifecycle + cancellation/deadline + exit facts of one run, as the
 * start/status/cancel/read answers all carry them. Cancellation and deadline
 * are SEPARATE facts from lifecycle on purpose: a `completed` run may also
 * carry `cancelRequested` (cancelled, then finished cleanly) or
 * `deadlineHit` (won its race against supervision), and a `running` run may
 * already carry a pending cancellation.
 */
export interface SshRunFactsWire {
  /** Echo of the server-allocated opaque run ID (also the node's filesystem name). */
  runId: string;
  /** Lifecycle state at answer time. */
  lifecycle: SshRunLifecycle;
  /** A cancellation was requested for this run. */
  cancelRequested: boolean;
  /**
   * The LOCAL supervised ssh/helper processes are stopped (within
   * `SSH_CANCEL_GRACE_MS`). Remote descendants are never confirmed -
   * terminating SSH never guarantees they died.
   */
  cancelLocalConfirmed: boolean;
  /** The run's execution deadline fired. */
  deadlineHit: boolean;
  /**
   * Observed REMOTE exit status, null when nothing was observed. `completed`
   * always carries one; `unknown` carries none.
   */
  remoteStatus: number | null;
  /**
   * True when `remoteStatus` is a CONFIRMED remote program status. OpenSSH
   * reports 255 both for its own transport failures and for a remote program
   * exiting 255 (man.openbsd.org/ssh#EXIT_STATUS), so a 255 seen without
   * corroborating transport facts carries `false`: the number alone must
   * never be asserted as a confirmed remote result.
   */
  remoteStatusConfirmed: boolean;
  /** Local ssh child's exit code (null if it died by signal or status was never seen). */
  localExitCode: number | null;
  /** Signal name that killed the local ssh child (null unless it was signalled). */
  localExitSignal: string | null;
}

/* ------------------------------------------------------------------ */
/* result envelope types                                               */
/* ------------------------------------------------------------------ */

/**
 * `ssh_discover_aliases` answer: NAMES of usable aliases, never config file
 * contents (SSH-SUPPORT.md §2). Wildcard-only entries are already excluded
 * and include cycles detected (the cycle is a FACT the human reviewing the
 * list needs, never a silent stop).
 */
export interface NodeSshAliasListResult {
  /** Alias names, sorted, deduplicated, at most {@link SSH_MAX_DISCOVERED_ALIASES}. */
  aliases: string[];
  /** An include cycle was detected during the bounded parse; the list is what parsed before it. */
  includeCycle: boolean;
  /** The alias cap was hit; more exist. */
  truncated: boolean;
}

/**
 * `ssh_resolve_config` answer. The refusal is IN THE DATA, not an `ok:false`
 * result: "this config needs a ProxyCommand" is a SUCCESSFUL resolution
 * outcome the human must read (which setting blocked), not a transport error.
 * `settings` names the blocked settings by the config keyword (a `ProxyCommand`
 * row, a `LocalForward` row, …) so the human can edit the config and re-resolve.
 */
export type NodeSshResolveOutcomeWire =
  | {
      /** The alias normalized cleanly into an approved snapshot. */
      accepted: true;
      /** The snapshot the human reviews, then saves. */
      snapshot: SshConnectionSnapshotWire;
      /**
       * The connecting account's OS user name, when the node could report it
       * - the §3 UI sentence "review resolved destination AND connecting OS
       * account" needs a name the snapshot itself never carries. Optional by
       * design: an agent that cannot resolve `os.userInfo` answers without
       * it and the review proceeds (the destination facts are the load-
       * bearing half; this is display).
       */
      connectingAccount?: string;
    }
  | {
      /** Resolution refused: the config needs something Subshell will not run, or the destination/auth facts failed. */
      accepted: false;
      /** The named limitation ({@link SshErrorCode} subset: unsupported_setting, config_missing, config_ambiguous, proxy_chain_too_long, …). */
      code: SshErrorCode;
      /** Config keywords that blocked acceptance; empty when the code names the whole cause. */
      settings: string[];
    };

/**
 * `ssh_test_connection` answer. The probe is FIXED and benign - the node runs
 * its own connect-and-exit check against the snapshot; there is no
 * caller-supplied probe text anywhere in this contract, and the boolean plus
 * a named code is the whole answer.
 */
export type NodeSshTestOutcomeWire = { passed: true } | { passed: false; code: SshErrorCode };

/**
 * `ssh_run_read` answer: the bounded incremental window plus a full copy of
 * {@link SshRunFactsWire} - a read must always be able to answer "and is it
 * done?" without a second round trip, which is also what keeps a plane-driven
 * poll loop honest about a run that completed between windows.
 */
export interface NodeSshRunReadResult extends SshRunFactsWire {
  /** Base64 stdout bytes starting at the request's `stdoutFromByte`. */
  stdoutB64: string;
  /** Base64 stderr bytes starting at the request's `stderrFromByte`. */
  stderrB64: string;
  /** Offset to pass next for stdout (request offset + bytes returned). */
  stdoutNext: number;
  /** Offset to pass next for stderr. */
  stderrNext: number;
  /** Total bytes RETAINED for stdout (past `SSH_RUN_OUTPUT_RETENTION_BYTES` the node drained excess). */
  stdoutTotal: number;
  /** Total bytes RETAINED for stderr. */
  stderrTotal: number;
  /** Drain dropped bytes beyond the per-run retention; the window is not the whole transcript. */
  truncated: boolean;
}

/**
 * `ssh_input_control` answer: the node's CURRENT control state after the
 * transition (echoing what took effect, which is what lets the plane detect a
 * lost race against a takeover happening at the machine).
 */
export interface NodeSshControlResult {
  /** The managed pane (echo). */
  subshellId: string;
  /** Whose input the node now accepts. */
  mode: SshControlMode;
  /** The node's current input generation after this transition; later writes must carry at least this. */
  generation: number;
}

/* ------------------------------------------------------------------ */
/* command bodies                                                      */
/* ------------------------------------------------------------------ */

/**
 * Bounded parse of the connecting account's SSH config for alias NAMES. Takes
 * no input beyond the command itself (which node answers it is the
 * transport's, not the body's). Human-only at the API level; the node holds
 * no concept of who asked - the signature already did that part.
 */
export interface SshDiscoverAliasesCommand {
  type: "ssh_discover_aliases";
}

/** Resolve one alias into the approved normalized snapshot (or a named refusal). Human config step. */
export interface SshResolveConfigCommand {
  type: "ssh_resolve_config";
  /** The config token to resolve. Shape-checked here; whether it EXISTS in the account's config is what the command is for. */
  alias: string;
}

/**
 * Test a snapshot with the node's FIXED benign probe. NOT caller command
 * text, and not a run: no run ID, no dedup record, no output storage.
 */
export interface SshTestConnectionCommand {
  type: "ssh_test_connection";
  /** The approved snapshot to probe. */
  snapshot: SshConnectionSnapshotWire;
}

/**
 * Start a structured run. The node durably records acceptance BEFORE
 * spawning, under this exact ID + digest (SSH-SUPPORT.md §3, Durable
 * dispatch): a duplicate delivery returns the existing state, and a
 * different payload under the same ID answers {@link
 * SshErrorCode}"run_conflict" - never a second spawn.
 */
export interface SshRunStartCommand {
  type: "ssh_run_start";
  /**
   * Server-allocated opaque run ID, also the node's filesystem name. The
   * plane mints it to satisfy `isNodeSubshellId`'s grammar (hex + hyphen,
   * <= 64); the parser checks stringness here, and the node re-checks at the
   * path-composition site exactly like the subshell-id posture (throw, never
   * compose).
   */
  runId: string;
  /** The approved snapshot to connect to (re-validated agent-side). */
  snapshot: SshConnectionSnapshotWire;
  /** Absolute remote working directory; null = the destination account's login default. Quoted as POSIX data at the remote shell. */
  remoteDir: string | null;
  /** The remote command: the ONE intentional shell code in this contract. */
  command: string;
  /** Supervised execution deadline in ms; the parser caps at `SSH_RUN_DEADLINE_MAX_MS`. */
  deadlineMs: number;
  /** Lowercase-hex sha256 over the complete request payload (spec §3's request binding; the digest check is the dedup's second half). */
  requestDigest: string;
}

/** Ask a run's current facts. Unknown IDs answer the bare `run_unknown` code. */
export interface SshRunStatusCommand {
  type: "ssh_run_status";
  /** The run ID to ask about. */
  runId: string;
}

/**
 * Read a bounded incremental output window (and the run's facts). `waitMs`
 * long-polls node-side for new output up to the cap; a timed-out wait answers
 * an empty window with current facts, which the plane relays as "nothing yet"
 * rather than an error. Browser closure or a read timeout NEVER cancels
 * execution - the node holds no reader state across commands.
 */
export interface SshRunReadCommand {
  type: "ssh_run_read";
  /** The run to read. */
  runId: string;
  /** stdout byte offset; 0 is the start of retained output. */
  stdoutFromByte: number;
  /** stderr byte offset. */
  stderrFromByte: number;
  /** Combined cap on the bytes returned across both streams; parser-capped at `SSH_OUTPUT_WINDOW_MAX_BYTES`. */
  maxBytes: number;
  /** Long-poll budget in ms; parser-capped at `SSH_READ_LONG_POLL_MAX_MS`. */
  waitMs: number;
}

/**
 * Request cancellation of a run. The node stops its supervised processes with
 * a bounded grace, answers once (facts included, so `cancelLocalConfirmed`
 * is the same round trip), and never claims remote descendants died.
 */
export interface SshRunCancelCommand {
  type: "ssh_run_cancel";
  /** The run to cancel. */
  runId: string;
}

/**
 * Launch a managed SSH terminal pane: a tmux pane whose FOREGROUND process is
 * ssh, no connecting-node shell fallback, exit ends the pane. The node builds
 * the ssh argv from the snapshot under the mandatory all-hop runtime policy
 * (strict host checking, no forwarding/agents/X11 forwarding/escapes/control
 * sockets/multiplexing, no ambient config reread) - the plane ships the
 * approved destination, the machine owns the argv construction, exactly the
 * inversion posture of `launch`.
 */
export interface SshTerminalLaunchCommand {
  type: "ssh_terminal_launch";
  /** The subshell row's id; also the pane name and log-file stem. */
  subshellId: string;
  /** tmux socket name, as `launch` carries it. */
  socket: string;
  /** The approved snapshot to connect (re-validated agent-side). */
  snapshot: SshConnectionSnapshotWire;
  /** Absolute remote start directory; null = the destination account's login default. */
  remoteDir: string | null;
  /** Initial grid, when the plane knows one (same optionality as `launch`). */
  cols?: number;
  /** Initial grid rows. */
  rows?: number;
}

/**
 * Transition a managed pane's input control (agent -> human takeover, human
 * -> agent return - the latter only ever relayed from a human) and RAISE the
 * node's input generation so everything queued below `generation` is fenced.
 * The generation number is the plane's authoritative counter (mirrored in
 * `ssh_panes.control_generation`); the node refuses a transition that would
 * LOWER it, so a replayed old transition cannot un-fence input.
 */
export interface SshInputControlCommand {
  type: "ssh_input_control";
  /** The managed pane. */
  subshellId: string;
  /** The mode to move to. */
  mode: SshControlMode;
  /** The new generation: strictly greater than the node's current one. */
  generation: number;
}

/** Every SSH-family command body, as one union the {@link NodeCommandBody} union folds in. */
export type SshNodeCommandBody =
  | SshDiscoverAliasesCommand
  | SshResolveConfigCommand
  | SshTestConnectionCommand
  | SshRunStartCommand
  | SshRunStatusCommand
  | SshRunReadCommand
  | SshRunCancelCommand
  | SshTerminalLaunchCommand
  | SshInputControlCommand;

/* ------------------------------------------------------------------ */
/* arm validators (delegated from parseNodeCommandBody)                */
/* ------------------------------------------------------------------ */

/** Same hygiene the snapshot applies to names; a config alias is the same kind of string. */
function isAliasName(value: unknown): value is string {
  return (
    isStr(value) &&
    value.length > 0 &&
    value.length <= SSH_NAME_MAX_CHARS &&
    !value.startsWith("-") &&
    !/\s|\p{Cc}/u.test(value)
  );
}

function isRunId(value: unknown): value is string {
  return isStr(value) && value.length > 0 && value.length <= 64;
}

/** The facts grammar, shared by every command answer that carries run state. Used by node-results.ts. */
export function readSshRunFacts(data: Record<string, unknown>): SshRunFactsWire | null {
  if (!isRunId(data.runId)) return null;
  if (
    !(
      data.lifecycle === "accepted" ||
      data.lifecycle === "running" ||
      data.lifecycle === "completed" ||
      data.lifecycle === "unknown"
    )
  )
    return null;
  if (!isBool(data.cancelRequested) || !isBool(data.cancelLocalConfirmed) || !isBool(data.deadlineHit)) return null;
  if (!("remoteStatus" in data) || !(data.remoteStatus === null || isInt(data.remoteStatus))) return null;
  if (!isBool(data.remoteStatusConfirmed)) return null;
  if (!("localExitCode" in data) || !(data.localExitCode === null || isInt(data.localExitCode))) return null;
  if (!("localExitSignal" in data) || !(data.localExitSignal === null || isStr(data.localExitSignal))) return null;
  return {
    runId: data.runId,
    lifecycle: data.lifecycle as SshRunLifecycle,
    cancelRequested: data.cancelRequested,
    cancelLocalConfirmed: data.cancelLocalConfirmed,
    deadlineHit: data.deadlineHit,
    remoteStatus: data.remoteStatus as number | null,
    remoteStatusConfirmed: data.remoteStatusConfirmed,
    localExitCode: data.localExitCode as number | null,
    localExitSignal: data.localExitSignal as string | null,
  };
}

/**
 * Validates and narrows any `ssh_*` command body. `parseNodeCommandBody`
 * routes its nine `type` arms here so the SSH grammar lives in ONE file
 * instead of nine cases in a 1700-line frame module; the contract it upholds
 * is the same: a NON-null return is safe to switch on by `type`.
 *
 * @param value - candidate payload whose `type` starts with `ssh_`
 * @returns the narrowed command, or null when malformed
 */
export function parseSshNodeCommandBody(value: unknown): SshNodeCommandBody | null {
  if (!isRecord(value) || !isStr(value.type)) return null;
  switch (value.type) {
    case "ssh_discover_aliases":
      return { type: "ssh_discover_aliases" };
    case "ssh_resolve_config":
      return isAliasName(value.alias) ? { type: "ssh_resolve_config", alias: value.alias } : null;
    case "ssh_test_connection": {
      const snapshot = parseSshConnectionSnapshot(value.snapshot);
      return snapshot ? { type: "ssh_test_connection", snapshot } : null;
    }
    case "ssh_run_start": {
      const snapshot = parseSshConnectionSnapshot(value.snapshot);
      if (!snapshot || !isRunId(value.runId)) return null;
      if (!isStr(value.command) || value.command.length === 0 || value.command.length > SSH_COMMAND_MAX_CHARS)
        return null;
      if (!("remoteDir" in value) || !(value.remoteDir === null || isAbsPath(value.remoteDir))) return null;
      if (
        !isInt(value.deadlineMs) ||
        (value.deadlineMs as number) <= 0 ||
        (value.deadlineMs as number) > SSH_RUN_DEADLINE_MAX_MS
      )
        return null;
      if (!isStr(value.requestDigest) || !/^[0-9a-f]{64}$/.test(value.requestDigest)) return null;
      return {
        type: "ssh_run_start",
        runId: value.runId,
        snapshot,
        remoteDir: value.remoteDir as string | null,
        command: value.command,
        deadlineMs: value.deadlineMs as number,
        requestDigest: value.requestDigest,
      };
    }
    case "ssh_run_status":
      return isRunId(value.runId) ? { type: "ssh_run_status", runId: value.runId } : null;
    case "ssh_run_cancel":
      return isRunId(value.runId) ? { type: "ssh_run_cancel", runId: value.runId } : null;
    case "ssh_run_read": {
      if (!isRunId(value.runId)) return null;
      if (
        !isInt(value.stdoutFromByte) ||
        (value.stdoutFromByte as number) < 0 ||
        !isInt(value.stderrFromByte) ||
        (value.stderrFromByte as number) < 0
      )
        return null;
      // maxBytes is window-capped AT THE PARSE: the window is what must fit
      // the frame (same reasoning as `file_read`), and a parser that allowed
      // more would advertise a lie the frame would then truncate.
      if (
        !isInt(value.maxBytes) ||
        (value.maxBytes as number) <= 0 ||
        (value.maxBytes as number) > SSH_OUTPUT_WINDOW_MAX_BYTES
      )
        return null;
      if (!isInt(value.waitMs) || (value.waitMs as number) < 0 || (value.waitMs as number) > SSH_READ_LONG_POLL_MAX_MS)
        return null;
      return {
        type: "ssh_run_read",
        runId: value.runId,
        stdoutFromByte: value.stdoutFromByte as number,
        stderrFromByte: value.stderrFromByte as number,
        maxBytes: value.maxBytes as number,
        waitMs: value.waitMs as number,
      };
    }
    case "ssh_terminal_launch": {
      if (!isStr(value.subshellId) || !isStr(value.socket)) return null;
      const snapshot = parseSshConnectionSnapshot(value.snapshot);
      if (!snapshot) return null;
      if (!("remoteDir" in value) || !(value.remoteDir === null || isAbsPath(value.remoteDir))) return null;
      if ("cols" in value && !(isInt(value.cols) && (value.cols as number) > 0)) return null;
      if ("rows" in value && !(isInt(value.rows) && (value.rows as number) > 0)) return null;
      return {
        type: "ssh_terminal_launch",
        subshellId: value.subshellId,
        socket: value.socket,
        snapshot,
        remoteDir: value.remoteDir as string | null,
        ...(value.cols !== undefined ? { cols: value.cols as number } : {}),
        ...(value.rows !== undefined ? { rows: value.rows as number } : {}),
      };
    }
    case "ssh_input_control": {
      if (!isStr(value.subshellId)) return null;
      if (value.mode !== "agent" && value.mode !== "human") return null;
      if (!isInt(value.generation) || (value.generation as number) < 1) return null;
      return {
        type: "ssh_input_control",
        subshellId: value.subshellId,
        mode: value.mode,
        generation: value.generation as number,
      };
    }
    default:
      return null;
  }
}

/** Local copy of ssh-config's path hygiene (shape grammar; the node still lstats everything). */
function isAbsPath(value: unknown): value is string {
  return isStr(value) && value.startsWith("/") && !/\p{Cc}/u.test(value);
}

/** Every SSH command `type`, for census tests and dispatch tables. */
export const SSH_COMMAND_TYPES = [
  "ssh_discover_aliases",
  "ssh_resolve_config",
  "ssh_test_connection",
  "ssh_run_start",
  "ssh_run_status",
  "ssh_run_read",
  "ssh_run_cancel",
  "ssh_terminal_launch",
  "ssh_input_control",
] as const;
