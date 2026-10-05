import {
  isSshErrorCode,
  type NodeSshAliasListResult,
  type NodeSshControlResult,
  type NodeSshResolveOutcomeWire,
  type NodeSshRunReadResult,
  type NodeSshTestOutcomeWire,
  parseNodeSshAliasList,
  parseNodeSshControlResult,
  parseNodeSshResolveOutcome,
  parseNodeSshRunFacts,
  parseNodeSshRunReadResult,
  parseNodeSshTestOutcome,
  SSH_PROBE_DEADLINE_MS,
  SSH_READ_LONG_POLL_MAX_MS,
  type SshConnectionSnapshotWire,
  type SshErrorCode,
  type SshHopWire,
  type SshRunFactsWire,
} from "@internal/subshell-protocol";
import { DEFAULT_COMMAND_TIMEOUT_MS, NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * The plane -> node adapter for the frozen `ssh_*` command family
 * (SSH-SUPPORT.md §4: "Short RPCs start work; long tasks are not held inside
 * the existing RPC response deadline"). Every verb here is one signed
 * `sendCommand` round trip plus its shared-parser validation - the same
 * posture the transfer relay set (transfers.service.ts): per-verb deadlines,
 * `parse*` on EVERY answer (a validator-refused answer is a broken node, not
 * a cast opportunity), and node refusals matched by EQUALITY on
 * `NodeRpcError.detail` against the frozen code set, never a substring
 * (AGENTS.md "Node refusals map by EQUALITY").
 *
 * The command bodies are assembled by the SERVICES (they own which snapshot,
 * id and digest ride); this module owns transport, deadlines, parsing, and
 * the error mapping - and NOTHING here queues: an offline node rejects
 * `offline` and the caller maps that to the spec's "refuse while offline"
 * posture (SSH-SUPPORT.md §3: no dispatch while offline; pending CANCELLATION
 * is the one exception, and it is a fact the caller records, not work this
 * module holds).
 */

/** Per-verb deadlines: discovery is a local bounded parse; resolve/test carry the §3 probe budget. */
const DISCOVER_TIMEOUT_MS = DEFAULT_COMMAND_TIMEOUT_MS;
const RESOLVE_TIMEOUT_MS = SSH_PROBE_DEADLINE_MS;
const TEST_TIMEOUT_MS = SSH_PROBE_DEADLINE_MS;
/** Start/ask/cancel are bounded node-side too: the RUN outlives the RPC, never the RPC outliving its deadline budget. */
const RUN_RPC_TIMEOUT_MS = SSH_PROBE_DEADLINE_MS;
const TERMINAL_LAUNCH_TIMEOUT_MS = SSH_PROBE_DEADLINE_MS;
/** A read may long-poll node-side for the full §3 window; the RPC must outlast the wait, not race it. */
const READ_RPC_SLACK_MS = 10_000;

/** The long-poll ceiling a caller may pass to {@link nodeSshRunRead} (frozen §3 row). */
export const SSH_READ_WAIT_MAX_MS = SSH_READ_LONG_POLL_MAX_MS;

/** Ask `ssh_discover_aliases`; the alias-NAMES view, config contents never cross the link. */
export async function nodeSshDiscover(nodeId: string): Promise<NodeSshAliasListResult> {
  const data = await call(nodeId, { type: "ssh_discover_aliases" }, DISCOVER_TIMEOUT_MS, "ssh_discover_aliases");
  return requireParsed(parseNodeSshAliasList(data), nodeId, "ssh_discover_aliases");
}

/** Ask `ssh_resolve_config` for one alias; a refusal is IN the data, not a transport error. */
export async function nodeSshResolve(nodeId: string, alias: string): Promise<NodeSshResolveOutcomeWire> {
  const data = await call(nodeId, { type: "ssh_resolve_config", alias }, RESOLVE_TIMEOUT_MS, "ssh_resolve_config");
  return requireParsed(parseNodeSshResolveOutcome(data), nodeId, "ssh_resolve_config");
}

/** Ask `ssh_test_connection` for the FIXED benign probe against an approved snapshot. */
export async function nodeSshTest(
  nodeId: string,
  snapshot: SshConnectionSnapshotWire,
): Promise<NodeSshTestOutcomeWire> {
  const data = await call(nodeId, { type: "ssh_test_connection", snapshot }, TEST_TIMEOUT_MS, "ssh_test_connection");
  return requireParsed(parseNodeSshTestOutcome(data), nodeId, "ssh_test_connection");
}

/** Dispatch `ssh_run_start` (server-allocated id + digest already bound by the caller). */
export async function nodeSshRunStart(
  nodeId: string,
  args: {
    runId: string;
    snapshot: SshConnectionSnapshotWire;
    remoteDir: string | null;
    command: string;
    deadlineMs: number;
    requestDigest: string;
  },
): Promise<SshRunFactsWire> {
  const data = await call(nodeId, { type: "ssh_run_start", ...args }, RUN_RPC_TIMEOUT_MS, "ssh_run_start");
  return requireParsed(parseNodeSshRunFacts(data), nodeId, "ssh_run_start");
}

/** Ask one run's current facts. Unknown ids answer the bare `run_unknown` code. */
export async function nodeSshRunStatus(nodeId: string, runId: string): Promise<SshRunFactsWire> {
  const data = await call(nodeId, { type: "ssh_run_status", runId }, RUN_RPC_TIMEOUT_MS, "ssh_run_status");
  return requireParsed(parseNodeSshRunFacts(data), nodeId, "ssh_run_status");
}

/** Relay one bounded output window (facts ride the answer; a timed-out wait answers an empty window). */
export async function nodeSshRunRead(
  nodeId: string,
  args: { runId: string; stdoutFromByte: number; stderrFromByte: number; maxBytes: number; waitMs: number },
): Promise<NodeSshRunReadResult> {
  const data = await call(nodeId, { type: "ssh_run_read", ...args }, args.waitMs + READ_RPC_SLACK_MS, "ssh_run_read");
  return requireParsed(parseNodeSshRunReadResult(data), nodeId, "ssh_run_read");
}

/** Request cancellation; the answer's facts carry `cancelLocalConfirmed` in the same round trip. */
export async function nodeSshRunCancel(nodeId: string, runId: string): Promise<SshRunFactsWire> {
  const data = await call(nodeId, { type: "ssh_run_cancel", runId }, RUN_RPC_TIMEOUT_MS, "ssh_run_cancel");
  return requireParsed(parseNodeSshRunFacts(data), nodeId, "ssh_run_cancel");
}

/**
 * Launch a managed SSH terminal pane (the node owns the argv construction
 * under the mandatory runtime policy; the plane ships only the approved
 * destination - the `launch` inversion posture).
 */
export async function nodeSshTerminalLaunch(
  nodeId: string,
  args: {
    subshellId: string;
    socket: string;
    snapshot: SshConnectionSnapshotWire;
    remoteDir: string | null;
    cols?: number;
    rows?: number;
  },
): Promise<void> {
  await call(nodeId, { type: "ssh_terminal_launch", ...args }, TERMINAL_LAUNCH_TIMEOUT_MS, "ssh_terminal_launch");
}

/**
 * Move a managed pane's input control and RAISE the node's generation
 * (everything queued below it is fenced node-side). Returns the node's
 * CURRENT state after the transition - the answer is what lets the plane
 * detect a lost race against a takeover happening at the machine.
 */
export async function nodeSshInputControl(
  nodeId: string,
  args: { subshellId: string; mode: "agent" | "human"; generation: number },
): Promise<NodeSshControlResult> {
  const data = await call(
    nodeId,
    { type: "ssh_input_control", ...args },
    DEFAULT_COMMAND_TIMEOUT_MS,
    "ssh_input_control",
  );
  return requireParsed(parseNodeSshControlResult(data), nodeId, "ssh_input_control");
}

/** Re-exported so services can build hop lists without reaching past the adapter for the wire type. */
export type { SshHopWire };

/**
 * A node refusal the API surface must name: `code` is set when the agent's
 * `result{error}` equals a frozen {@link SshErrorCode} (the equality rule the
 * node maps live by). `transport` marks offline/timeout; `unsupported` marks
 * an old agent; `malformed` marks a validator-refused answer (a broken node,
 * reported 5xx-honest, never as the caller's fault).
 */
export class SshNodeRefusal extends Error {
  /** The named code when the refusal is one of the frozen set; null for a free-text or transport failure. */
  readonly code: SshErrorCode | null;
  /** True when the node had no live connection or the RPC timed out - the "offline/timeout" family. */
  readonly transport: boolean;
  /** True when the agent answered `unsupported` (the named remedy is updating the node). */
  readonly unsupported: boolean;
  /** True when the agent ANSWERED but the payload failed the shared parser. */
  readonly malformed: boolean;
  constructor(
    message: string,
    code: SshErrorCode | null,
    opts: { transport?: boolean; unsupported?: boolean; malformed?: boolean } = {},
  ) {
    super(message);
    this.name = "SshNodeRefusal";
    this.code = code;
    this.transport = opts.transport ?? false;
    this.unsupported = opts.unsupported ?? false;
    this.malformed = opts.malformed ?? false;
  }
}

/** One signed command with its deadline; node refusals surface as {@link SshNodeRefusal}. */
async function call(
  nodeId: string,
  cmd: Parameters<typeof sendCommand>[1],
  timeoutMs: number,
  verb: string,
): Promise<unknown> {
  try {
    return await sendCommand(nodeId, cmd, { timeoutMs });
  } catch (err) {
    if (err instanceof NodeRpcError) throw classify(err, verb);
    throw err;
  }
}

/** Map a {@link NodeRpcError} by EQUALITY on `detail`, per the house rule. */
function classify(err: NodeRpcError, verb: string): SshNodeRefusal {
  // `isSshErrorCode` is the whole equality table - the frozen set includes the
  // durable-dispatch family (`run_conflict`, `run_unknown`, `stale_command`)
  // and the resource family (`quota_*`, `storage_full`) the spec pins exact
  // matching for; a refusal the grammar cannot name is a sentence, not a code.
  if (err.code === "failed" && err.detail !== undefined && isSshErrorCode(err.detail)) {
    return new SshNodeRefusal(err.message, err.detail, {});
  }
  return new SshNodeRefusal(
    err.code === "unsupported" ? `node ${err.nodeId} predates SSH support; update the node (${verb})` : err.message,
    null,
    {
      transport: err.code === "offline" || err.code === "timeout",
      unsupported: err.code === "unsupported",
    },
  );
}

/** Best-effort variants: a failed cancel relay is a fact to log, never an error to the caller. */
export async function bestEffortRunCancel(nodeId: string, runId: string): Promise<SshRunFactsWire | null> {
  try {
    return await nodeSshRunCancel(nodeId, runId);
  } catch (err) {
    logger
      .withError(err)
      .warn(`ssh cancel dispatch to node ${nodeId} deferred (run ${runId} stays pending; reconnect pass retries)`);
    return null;
  }
}

/** A validator-refused node answer: the node is broken, and say so without dressing it as a caller refusal. */
function requireParsed<T>(parsed: T | null, nodeId: string, verb: string): T {
  if (parsed === null) {
    logger.error(`node ${nodeId} answered ${verb} with a malformed payload`);
    throw new SshNodeRefusal(`node ${nodeId} answered ${verb} with a malformed payload`, null, { malformed: true });
  }
  return parsed;
}
