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
 * lives in the Metro-safe barrel. The control-state and run-facts grammar
 * live in `ssh-run-facts.ts` and the result ENVELOPE types in
 * `ssh-results.ts` (Gate A review split); their `parse*` validators live in
 * `node-results.ts` beside every other result validator (the four-site rule
 * in the integration maps).
 */

import { isInt, isRecord, isStr } from "./guards.js";
import { parseSshConnectionSnapshot, type SshConnectionSnapshotWire } from "./ssh-config.js";
import {
  SSH_COMMAND_MAX_CHARS,
  SSH_NAME_MAX_CHARS,
  SSH_OUTPUT_WINDOW_MAX_BYTES,
  SSH_PATH_MAX_CHARS,
  SSH_READ_LONG_POLL_MAX_MS,
  SSH_RUN_DEADLINE_MAX_MS,
} from "./ssh-limits.js";
import { isSshRunId, type SshControlMode } from "./ssh-run-facts.js";

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
 * different payload under the same ID answers the bare `run_conflict` code
 * - never a second spawn.
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
 * (strict host checking, no forwarding/agent forwarding/X11 forwarding/
 * escapes/control sockets/multiplexing, no ambient config reread) - the
 * plane ships the approved destination, the machine owns the argv
 * construction, exactly the inversion posture of `launch`.
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

/** An absolute remote path on the wire: leading `/`, length-bounded like the snapshot's refs, no control characters. Shape only - the node stats it. */
function isAbsPath(value: unknown): value is string {
  return isStr(value) && value.startsWith("/") && value.length <= SSH_PATH_MAX_CHARS && !/\s|\p{Cc}/u.test(value);
}

/**
 * Validates and narrows any `ssh_*` command body. `parseNodeCommandBody`
 * routes its nine `type` arms here so the SSH grammar lives in ONE file
 * beside the commands it narrows; the contract it upholds is the same: a
 * NON-null return is safe to switch on by `type`.
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
      if (!snapshot || !isSshRunId(value.runId)) return null;
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
      return isSshRunId(value.runId) ? { type: "ssh_run_status", runId: value.runId } : null;
    case "ssh_run_cancel":
      return isSshRunId(value.runId) ? { type: "ssh_run_cancel", runId: value.runId } : null;
    case "ssh_run_read": {
      if (!isSshRunId(value.runId)) return null;
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
