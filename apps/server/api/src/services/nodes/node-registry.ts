import { NODE_CLOSE_SUPERSEDED, type NodeRuntimeReport } from "@internal/subshell-protocol";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import type { NodeRpcError } from "./node-rpc.js";

/**
 * Live-connection registry for enrolled agent nodes (spec 2026-08-31 §5.3).
 * A module-scope `nodeId → NodeConnection` map — the single source of truth
 * for "is this node reachable right now", shared by the `/ws/node` handler
 * (who attaches/detaches) and `node-rpc.ts` (who sends and correlates).
 *
 * Newest-wins: when a node re-dials while an old socket is still mapped, the
 * OLD socket is closed with {@link NODE_CLOSE_SUPERSEDED} and flagged `closing`
 * before the new one is installed. The flag plus the identity guard in
 * {@link detachConnection} defuse the classic race where the old socket's
 * `close` event fires AFTER the new attach and would otherwise evict the
 * fresh entry.
 *
 * Deliberately absent: the inbound jti replay LRU. That belongs to the WS
 * handler (per-NODE, shared across every connection the node makes — spec §4);
 * outbound commands need no replay state, and `seq` here is a per-CONNECTION
 * counter that restarts at 0 on every attach.
 */

/**
 * Close code sent when the node's credential just stopped working — rotate
 * and delete revoke the key while its socket is still mapped (spec §5.4).
 * 4401 mirrors the REST 401 the same dead key would get on an upgrade.
 */
export const REVOKED_CLOSE_CODE = 4401;

/**
 * Minimal structural socket shim — same discipline as `WsSocket` in
 * `ws/subshell-ws.ts`: only what the registry/RPC actually touches, so tests
 * drive fakes and the Bun ws object satisfies it structurally.
 */
export interface NodeSocket {
  /** Send one text frame (the JSON envelope); returns like Bun's `ws.send`. */
  send(data: string): unknown;
  /** Close the socket with an optional code/reason. */
  close(code?: number, reason?: string): void;
}

/** One in-flight command awaiting its `result` frame. */
export interface PendingEntry {
  /** Settle the owning `sendCommand` promise with the result payload. */
  resolve(data: unknown): void;
  /** Settle it as a failure (clears the timeout first). */
  reject(err: NodeRpcError): void;
  /** Deadline armed when the frame hit the socket; cleared on settle. */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * What the agent told us about itself — per-CONNECTION facts stashed so
 * launch/attach paths can compose paths and compute resume targets without
 * another round trip. The identity fields arrive on every `ready`; the env
 * VALUES are refreshed by the plane's own `detect` round trip (the driver in
 * `inventory.ts` writes them when an answer lands), so a reconnect carries
 * homeDir from the fresh `ready` and no env until the next detect.
 */
export interface NodeAgentFacts {
  /** agent-side `<dataDir>` — composes log/mcp paths (spec §6.4) */
  dataDir: string;
  /** capability strings from ready ("uploads", "mcp") */
  capabilities: string[];
  /** hostname reported by the agent (display/diagnosis) */
  hostname: string;
  /** agent build version from the ready frame */
  agentVersion: string;
  /**
   * The agent's full self-invocation of its `mcp` subcommand, from `ready`.
   * The control plane composes the pane's MCP registration from it verbatim —
   * a bare `process.execPath` was wrong under an interpreter run (`bun mcp`
   * is not a command). Absent = the agent sent none; the registration then
   * falls back to `subshell mcp` on PATH.
   */
  selfInvoke?: { command: string; args: string[] };
  /**
   * The node's home directory, reported at `ready` (spec 2026-09-10 §5) —
   * the fallback root for resume paths the control plane computes. Absent
   * when the node reported none; `canResume` still computes a (relative, so
   * will-not-exist) default rather than skipping the probe.
   */
  homeDir?: string;
  /**
   * How the agent PROCESS runs, reported once per connect in `ready` (spec
   * 2026-09-12 § 6.1): its service manager's view of it, whether exiting
   * would be a restart, and where its config, log and binary live.
   *
   * It lives here rather than in the `nodes` table on purpose — these are
   * facts about a running process, so when the node is offline they are stale
   * by definition and the absence of a connection is the honest answer.
   * Absent on agents that predate the field; the detail view then shows no
   * Runtime card rather than an empty one.
   */
  runtime?: NodeRuntimeReport;
  /**
   * Values for the environment variables the plane's enabled harness
   * manifests declared (`subshell.hostEnv`), and only those — answered by
   * THIS connection's last `detect` round trip (spec §5 as amended by the
   * final review; the node holds no manifests, so it could not have named
   * these at `ready`). Absent = no detect has landed since the connect, which
   * `canResume` reads as "answer {}": the plugin's home-default path is
   * computed and probed anyway. A key absent WITHIN it = that variable is
   * unset on the node, which is what triggers the plugin's fallback.
   */
  env?: Record<string, string>;
}

/** Live state for exactly one node's current connection. */
export interface NodeConnection {
  /** Node id this socket belongs to (no `node:` prefix). */
  nodeId: string;
  /** The live socket. */
  ws: NodeSocket;
  /**
   * Per-CONNECTION monotonic sequence counter; starts at 0, every command
   * pre-increments it. Restarted per attach — it mirrors the agent's fresh
   * `SeqTracker` and is an ordering hint, NOT the replay defense (spec §4).
   */
  seq: number;
  /** In-flight commands awaiting correlation: `jti → settle handles`. */
  pending: Map<string, PendingEntry>;
  /**
   * True once a newer connection has superseded this one: the socket is being
   * closed on purpose, so its own close-handler teardown must not touch the
   * registry or fail the new connection's pendings.
   */
  closing?: boolean;
  /**
   * Per-connection FIFO mutex. `sendCommand` appends its (async) send step so
   * `seq` assignment and `ws.send` stay in call order despite the await on
   * signing in between — see the invariant note in `node-rpc.ts`.
   */
  sendChain: Promise<void>;
  /**
   * Self-reported facts from the agent's `ready` frame (spec §6.4). Absent
   * until `ready` lands — a socket that connects but never readies stays
   * `agent: undefined` and reads as such to every consumer.
   */
  agent?: NodeAgentFacts;
}

const live = new Map<string, NodeConnection>();

/**
 * Install `ws` as the live connection for `nodeId`, newest-wins: an existing
 * connection is flagged `closing` and its socket closed with 4409 first
 * (spec §5.3). A throwing close on the stale socket is swallowed — a dead
 * socket that refuses to die must not block the fresh one.
 * Re-attaching the socket that is ALREADY mapped returns the existing record
 * untouched (no close, no fresh seq, no lost pendings).
 * @param nodeId - node id (no `node:` prefix)
 * @param ws - the freshly authenticated socket
 * @returns the new connection record (seq starts at 0, pendings empty)
 */
export function attachConnection(nodeId: string, ws: NodeSocket): NodeConnection {
  const previous = live.get(nodeId);
  // Same socket re-attached (defensive: duplicate `open` dispatch): keep the
  // existing record — seq, pendings, and identity stay untouched.
  if (previous?.ws === ws) return previous;
  if (previous) {
    previous.closing = true;
    try {
      previous.ws.close(NODE_CLOSE_SUPERSEDED, "replaced by a newer connection for this node");
    } catch {
      // already dead — nothing to close
    }
  }
  const conn: NodeConnection = { nodeId, ws, seq: 0, pending: new Map(), sendChain: Promise.resolve() };
  live.set(nodeId, conn);
  return conn;
}

/**
 * The current connection for `nodeId`, or `undefined` when offline.
 */
export function getLive(nodeId: string): NodeConnection | undefined {
  return live.get(nodeId);
}

/**
 * Whether a subshell's launch node is currently unreachable (spec §5.6): an
 * AGENT node whose id has no entry in the live-connection registry. Local
 * rows answer false by definition (the control-plane host has no agent
 * socket); the check is a Map probe, deliberately NOT a DB query, so it is
 * cheap in a per-row view loop. True means "the pane may still be running
 * there" — the UI shows a stale-banner, not a dead subshell.
 *
 * The BLESSED liveness predicate — every "is this row's node reachable"
 * decision must go through it. It lives here because it is pure over the
 * registry above, which makes it importable by services and repositories'
 * callers without cycles (`notify.service` → registry is clean while
 * subshell-manager → notify already exists; the summarizer takes it as an
 * injected predicate rather than importing this module).
 */
export function isNodeOffline(nodeId: string): boolean {
  return nodeId !== LOCAL_NODE_ID && getLive(nodeId) === undefined;
}

/**
 * Remove `nodeId`'s entry ONLY when `ws` is still its current socket — the
 * identity guard is what keeps a superseded socket's late `close` event from
 * evicting the replacement.
 * @returns true when the entry was actually removed
 */
export function detachConnection(nodeId: string, ws: NodeSocket): boolean {
  const current = live.get(nodeId);
  if (!current || current.ws !== ws) return false;
  live.delete(nodeId);
  return true;
}

/** Ids of every node with a live connection (any order). */
export function listOnline(): string[] {
  return [...live.keys()];
}

/**
 * Forcibly evict + close `nodeId`'s live connection — the registry side of
 * credential revocation (rotate-key / delete-node call this AFTER their DB
 * changes, so the socket can never serve on a key that just died, T8 carry).
 * Flags the record `closing` and detaches with the same identity guard the
 * WS close handler uses; a throwing `close()` (already-dead socket) is
 * swallowed — eviction is the point, the close is courtesy. In-flight
 * commands are NOT failed here: the registry stays dependency-free (it must
 * never import `node-rpc`, which imports THIS module). CALLERS therefore own
 * the drain (P1-T9 carry — "any eviction without real socket close must
 * failConnPendings itself"): capture the record with {@link getLive} BEFORE
 * disconnecting and call `failConnPendings(conn, ...)` AFTER (see the
 * rotate/delete routes). On a real socket the close event drains them too —
 * the second drain is a no-op.
 * @param nodeId - node id (no `node:` prefix)
 * @param code - close code (default {@link REVOKED_CLOSE_CODE})
 * @param reason - close reason sent on the wire
 * @returns true when a live connection existed and was evicted
 */
export function disconnectNode(
  nodeId: string,
  code: number = REVOKED_CLOSE_CODE,
  reason = "node access revoked",
): boolean {
  const conn = live.get(nodeId);
  if (!conn) return false;
  conn.closing = true;
  try {
    conn.ws.close(code, reason);
  } catch {
    // already dead — nothing to close; the eviction below still matters
  }
  return detachConnection(nodeId, conn.ws);
}

/**
 * Close every live node socket with one code — the self-restart's node half.
 *
 * Each agent's own backoff loop reconnects, so this is a courtesy close rather
 * than a revocation: 1012 Service Restart tells the agent why its socket went
 * away instead of leaving it to discover a dropped connection. In-flight
 * commands drain through each socket's close event, as with
 * {@link disconnectNode} on a live socket.
 *
 * @returns how many connections were closed
 */
export function disconnectAllNodes(code: number, reason: string): number {
  let closed = 0;
  for (const id of listOnline()) if (disconnectNode(id, code, reason)) closed++;
  return closed;
}

/**
 * Empties the registry. Test seam only — production callers must not call
 * this; @internal.
 */
export function resetNodeRegistryForTests(): void {
  live.clear();
}
