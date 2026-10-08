import {
  type NodeSshAgentIdentitiesResult,
  type NodeSshAliasListResult,
  type NodeSshHostKeyResult,
  type NodeSshResolveOutcomeWire,
  parseNodeSshAgentIdentities,
  parseNodeSshAliasList,
  parseNodeSshHostKey,
  parseNodeSshIdentity,
  parseNodeSshResolveOutcome,
} from "@internal/subshell-protocol";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

/**
 * The ssh commands as plane-side RPC wrappers (spec 2026-10-07 §5 for the
 * discovery/resolve pair; spec 2026-10-08 §4.3 for the identity bootstrap and
 * the §5.4 agent roster the approval screen enumerates). Each is `sendCommand`
 * plus ITS frozen result parser:
 * the value these return is a validated plain object (or the function throws),
 * so no caller can branch on a machine answer it has not parsed.
 *
 * **The outcome's `accepted:false` arm is NOT an error.** "This config needs a
 * ProxyCommand" is a successful resolution the human must read (§2's refusal
 * doctrine), and it travels IN THE DATA; these wrappers return the whole
 * outcome and refuse only what the transport or the wire grammar refused.
 *
 * Every failure leaves as one {@link SshRpcError} whose `kind` says which
 * door closed, so the service maps statuses without re-deriving them from
 * error sentences:
 * - `offline` — no live socket (or it dropped before the frame was sent);
 * - `unsupported` — the connected agent does not know the command (an old
 *   app; the remedy is the node update);
 * - `timeout` — the machine did not answer inside the RPC deadline;
 * - `refused` — the agent answered `ok:false` (its own mirror gate, a missing
 *   ssh binary, …); `detail` carries the agent's verbatim string for the LOG,
 *   never for a response body;
 * - `malformed` — `ok:true` with a payload the frozen validator rejects (a
 *   protocol violation; treated as a refusal, loudly).
 */

/** Which door closed on a machine-level ssh RPC failure. */
export type SshRpcFailure = "offline" | "unsupported" | "timeout" | "refused" | "malformed";

export class SshRpcError extends Error {
  readonly kind: SshRpcFailure;
  readonly nodeId: string;
  /** The agent's `error` string verbatim on a `refused` failure (log/diagnosis only). */
  readonly detail: string | undefined;

  constructor(kind: SshRpcFailure, message: string, nodeId: string, detail?: string) {
    super(message);
    this.name = "SshRpcError";
    this.kind = kind;
    this.nodeId = nodeId;
    this.detail = detail;
  }
}

/** Map the RPC layer's failure onto the ssh surface's failure kind. */
function mapRpcError(nodeId: string, err: NodeRpcError): SshRpcError {
  const kind: SshRpcFailure =
    err.code === "offline"
      ? "offline"
      : err.code === "unsupported"
        ? "unsupported"
        : err.code === "timeout"
          ? "timeout"
          : "refused";
  return new SshRpcError(kind, err.message, nodeId, err.detail);
}

/** Ask one machine for the NAMES of its usable SSH aliases (never config contents). */
export async function sshDiscover(nodeId: string): Promise<NodeSshAliasListResult> {
  let data: unknown;
  try {
    data = await sendCommand(nodeId, { type: "ssh_discover_aliases" });
  } catch (err) {
    if (err instanceof NodeRpcError) throw mapRpcError(nodeId, err);
    throw err;
  }
  const parsed = parseNodeSshAliasList(data);
  if (!parsed) {
    throw new SshRpcError("malformed", `node "${nodeId}" answered a malformed alias list`, nodeId);
  }
  return parsed;
}

/**
 * Ask one machine to resolve one destination token into the approved
 * snapshot (or its named refusal, which is a SUCCESSFUL answer).
 */
export async function sshResolve(nodeId: string, alias: string): Promise<NodeSshResolveOutcomeWire> {
  let data: unknown;
  try {
    data = await sendCommand(nodeId, { type: "ssh_resolve_config", alias });
  } catch (err) {
    if (err instanceof NodeRpcError) throw mapRpcError(nodeId, err);
    throw err;
  }
  const parsed = parseNodeSshResolveOutcome(data);
  if (!parsed) {
    throw new SshRpcError("malformed", `node "${nodeId}" answered a malformed resolve outcome`, nodeId);
  }
  return parsed;
}

/**
 * Ask one machine to report its OWN relay signing public key (spec
 * 2026-10-08 §4.3). The command carries no input: the machine answers about
 * itself, and the plane-side guard (deliverSigningKey) owns what a report
 * may do - this wrapper only moves validated bytes across the link.
 * @returns the answer's `signingPublicKey` string (importability is checked
 *   by the STORE, not here; this layer's job is the wire grammar)
 * @throws {SshRpcError} on any transport/wire failure, per the kinds above
 */
export async function sshRegisterIdentity(nodeId: string): Promise<string> {
  let data: unknown;
  try {
    data = await sendCommand(nodeId, { type: "ssh_register_identity" });
  } catch (err) {
    if (err instanceof NodeRpcError) throw mapRpcError(nodeId, err);
    throw err;
  }
  const parsed = parseNodeSshIdentity(data);
  if (!parsed) {
    throw new SshRpcError("malformed", `node "${nodeId}" answered a malformed signing identity`, nodeId);
  }
  return parsed.signingPublicKey;
}

/**
 * Ask one machine for the `known_hosts` entries it has recorded for one
 * resolved destination (spec 2026-10-08 §9, Task 12): the host-key capture
 * whose answer becomes the pin the relay-open delivers to B. The destination
 * is the whole input because OpenSSH's host-key lookup is per destination;
 * the triple is sent RESOLVED so a later config edit cannot retarget the ask.
 * An empty answer is a SUCCESS (`{ lines: [] }`, the honest "recorded
 * nothing"); only a transport/wire failure throws.
 * @throws {SshRpcError} on any transport/wire failure, per the kinds above
 */
export async function sshHostKey(
  nodeId: string,
  destination: { host: string; port: number; user: string | null },
): Promise<NodeSshHostKeyResult> {
  let data: unknown;
  try {
    data = await sendCommand(nodeId, { type: "ssh_host_key", ...destination });
  } catch (err) {
    if (err instanceof NodeRpcError) throw mapRpcError(nodeId, err);
    throw err;
  }
  const parsed = parseNodeSshHostKey(data);
  if (!parsed) {
    throw new SshRpcError("malformed", `node "${nodeId}" answered a malformed host-key list`, nodeId);
  }
  return parsed;
}

/**
 * Ask one machine for its LIVE agent's public roster (spec 2026-10-08 §5.4,
 * Task 11): the approval screen's choice list, as the frozen validator
 * narrows it - fingerprints plus comments, the blobs already withheld on the
 * machine (the grammar cannot carry them). The command asks the WHOLE
 * roster, so this wrapper has no input beyond the target: a selection sent
 * from the plane would be a decision about A's keys made where A's agent is
 * the only witness.
 * @throws {SshRpcError} on any transport/wire failure, per the kinds above
 */
export async function sshAgentIdentities(nodeId: string): Promise<NodeSshAgentIdentitiesResult> {
  let data: unknown;
  try {
    data = await sendCommand(nodeId, { type: "ssh_agent_identities" });
  } catch (err) {
    if (err instanceof NodeRpcError) throw mapRpcError(nodeId, err);
    throw err;
  }
  const parsed = parseNodeSshAgentIdentities(data);
  if (!parsed) {
    throw new SshRpcError("malformed", `node "${nodeId}" answered a malformed agent roster`, nodeId);
  }
  return parsed;
}
