import {
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_MIN_VERSION,
  NODE_PROTOCOL_VERSION,
  type NodeEvent,
  parseNodeEvent,
} from "@internal/subshell-protocol";
import { HttpError } from "@/api/auth-guard.js";
import { getAuth } from "@/auth.js";
import type { NodeReadyReport, NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { NodeStatus } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { logger } from "@/utils/logger.js";
import { dispatchOutput, getNodeLifecycleHooks } from "./node-events.js";
import { attachConnection, detachConnection, getLive, type NodeConnection, type NodeSocket } from "./node-registry.js";
import { failConnPendings, resolveResult, sendCommand } from "./node-rpc.js";

/**
 * `/ws/node` — the agent dial-in socket (spec 2026-08-31 §5.3).
 *
 * Direction of trust: the bearer node key authenticates the socket at
 * UPGRADE time (pre-socket HTTP 401/403 — verified achievable on Elysia
 * 1.4.29 by THROWING from the `upgrade()` hook; return values are ignored).
 * Inbound frames are unsigned `NodeEvent`s (spec §3.3 — events inherit the
 * socket's authentication), so there is no jti/seq verification here; that
 * machinery lives on the AGENT side for the signed commands we send via
 * `node-rpc.sendCommand`.
 *
 * Lifecycle: `open` only attaches to the registry — the DB row flips
 * `online` when a `ready` frame lands (`applyReady`), never at socket-open.
 * A newest-wins replace closes the old socket with 4409; the old socket's
 * late `close` must not evict the new mapping or mark the node offline,
 * which is what the per-connection identity checks below enforce.
 *
 * The handler is a plain function set over an injected {@link NodeWsDeps}
 * (same separation `subshell-ws.ts` keeps from `ws.plugin.ts`), so tests
 * drive it with a scripted fake socket and fake deps — no HTTP layer.
 */

/** Close: authenticated-looking socket without an upgrade-stashed identity. Handler-local: only the backend emits it. */
export const NODE_CLOSE_UNAUTHENTICATED = 4401;
/** Close: frame exceeded {@link NODE_MAX_FRAME_BYTES} (standard message-too-big). Handler-local: only the backend emits it. */
export const NODE_CLOSE_TOO_BIG = 1009;

/** Identity the upgrade hook derives from the bearer key and stashes on `ws.data`. */
export interface NodeWsIdentity {
  /** Node id the key's metadata points at */
  nodeId: string;
  /** better-auth api-key row id (anti-forgery link against `nodes.apiKeyId`) */
  apiKeyId: string;
}

/** Per-socket data: the upgrade-stashed identity plus the registry record. */
export interface NodeWsData {
  nodeId?: string;
  apiKeyId?: string;
  /** Registry connection created at `open`; close teardown fails THIS record. */
  nodeConn?: NodeConnection;
  /**
   * Tail of this socket's serialized frame queue ({@link handleNodeMessageQueued}).
   * Lives HERE because Elysia builds a fresh wrapper per event but shares this
   * data object across all of them — the only per-connection scratch we get.
   */
  frameQueue?: Promise<void>;
}

/** The socket surface the handler uses (ElysiaWS satisfies it structurally). */
export interface NodeWsSocket extends NodeSocket {
  data: NodeWsData;
  /**
   * The underlying Bun socket. Elysia builds a FRESH `ElysiaWS` wrapper for
   * every event (open/message/close), so wrapper identity is NOT stable —
   * this raw handle is the per-connection identity the registry keys on, and
   * `ws.data` (shared by every wrapper) is where identity/nodeConn live.
   */
  readonly raw?: NodeSocket;
}

/**
 * The stable per-connection socket for registry attach/identity checks:
 * the raw Bun socket behind Elysia's per-event wrapper (tests pass fakes
 * without `raw`, where the wrapper itself is stable).
 */
function connectionSocket(ws: NodeWsSocket): NodeSocket {
  return ws.raw ?? ws;
}

/** Verifiable api-key row subset (mirrors `VerifiedKeyRow` in auth-guard). */
export interface NodeVerifiedKey {
  /** api-key row id */
  id: string;
  /** Stored metadata; node keys carry `{ kind: "node", nodeId }` */
  metadata: Record<string, unknown> | null;
}

/** Repository slice the socket touches (full `NodesRepository` satisfies it). */
export type NodeWsNodesRepo = Pick<
  NodesRepository,
  "findById" | "applyReady" | "applyInventory" | "touch" | "setStatus"
>;

/** Everything the handler reaches outside its own module. */
export interface NodeWsDeps {
  /** Verify a bearer key; resolves to the row when valid+enabled, `null` otherwise. */
  verifyApiKey(rawKey: string): Promise<NodeVerifiedKey | null>;
  /** Node row writes (prod: the requestless context's `repos.nodes`). */
  nodes: NodeWsNodesRepo;
  /**
   * Feed a `result` frame to the RPC correlator (prod: `node-rpc.resolveResult`).
   * Connection-scoped: only `conn`'s own pendings may settle — pass the
   * socket's own record, never another node's.
   */
  resolveResult(conn: NodeConnection, event: Extract<NodeEvent, { type: "result" }>): boolean;
  /** Best-effort inventory refresh after a protocol-compatible `ready` (spec §5.3). */
  requestInventory(nodeId: string): void;
}

let prodDeps: NodeWsDeps | undefined;

/**
 * The production deps, assembled lazily: better-auth's key verifier, the
 * requestless repository graph, and the real RPC plumbing. Test seams are the
 * function parameters themselves — pass your own {@link NodeWsDeps}.
 * @internal
 */
export function getNodeWsDeps(): NodeWsDeps {
  if (!prodDeps) {
    prodDeps = {
      verifyApiKey: async (rawKey) => {
        try {
          const res = (await getAuth().api.verifyApiKey({ body: { key: rawKey } })) as unknown as {
            valid: boolean;
            key?: NodeVerifiedKey;
          };
          // Disabled/expired keys read as valid:false (or throw) — both refuse,
          // exactly like the REST guard (spec §5.3: rotation revokes at upgrade).
          return res.valid && res.key ? { id: res.key.id, metadata: res.key.metadata ?? null } : null;
        } catch {
          return null;
        }
      },
      nodes: getRequestlessContext().repos.nodes,
      resolveResult: (conn, event) => resolveResult(conn, event),
      requestInventory: (nodeId) => {
        void sendCommand(nodeId, { type: "inventory" }).catch((err: unknown) => {
          logger.withError(err).debug(`node ws: post-ready inventory request failed for ${nodeId}`);
        });
      },
    };
  }
  return prodDeps;
}

/** Extract the bearer token from an `Authorization` header (`null` when absent). */
function bearerOf(headerValue: string | null): string | null {
  return headerValue?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

/**
 * The full upgrade-time verification chain (spec §5.3): bearer key → valid →
 * kind==="node" → node row exists → row is not the local node →
 * `nodes.apiKeyId === row.id`. Throws the status-carrying errors the global
 * error handler maps to a pre-socket HTTP refusal — 401 for a key that is not
 * a live node credential, 403 for a key↔node link mismatch (rotated/stale
 * key) or a dial-in aimed at the local node (it never runs an agent). The
 * node-row read happens HERE (not at `open`) so the socket is never opened
 * for a mismatched key.
 * @param deps - injected dependencies
 * @param authzHeader - the raw `Authorization` header value (or null)
 * @returns the identity to stash on the socket
 * @throws HttpError 401/403 — thrown from `upgrade()` to refuse the handshake
 */
export async function authenticateNodeUpgrade(
  deps: Pick<NodeWsDeps, "verifyApiKey" | "nodes">,
  authzHeader: string | null,
): Promise<NodeWsIdentity> {
  const rawKey = bearerOf(authzHeader);
  if (!rawKey) throw new HttpError(401, "Missing bearer node key");

  const row = await deps.verifyApiKey(rawKey);
  if (!row) throw new HttpError(401, "Invalid, disabled, or expired node key");

  const meta = row.metadata;
  if (meta?.kind !== "node" || typeof meta.nodeId !== "string" || !meta.nodeId) {
    // A subshell/system key is a valid credential elsewhere, but not here:
    // only node-kind keys open /ws/node (spec §5.5 is its mirror on REST).
    throw new HttpError(401, "Not a node key");
  }

  const node = await deps.nodes.findById(meta.nodeId);
  if (!node) throw new HttpError(401, "Node no longer exists");
  // Local never runs an agent; a rotated local key (admin-only surface) must
  // not open a socket impersonating the control-plane host and overwrite its
  // machine facts via ready/inventory.
  if (node.kind === "local") throw new HttpError(403, "The local node cannot connect over /ws/node");
  // Anti-forgery: the key must be the one THIS node row binds (rotation
  // flips `apiKeyId`; delete disables the key — either breaks the link).
  if (node.apiKeyId !== row.id) throw new HttpError(403, "Key is not bound to this node");

  return { nodeId: meta.nodeId, apiKeyId: row.id };
}

/**
 * Socket-open step: attach to the registry (newest-wins, spec §5.3) and
 * remember the connection on the socket for close teardown. Deliberately
 * does NOT touch the DB — `status='online'` arrives with `ready` via
 * {@link handleNodeMessage}, so a connected-but-silent agent reads offline.
 * @param ws - the authenticated socket (identity stashed by the upgrade hook)
 */
export function handleNodeOpen(ws: NodeWsSocket): void {
  const nodeId = ws.data.nodeId;
  if (!nodeId) {
    // Unreachable behind a correctly-wired upgrade hook; refuse loudly
    // rather than attach an anonymous socket.
    ws.close(NODE_CLOSE_UNAUTHENTICATED, "no verified identity on this socket");
    return;
  }
  ws.data.nodeConn = attachConnection(nodeId, connectionSocket(ws));
  logger.debug(`node ws: ${nodeId} connected`);
}

/** Byte size of an inbound frame, whichever form Elysia hands us. */
function frameBytes(raw: string | object): number {
  return typeof raw === "string" ? Buffer.byteLength(raw) : Buffer.byteLength(JSON.stringify(raw));
}

/**
 * Inbound event dispatch (agent → control, unsigned — the socket IS the
 * auth). Byte-capped per spec §3.1 (Bun's maxPayloadLength is global, so the
 * node cap is enforced in-handler); unrecognized frames are dropped, never
 * fatal. Phase-2 events land on their consumers: `output` on the
 * {@link dispatchOutput} bus, `exit`/`subshells_report` on the lifecycle-hook
 * slot (`node-events.ts`), `ready` additionally stashes the agent's facts on
 * the connection (spec §3.3/§6.4).
 *
 * NOT serialized on its own — production dispatch goes through
 * {@link handleNodeMessageQueued}; direct callers (unit tests) drive one
 * frame at a time.
 * @param deps - injected dependencies
 * @param ws - the socket that produced the frame
 * @param raw - frame as Elysia delivered it (JSON text or pre-parsed object)
 */
export async function handleNodeMessage(deps: NodeWsDeps, ws: NodeWsSocket, raw: string | object): Promise<void> {
  const nodeId = ws.data.nodeId;
  if (!nodeId) return; // never authenticated — ignore, the close will clean up

  if (frameBytes(raw) > NODE_MAX_FRAME_BYTES) {
    ws.close(NODE_CLOSE_TOO_BIG, `frame exceeds ${NODE_MAX_FRAME_BYTES} bytes`);
    return;
  }

  const event = parseNodeEvent(raw);
  if (!event) {
    logger.debug(`node ws: dropped unrecognized frame from ${nodeId}`);
    return;
  }

  switch (event.type) {
    case "ready": {
      const report: NodeReadyReport = {
        agentVersion: event.agentVersion,
        protocolVersion: event.protocolVersion,
        os: event.os,
        arch: event.arch,
        hostname: event.hostname,
        capabilities: event.capabilities,
      };
      // Record FIRST (spec §5.3/§8): even an incompatible agent gets its
      // identity persisted so the Nodes page can show "agent too old".
      await deps.nodes.applyReady(nodeId, report);
      // Same "record FIRST" spirit for the live connection: the agent-facts
      // stash goes before the protocol floor, so an incompatible agent's
      // facts are still on `conn.agent` for diagnosis (spec §6.4).
      const conn = ws.data.nodeConn ?? getLive(nodeId);
      if (conn) {
        conn.agent = {
          dataDir: event.dataDir,
          capabilities: event.capabilities,
          hostname: event.hostname,
          agentVersion: event.agentVersion,
          // Stashed here as well as on the row: per-feature gates are decided
          // on hot paths (every pane resize asks whether this node can answer) and
          // must not need a DB read.
          protocolVersion: event.protocolVersion,
          ...(event.executablePath ? { executablePath: event.executablePath } : {}),
        };
      }
      // Compat WINDOW, not equality: [NODE_PROTOCOL_MIN_VERSION,
      // NODE_PROTOCOL_VERSION]. v3 (fs_ls) is additive, so a v2 agent stays
      // fully connected and loses only folder browsing (feature-gated
      // server-side). Below the floor = a pre-rename agent whose frame keys
      // broke; above the ceiling = speaks frames we cannot verify. Both get
      // UPDATE_REQUIRED (4406) — identity already persisted above so the
      // Nodes page can name the problem.
      if (event.protocolVersion < NODE_PROTOCOL_MIN_VERSION || event.protocolVersion > NODE_PROTOCOL_VERSION) {
        ws.close(NODE_CLOSE_UPDATE_REQUIRED, "agent update required");
        return;
      }
      // Spec §5.3: `ready` triggers an immediate inventory refresh.
      deps.requestInventory(nodeId);
      return;
    }
    case "heartbeat":
      await deps.nodes.touch(nodeId);
      return;
    case "inventory":
      await deps.nodes.applyInventory(nodeId, JSON.stringify(event.harnesses));
      return;
    case "output":
      // Tail subscribers (spec §3.3): unknown subId = nobody is watching that
      // subshell anymore (detach raced a flush) — drop, never fatal.
      if (!dispatchOutput(event)) {
        logger.debug(`node ws: output for unknown subId ${event.subId} dropped`);
      }
      return;
    case "exit": {
      const hooks = getNodeLifecycleHooks();
      // nodeId is the SOCKET identity — a frame-supplied nodeId is ignored.
      if (hooks) await hooks.onExit(nodeId, event.subshellId, event.exitCode, event.at);
      else logger.warn(`node ws: exit for ${event.subshellId} with no lifecycle hook`);
      return;
    }
    case "subshells_report": {
      const hooks = getNodeLifecycleHooks();
      if (hooks) await hooks.onSubshellsReport(nodeId, event.subshells);
      // Census frames arrive on every connect even before Task 10 installs the
      // reconcile hooks — a routine no-op, so debug-drop (the `output` unknown-
      // subId rule), not warn: a reconnecting fleet must not spam the log.
      else logger.debug(`node ws: subshells_report (${event.subshells.length}) with no lifecycle hook`);
      return;
    }
    case "result": {
      // Connection-scoped settle: the frame can only resolve pendings on the
      // socket it arrived on (same record the close path drains). Fall back to
      // the registry mapping only if `open` never stashed one.
      const conn = ws.data.nodeConn ?? getLive(nodeId);
      if (!conn || !deps.resolveResult(conn, event)) {
        logger.debug(`node ws: result frame from ${nodeId} for unknown ref ${event.ref}`);
      }
      return;
    }
    case "error":
      logger.withMetadata({ nodeId, code: event.code }).warn(`node agent reported error: ${event.message}`);
      return;
  }
}

/**
 * Serialized per-socket entry point for inbound frames (P1-T10 carry:
 * fire-and-forget dispatch deserialized event-vs-result ordering — an agent
 * sends its `inventory` EVENT *before* the command's `result`, and with
 * concurrent dispatch the result could settle the RPC before the event's
 * write ran, so `POST /recheck` could answer `{ok:true}` on a stale row).
 *
 * The chain lives on `ws.data.frameQueue`: Elysia builds a fresh wrapper per
 * event but shares the one `data` object across all of them, which is exactly
 * the per-socket state a queue needs. A rejecting frame is logged by the
 * caller via the returned promise and never poisons the chain behind it.
 * @param deps - injected dependencies (same record as the raw handler)
 * @param ws - the socket that produced the frame
 * @param raw - frame as Elysia delivered it (JSON text or pre-parsed object)
 * @returns settles when THIS frame's handling finished (success or error)
 */
export function handleNodeMessageQueued(deps: NodeWsDeps, ws: NodeWsSocket, raw: string | object): Promise<void> {
  const prev = ws.data.frameQueue ?? Promise.resolve();
  const run = prev.then(() => handleNodeMessage(deps, ws, raw));
  // Store the *caught* tail so a rejected frame still lets queued frames run;
  // the caller's .catch() logs this frame's own error from `run`.
  ws.data.frameQueue = run.catch(() => {});
  return run;
}

/**
 * Socket-close teardown with per-connection identity (spec §5.3):
 * - the CURRENTLY MAPPED socket died → detach, fail its in-flight commands,
 *   project `offline`.
 * - a SUPERSEDED socket's late close → fail only THAT connection's commands;
 *   the map, the new connection, and the row's online status are the newer
 *   socket's business.
 * @param deps - injected dependencies
 * @param ws - the socket whose close fired
 */
export async function handleNodeClose(deps: NodeWsDeps, ws: NodeWsSocket): Promise<void> {
  const nodeId = ws.data.nodeId;
  if (!nodeId) return;
  const conn = ws.data.nodeConn;
  const current = getLive(nodeId);
  const mine = connectionSocket(ws);

  if (current && current.ws === mine) {
    detachConnection(nodeId, mine);
    failConnPendings(conn ?? current, "offline");
    await deps.nodes.setStatus(nodeId, "offline" satisfies NodeStatus);
    logger.debug(`node ws: ${nodeId} disconnected → offline`);
    return;
  }
  if (conn) {
    // Superseded socket (4409) or an already-detached one: drain THIS
    // record's pendings; never touch the registry or the status projection.
    failConnPendings(conn, "offline");
  }
}
