import type { SshActorSide } from "./ssh-actor-side.js";
import type { SshExecObservationState } from "./ssh-exec-observation-state.js";

/**
 * Database table schema for terminal-exec records (SSH-SUPPORT.md §4,
 * Persistence; §3's "Existing exec_in_terminal" rework). One row per
 * `exec_in_terminal` invocation on a terminal pane, from the moment the
 * command line is typed until the marker resolves it or observation is lost.
 *
 * These rows are what turn the exec helper from a synchronous poll into a
 * recoverable record: the execution ID is the recovery handle (the MCP
 * `get_terminal_execution` read and the REST status operation both land on
 * it), a caller's wait timeout leaves the row `outstanding` with bounded
 * observation continuing, and an explicit takeover or pane restart moves it
 * to `unknown` - the spec's "an explicit human takeover invalidates the
 * result" rule, written as a state transition.
 *
 * The pane INCARNATION (`pane_incarnation`, mirroring the subshell row's
 * `started_at`) is the honest restart test: a row whose incarnation no longer
 * matches the pane's current one can never be completed by a marker - the
 * shell that would print it is gone.
 */
export interface SshTerminalExecTable {
  /** Server-allocated opaque execution id (uuid) - the recovery handle callers hold */
  id: string;
  /** The pane the command was typed into */
  subshellId: string;
  /**
   * The pane's `started_at` stamp at typing time. A mismatch with the pane's
   * CURRENT `started_at` is the restart fact that turns observation `unknown`
   * (no re-derivation, no marker can cross a restart).
   */
  paneIncarnation: string;
  /** Who invoked the exec (a human via REST, or a granted/ordinary pane token via MCP) */
  initiatedBy: SshActorSide;
  /** Grant row when an agent invoked this on an SSH-gated pane; null for human and ordinary-pane invocations */
  grantId: string | null;
  /** The invoking credential's api-key identity for agent invocations; null for humans */
  apiKeyId: string | null;
  /**
   * The pane's input control generation AT TYPING time. An explicit takeover
   * raises the generation, which is the fence: queued follow-up input for
   * this exec (the sentinel `printf`, a caller's retry) is refused node-side
   * once generations disagree.
   */
  inputGeneration: number;
  /**
   * The 16-hex sentinel token of the marker line (`__xcomm_<token>_DONE
   * rc=<n>`). Stored for late-observation matching, and NOTHING may treat
   * marker text as a security fact (spec §3: never upgrade the marker into a
   * decision).
   */
  markerToken: string;
  /** Observation state (see `ssh-exec-observation-state.ts`); `unknown` refuses further automated exec until recovery */
  state: SshExecObservationState;
  /** Marker-reported exit status; non-null only when `state` is `completed` */
  exitCode: number | null;
  /** Bounded output tail captured during observation (server cap, newest kept); null until resolved */
  output: string | null;
  /** 1 when `output` dropped older lines to stay inside the cap */
  outputTruncated: number;
  /** Raw log offset just past the sentinel line (or where observation stopped); the `from_byte` for the caller's next log read */
  nextByte: number | null;
  /** ISO 8601 typing timestamp (DB default) */
  createdAt: string;
  /** ISO 8601 resolution stamp (`completed` or `unknown` reached); null while outstanding */
  resolvedAt: string | null;
}

/** Insert shape: DB default fills `createdAt`; observation starts `outstanding`, result fields null. */
export type NewSshTerminalExec = Omit<
  SshTerminalExecTable,
  "createdAt" | "resolvedAt" | "exitCode" | "output" | "outputTruncated" | "nextByte"
> & { resolvedAt?: string | null };

/** Update shape: the observation half only - the typed-time facts are the record's identity. */
export type SshTerminalExecUpdate = Partial<
  Pick<SshTerminalExecTable, "state" | "exitCode" | "output" | "outputTruncated" | "nextByte" | "resolvedAt">
>;
