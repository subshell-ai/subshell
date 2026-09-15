import { type NodeCommandBody, type NodeEvent, signCommand } from "@internal/subshell-protocol";
import { loadControlKeys } from "./control-keys.js";
import { getHeld, getLive, type NodeConnection } from "./node-registry.js";

/**
 * Signed command RPC over the node registry (spec 2026-08-31 §4). This is the
 * only way to talk to a live agent: build a `NodeCommandBody`, sign it into a
 * JWS envelope with the control key, push it through the node's socket, and
 * await the agent's `{type:"result", ref}` frame — correlated by the `jti` we
 * assigned. The WS handler owns the two feed points: `resolveResult` (a
 * parsed result frame arrived) and `failConnPendings` (the socket closed —
 * and the eviction callers of `disconnectNode`, P1-T9 carry).
 *
 * Seq/send-order invariant: `seq` is a per-connection monotonic ordering hint
 * the agent validates, so it must increase in WIRE order. Signing is async
 * (`signCommand` awaits WebCrypto), which means two back-to-back `sendCommand`
 * calls could otherwise interleave `seq++` and `ws.send` and emit
 * `seq 2 before seq 1`. Fix: a per-connection promise-chain mutex
 * (`conn.sendChain`) — each command's step (seq++, sign, register pending,
 * send) is appended in call order and runs alone, so sequence assignment and
 * frame emission can never disagree.
 */

/** Machine-readable failure kinds for {@link NodeRpcError}. */
export type NodeRpcErrorCode = "offline" | "unsupported" | "failed" | "timeout";

/**
 * Rejection for any command that did not resolve. Carries the node it was
 * aimed at so routes can map it to a structured API error.
 */
export class NodeRpcError extends Error {
  /** Why the command failed (see {@link NodeRpcErrorCode}). */
  readonly code: NodeRpcErrorCode;
  /** Node the command was addressed to. */
  readonly nodeId: string;
  /**
   * The agent's `result.error` string VERBATIM, on a `failed` rejection only.
   *
   * `message` wraps it in a sentence (`node "x" reported: …`), which is right
   * for a log line and wrong for a decision: a route mapping a refusal to an
   * API code would have to substring-match a sentence it does not own, and a
   * later rewording of that sentence would silently change the mapping. The
   * agent's refusals are exact wire constants (`NODE_RESULT_*`), so routes
   * compare against this field by equality and fall back to a generic code
   * for anything they do not recognize.
   */
  readonly detail: string | undefined;

  constructor(code: NodeRpcErrorCode, message: string, nodeId: string, detail?: string) {
    super(message);
    this.name = "NodeRpcError";
    this.code = code;
    this.nodeId = nodeId;
    this.detail = detail;
  }
}

/** A `result` frame — what the WS handler feeds into {@link resolveResult}. */
export type NodeResultEvent = Extract<NodeEvent, { type: "result" }>;

/** Default per-command deadline (spec §4: commands are socket-open-only). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Deadline for `update` (spec 2026-09-15 §5.2).
 *
 * The FIRST per-command override, and it is one rather than a raised default
 * on purpose: every other command is a tmux call or a stat and 10 s is
 * generous for those, while this one downloads ~70 MB over whatever link a
 * node has. Raising the default would give a hung `launch` five minutes to
 * look alive.
 */
export const UPDATE_COMMAND_TIMEOUT_MS = 300_000;

/** Per-call overrides for {@link sendCommand}. */
export interface SendCommandOptions {
  /** Deadline measured from the frame hitting the socket (default {@link DEFAULT_COMMAND_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * Sign `cmd` for `nodeId`, push it through the node's live socket, and await
 * the correlated result.
 *
 * Resolution/rejection paths:
 * - agent answers `ok:true` → resolves with `event.data` (possibly `undefined`)
 * - agent answers `error:"unsupported"` → rejects `NodeRpcError("unsupported")`
 * - any other `ok:false` → rejects `NodeRpcError("failed")` carrying the message
 * - no answer within `timeoutMs` → rejects `NodeRpcError("timeout")`
 * - node not connected now, or gone by the time the queued step runs →
 *   rejects `NodeRpcError("offline")`
 *
 * **A HELD socket is used when there is no live one, and ONLY for `update`**
 * (spec 2026-09-15 §5.3). A held agent speaks a protocol this plane does not,
 * so it is offline for every purpose but `update`, and the narrowing lives
 * HERE rather than in the routes.
 *
 * It was left to the routes first, on the reasoning that "what may be sent to
 * a held node" is policy and this is transport. That was wrong as written:
 * `getLive` used to BE the gate, so every existing caller — the service,
 * logging, server-url, file-browse, upload, maintenance and allowed-dirs paths
 * — passes a command with no liveness check of its own, and the fallback
 * silently promoted all of them. A `service uninstall` posted against a node
 * the UI shows as offline would have been parsed by an agent whose wire
 * contract this plane explicitly refuses to speak, and `service` is not one of
 * the shapes frozen across protocol bumps — only `update` is
 * (`node-frames.ts`). A route may still refuse a held node for its own
 * reasons; it can no longer widen this by omission.
 *
 * A LIVE connection always wins, so the fallback can never steal a command
 * from a node that came back.
 *
 * @param nodeId - target node (must have a live or held connection)
 * @param cmd - command payload (validated wire shape)
 * @param options - per-call overrides; `timeoutMs` for commands like `update`
 *   that are not a tmux round trip
 * @returns the result frame's `data`
 */
export function sendCommand(nodeId: string, cmd: NodeCommandBody, options: SendCommandOptions = {}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const conn = getLive(nodeId) ?? (cmd.type === "update" ? getHeld(nodeId)?.conn : undefined);
  if (!conn) {
    return Promise.reject(new NodeRpcError("offline", `node "${nodeId}" has no live connection`, nodeId));
  }

  let onResolve: (data: unknown) => void;
  let onReject: (err: NodeRpcError) => void;
  const result = new Promise<unknown>((resolve, reject) => {
    onResolve = resolve;
    onReject = reject;
  });

  const jti = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Single settle-as-failure path: disarm, deregister, reject. */
  const fail = (err: NodeRpcError): void => {
    if (timer) clearTimeout(timer);
    conn.pending.delete(jti);
    onReject(err);
  };

  const step = async (): Promise<void> => {
    // Re-check inside the chain: while we queued, the socket may have been
    // detached or superseded by a newer connection for the same node. A held
    // record counts as still ours — a socket that MOVED from live to held (or
    // was held all along) has not gone anywhere, and refusing there would
    // fail the one command a held node exists to receive.
    if (conn.closing || (getLive(nodeId) !== conn && getHeld(nodeId)?.conn !== conn)) {
      throw new NodeRpcError("offline", `node "${nodeId}" disconnected before the command was sent`, nodeId);
    }
    const { privateJwk } = await loadControlKeys();
    const seq = ++conn.seq;
    const jws = await signCommand(privateJwk, { nodeId, jti, seq, cmd });

    // From here the command is in flight: arm the deadline and register the
    // correlation entry BEFORE the frame can be answered, then emit. `send`
    // stays the step's last statement so a thrown socket error never leaves
    // a phantom pending behind (the catch below removes it).
    timer = setTimeout(() => {
      if (conn.pending.delete(jti)) {
        onReject(
          new NodeRpcError(
            "timeout",
            `command "${cmd.type}" to node "${nodeId}" timed out after ${timeoutMs}ms`,
            nodeId,
          ),
        );
      }
    }, timeoutMs);
    timer.unref?.(); // a pending RPC must not hold the process open
    conn.pending.set(jti, {
      resolve: (data) => {
        if (timer) clearTimeout(timer);
        onResolve(data);
      },
      reject: fail,
      timer,
    });
    conn.ws.send(JSON.stringify({ jws }));
  };

  // Serialize per connection (the seq/send-order invariant, see header). Each
  // link's `.catch` settles THIS command on failure and returns fulfilled, so
  // one broken send never poisons the chain for the commands behind it.
  conn.sendChain = conn.sendChain.then(step, step).catch((err: unknown) => {
    fail(
      err instanceof NodeRpcError
        ? err
        : new NodeRpcError(
            "failed",
            `command "${cmd.type}" to node "${nodeId}" failed to send: ${String(err)}`,
            nodeId,
          ),
    );
  });

  return result;
}

/**
 * Feed a parsed `result` frame from the agent into the pending RPC it
 * belongs to. **Connection-scoped by design**: only `conn`'s own pending map
 * is consulted — the connection the frame arrived on. A node can settle only
 * commands it owns; even a leaked jti from another node's pending map cannot
 * be resolved over this socket (containment is structural, not a bet on jti
 * entropy). Unknown refs on THIS connection are late/foreign and ignored.
 * Legitimate results always arrive on the socket the command left on, so
 * this costs nothing in the honest-agent path.
 * @param conn - the connection the `result` frame arrived on
 * @param event - the `result` event (from `parseNodeEvent`)
 * @returns true when a pending command was settled, false when nothing matched
 */
export function resolveResult(conn: NodeConnection, event: NodeResultEvent): boolean {
  const pending = conn.pending.get(event.ref);
  if (!pending) return false;
  conn.pending.delete(event.ref);
  clearTimeout(pending.timer);
  if (event.ok) {
    pending.resolve(event.data);
  } else if (event.error === "unsupported") {
    pending.reject(new NodeRpcError("unsupported", `node "${conn.nodeId}" does not support this command`, conn.nodeId));
  } else {
    pending.reject(
      new NodeRpcError("failed", `node "${conn.nodeId}" reported: ${event.error}`, conn.nodeId, event.error),
    );
  }
  return true;
}

/**
 * Fail every in-flight command on ONE connection record — the WS close
 * handler's tool, because a superseded socket's close must fail THAT
 * connection's pendings even when the registry already maps the node's NEWER
 * socket (per-connection identity, not per-node lookup).
 * @param conn - the connection whose pending map should be drained
 * @param code - rejection code (default `offline`)
 * @param message - optional override for the error message
 * @returns how many commands were failed
 */
export function failConnPendings(conn: NodeConnection, code: NodeRpcErrorCode = "offline", message?: string): number {
  const entries = [...conn.pending.values()];
  conn.pending.clear();
  const fallback = `node "${conn.nodeId}" connection closed with ${entries.length} in-flight command(s)`;
  for (const pending of entries) {
    clearTimeout(pending.timer);
    pending.reject(new NodeRpcError(code, message ?? fallback, conn.nodeId));
  }
  return entries.length;
}
