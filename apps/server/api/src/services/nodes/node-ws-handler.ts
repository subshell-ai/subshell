import {
  MIN_NODE_VERSION,
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeEvent,
  nodeVersionSupported,
  parseNodeEvent,
} from "@internal/subshell-protocol";
import { HttpError } from "@/api/auth-guard.js";
import { getAuth } from "@/auth.js";
import type { NodeReadyReport, NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { NodeStatus } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { accountDisabled } from "@/services/account-status.js";
import { pushAllowedDirsBestEffort } from "@/services/nodes/allowed-dirs-sync.js";
import { detectOnNodeBestEffort } from "@/services/nodes/inventory.js";
import { announceNodePresence, projectNodeOffline } from "@/services/nodes/node-presence-announce.js";
import { logger } from "@/utils/logger.js";
import { refireInputHoldsForNode } from "@/ws/input-hold.js";
import { dispatchOutput, getNodeLifecycleHooks } from "./node-events.js";
import {
  attachConnection,
  detachConnection,
  disconnectNode,
  getHeld,
  getLive,
  type HeldReason,
  holdConnection,
  type NodeConnection,
  type NodeSocket,
  OWNER_DISABLED_CLOSE_CODE,
  releaseHeld,
} from "./node-registry.js";
import { failConnPendings, resolveResult } from "./node-rpc.js";

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
  /**
   * The owner the upgrade chain just read as enabled, stashed so
   * {@link handleNodeOpen} can RE-ASK about the same account after the
   * attach without a second row read. Ownership never changes while a socket
   * is mid-handshake, so this is the same fact the pre-socket gate used.
   */
  ownerUserId: string;
}

/** Per-socket data: the upgrade-stashed identity plus the registry record. */
export interface NodeWsData {
  nodeId?: string;
  apiKeyId?: string;
  /** Part of the stashed identity — see {@link NodeWsIdentity.ownerUserId}. */
  ownerUserId?: string;
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
   * Whether an account is disabled (prod: `services/account-status.ts` over
   * the requestless db — the ONE function `authGuard` and better-auth's
   * session hook share, so "disabled" cannot answer differently per surface).
   * Ruling 2026-09-24: a disabled account's enrolled nodes cannot dial in.
   */
  accountDisabled(userId: string): Promise<boolean>;
  /**
   * Feed a `result` frame to the RPC correlator (prod: `node-rpc.resolveResult`).
   * Connection-scoped: only `conn`'s own pendings may settle — pass the
   * socket's own record, never another node's.
   */
  resolveResult(conn: NodeConnection, event: Extract<NodeEvent, { type: "result" }>): boolean;
  /**
   * Kick this node's harness detection after it comes online, fire-and-forget
   * (default {@link detectOnNodeBestEffort} — the `??` at the call site IS the
   * production wiring, the same shape `RemoteLauncher` gives its own kick).
   * Present as a seam so a test can count the kick without a live socket.
   */
  detect?(nodeId: string): void;
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
      // The one account-disabled function, taken from the requestless graph's
      // db — the same one `authGuard` consults on the bearer path, so the
      // upgrade tier cannot disagree with REST about which accounts are dead.
      accountDisabled: (userId) => accountDisabled(getRequestlessContext().db, userId),
      resolveResult: (conn, event) => resolveResult(conn, event),
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
 * `nodes.apiKeyId === row.id` → the node's owner is not a disabled account.
 * Throws the status-carrying errors the global error handler maps to a
 * pre-socket HTTP refusal — 401 for a key that is not a live node credential,
 * 403 for a key↔node link mismatch (rotated/stale key), a dial-in aimed at the
 * local node (it never runs an agent), or an owner whose account is disabled
 * (ruling 2026-09-24). The node-row read happens HERE (not at `open`) so the
 * socket is never opened for a mismatched key.
 *
 * The disabled-owner refusal is deliberately NOT the version-floor hold
 * (spec 2026-09-15 §5.3): a held socket exists to carry the one command that
 * fixes the hold, and `update` cannot un-disable an owner — holding a disabled
 * owner's node would buy nothing and hide it. The agent keeps its ordinary
 * backoff-and-retry (non-terminal), and the upgrade succeeds the moment an
 * admin re-enables, within one reconnect interval (the agent's backoff caps at
 * 60 s).
 * @param deps - injected dependencies
 * @param authzHeader - the raw `Authorization` header value (or null)
 * @returns the identity to stash on the socket
 * @throws HttpError 401/403 — thrown from `upgrade()` to refuse the handshake
 */
export async function authenticateNodeUpgrade(
  deps: Pick<NodeWsDeps, "verifyApiKey" | "nodes" | "accountDisabled">,
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

  // Operator ruling 2026-09-24: a disabled account's enrolled nodes are
  // offline, and stay so. This is the pre-socket half — the disable route's
  // `disconnectNode` closed the live socket with 4403; this refuses every
  // dial-in while the flag stands. The KEY stays valid (rotate/delete revoke
  // it; disable does not — re-enabling must restore the node with no second
  // act), which is exactly why the account, not the key, is the gate here.
  // `local` never reaches this line: its 403 is above it, and an admin
  // disabling the system service user is refused by the route that would do
  // it. A node whose owner has no `user_meta` row reads enabled, matching
  // every other surface — this function is `account-status.ts`, the one
  // `authGuard` uses on the bearer path.
  if (await deps.accountDisabled(node.ownerUserId)) {
    throw new HttpError(403, "The node's owner account is disabled");
  }

  return { nodeId: meta.nodeId, apiKeyId: row.id, ownerUserId: node.ownerUserId };
}

/**
 * Socket-open step: attach to the registry (newest-wins, spec §5.3), remember
 * the connection on the socket for close teardown, then RE-ASK the question
 * the upgrade hook already asked. Deliberately does NOT touch the DB —
 * `status='online'` arrives with `ready` via {@link handleNodeMessage}, so a
 * connected-but-silent agent reads offline.
 *
 * **Why the second ask exists.** The upgrade-time refusal and the disable
 * route's socket sweep are a check-then-act pair with the whole handshake
 * sitting between them, and that is inherently racy: an upgrade reads the
 * owner as enabled, the admin disables (flag commits, sweep runs and finds NO
 * live socket to close — this one has not attached yet), and only then does
 * `open` land its `attachConnection`. Without the re-ask, that socket — the
 * one the sweep missed by microseconds — would stay online until the agent's
 * connection happened to drop. Attaching BEFORE asking is the whole point of
 * the order: every interleaving is then covered by one of the two halves. A
 * disable that beats the attach finds the socket in the sweep; one that lands
 * inside the window is caught here.
 *
 * The eviction reuses the disable route's own machinery —
 * {@link disconnectNode} with {@link OWNER_DISABLED_CLOSE_CODE} and the same
 * reason string, then the captured record drained the same way — because a
 * second teardown implementation is a second thing to drift. A socket whose
 * stashed identity names no owner is not this rule's business (nothing to
 * ask about), and a THROWING re-ask leaves the socket attached: the upgrade
 * chain already answered this same question successfully moments ago, and
 * failing closed here would evict healthy nodes on any transient the DB has;
 * the next dial-in meets the flag at the pre-socket gate, where the read is
 * load-bearing anyway.
 * @param deps - the one account gate the re-ask reads
 * @param ws - the authenticated socket (identity stashed by the upgrade hook)
 */
export async function handleNodeOpen(deps: Pick<NodeWsDeps, "accountDisabled">, ws: NodeWsSocket): Promise<void> {
  const nodeId = ws.data.nodeId;
  if (!nodeId) {
    // Unreachable behind a correctly-wired upgrade hook; refuse loudly
    // rather than attach an anonymous socket.
    ws.close(NODE_CLOSE_UNAUTHENTICATED, "no verified identity on this socket");
    return;
  }
  const conn = attachConnection(nodeId, connectionSocket(ws));
  ws.data.nodeConn = conn;
  logger.debug(`node ws: ${nodeId} connected`);

  if (!ws.data.ownerUserId) return;
  if (await deps.accountDisabled(ws.data.ownerUserId)) {
    // The sweep's contract, on the socket the sweep missed: close 4403 with
    // the reason the agent relays into its own log, evict from the live
    // registry, drain the record's in-flight commands. The eviction also
    // OWNS its status projection (`disconnectNode` → row offline + presence
    // announce): usually this row is pre-`ready` and the write lands as an
    // idempotent no-op, but a row still reading `online` from an earlier
    // session's ready is exactly the case that needs it, and the close
    // event's own teardown finds the record already gone and stops there.
    // `conn` is passed as the eviction's ONLY target: if a newer socket
    // took the live slot while this re-ask was in flight, THIS eviction must
    // not condemn it — that socket ran its own `accountDisabled` re-ask the
    // moment it attached. Finding nothing to evict is the correct false; the
    // superseded record drains through its own 4409 close event (see
    // `handleNodeClose`), and the replacement's state is the replacement's
    // business.
    if (await disconnectNode(nodeId, OWNER_DISABLED_CLOSE_CODE, "the node's owner account is disabled", conn)) {
      failConnPendings(conn, "offline");
      logger.warn(`node ws: ${nodeId} attached after its owner's disable landed — evicted at open`);
    } else {
      // The honest other branch: this socket was superseded mid-await, so it
      // was never live to evict and its replacement's re-ask owns that one.
      // Logging an eviction that did not happen is the kind of journal line
      // that teaches an operator to distrust the journal.
      logger.warn(
        `node ws: ${nodeId} attached after its owner's disable landed, but its socket had already been superseded — the replacement answers for itself`,
      );
    }
  }
}

/**
 * Byte size of an inbound frame, whichever form Elysia hands us.
 *
 * **Binary measures natively (ruling R2, spec 2026-09-24 ledger).** Once an
 * encrypted link exists (task 8 onward), ciphertext arrives as a Buffer /
 * Uint8Array / ArrayBuffer. The `JSON.stringify` fallback would serialize a
 * Buffer to its `{"type":"Buffer","data":[1,2,…]}` JSON — an order of
 * magnitude over the real byte size — so EVERY encrypted frame would read
 * oversize and this socket would close 1009. The stringify branch therefore
 * stays for what it was always for: a genuinely pre-parsed object (Elysia
 * JSON-parses text frames beginning with `{`). The Buffer-view arithmetic on
 * the Uint8Array arm is the same non-copy window the send side uses (pool
 * Buffers and subviews report their own span, not the backing store).
 *
 * @internal exported for its unit tests — callers use `handleNodeMessage`.
 */
export function frameBytes(raw: string | object): number {
  if (typeof raw === "string") return Buffer.byteLength(raw);
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.length).byteLength;
  return Buffer.byteLength(JSON.stringify(raw));
}

/**
 * Hold a socket the plane refuses, instead of closing it (spec 2026-09-15 §5.3).
 *
 * The agent behind this socket speaks a protocol this server does not. Two
 * things follow, and both are the point:
 *
 * - **It is offline for every purpose but `update`.** `holdConnection` moves it
 *   out of the live registry, so `isNodeOffline` and `listOnline` — the blessed
 *   liveness predicates — go on answering exactly as they did when this closed.
 *   Launches, tails and probes never reach it.
 * - **The plane can still send it one thing.** The `update` command's wire
 *   shape is frozen precisely so this agent, whatever build it is, can parse
 *   it. Nothing here decides who may ask for that; the route does.
 *
 * NOTHING IS SENT on the held socket by this function. An agent that has been
 * held is waiting for a command or a close, and a courtesy frame it might not
 * parse is a worse greeting than silence.
 *
 * The idle close carries the reason string the agent would have got
 * immediately, so an operator at the machine still reads "update required" in
 * its log — ten minutes later rather than at once, which is the price of the
 * window in which the plane could have fixed it from a browser.
 */
async function holdRefusedNode(
  deps: NodeWsDeps,
  ws: NodeWsSocket,
  nodeId: string,
  event: Extract<NodeEvent, { type: "ready" }>,
  reason: HeldReason,
  message: string,
): Promise<void> {
  const conn = ws.data.nodeConn ?? getLive(nodeId);
  if (!conn) {
    // No connection record to hold (a socket that never went through `open`).
    // Refuse it the old way rather than leaving it attached to nothing.
    ws.close(NODE_CLOSE_UPDATE_REQUIRED, message);
    return;
  }
  holdConnection(nodeId, conn, {
    reason,
    agentVersion: event.agentVersion,
    protocolVersion: event.protocolVersion,
    os: event.os,
    arch: event.arch,
    onIdle: () => {
      try {
        conn.ws.close(NODE_CLOSE_UPDATE_REQUIRED, message);
      } catch {
        // already gone — the registry entry is what mattered and it is dropped
      }
    },
  });
  // THE ROW GOES BACK TO OFFLINE, and this is the line the hold cannot do
  // without. `applyReady` above sets `status: "online"` — deliberately, since
  // it is what persists the identity a page needs to say "this node needs an
  // update" — and before the hold the socket closed in the same turn, so the
  // close path projected `offline` a moment later. A held socket never closes,
  // so without this the row would read online for a machine no command can
  // reach, and `isNodeOffline` (the registry) and the DB projection would
  // disagree permanently.
  await deps.nodes.setStatus(nodeId, "offline" satisfies NodeStatus);
  announceNodePresence(nodeId);
  logger
    .withMetadata({ nodeId, agentVersion: event.agentVersion, protocolVersion: event.protocolVersion })
    .warn(`node ws: holding ${nodeId} for update — ${message}`);
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
 * @param raw - frame as Elysia delivered it (JSON text, pre-parsed object, or
 *   a Buffer of link ciphertext — task 6 plumbing; the encrypted-link acceptor
 *   that decrypts-before-parsing lands with the handshake, and until then
 *   binary frames measure natively against the cap and fall out of
 *   {@link parseNodeEvent} as unrecognized)
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

  // A HELD socket may say exactly one thing: the `result` of the `update`
  // this plane sent it (spec 2026-09-15 §5.3). Everything else is dropped
  // silently — a held agent speaks a protocol this server does not, so its
  // `ready`, `heartbeat`, `inventory`, `subshells_report` and `maintenance`
  // frames are claims about a wire contract the two ends do not share, and
  // applying one would write a machine's facts from a build that cannot be
  // asked to confirm them. It keeps SENDING them (its heartbeat does not know
  // it is being ignored), and that costs nothing: dropping is one map probe.
  //
  // The `ready` that CAUSED the hold reaches this point too, on a reconnect,
  // which is why the check is after the parse and before the switch: it must
  // not re-run `applyReady` and flip the row back to online.
  const heldEntry = getHeld(nodeId);
  if (heldEntry && ws.data.nodeConn === heldEntry.conn) {
    if (event.type !== "result") {
      logger.debug(`node ws: dropped ${event.type} from held node ${nodeId}`);
      return;
    }
    if (!deps.resolveResult(heldEntry.conn, event)) {
      logger.debug(`node ws: result frame from held ${nodeId} for unknown ref ${event.ref}`);
    }
    return;
  }

  // The LIVE twin of the held path's identity probe above (C14, 2026-09-24).
  // `attachConnection` newest-wins closes the older socket with 4409, but a
  // frame that was already queued on THAT socket's serialized chain
  // (`ws.data.frameQueue` lives on the shared data object, and the close
  // event lands whenever Elysia gets to it) still runs. Without this probe,
  // the stale `ready` re-applies machine facts over the replacement's row and
  // the stale `heartbeat` stamps `lastSeen` through the new socket's own
  // liveness — writes from a connection the plane has already disowned.
  //
  // `result` is the one exempt type: it settles ONLY this socket's own record
  // (the `result` case below reads `ws.data.nodeConn`, never the registry's
  // current entry), which is the contract
  // `node-ws-handler.test.ts` pins — "a result on a socket whose node was
  // superseded still settles only ITS own record". A `result` cannot write a
  // row; the frames worth refusing are exactly the ones the switch hands to
  // `deps.nodes`.
  //
  // Identity is by record, per the file's own discipline: a frame whose
  // socket never went through `open` (unit fakes) and a node with no live
  // entry are `undefined` on both sides and pass — a socket whose record is
  // simply no longer THE record is superseded, and `getLive(nodeId) !==
  // ws.data.nodeConn` is the file-idiomatic probe for that.
  if (event.type !== "result" && getLive(nodeId) !== ws.data.nodeConn) {
    logger.debug(`node ws: dropped ${event.type} from a superseded socket of ${nodeId}`);
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
      // The write this frame issued can OVERTAKE its own eviction: a forced
      // `disconnectNode` that lands while the UPDATE is in flight detaches
      // and projects `offline` around its own await, and the already-issued
      // write lands `online` after it — the row would otherwise read online
      // for a machine with no socket until the stale sweep (~45 s). Converge
      // with the C14 probe's identity idiom, and BY DIRECTION: GONE means the
      // eviction's projection deserves the last word, so re-project (the same
      // seam every other forced teardown uses, idempotent); REPLACED means a
      // newer socket is live and `online` is that machine's truth —
      // projecting there would strand a healthy node offline until its next
      // reconnect, the same divergence wearing the other coat. Both-undefined
      // (a socket that never went through `open`) passes, as it does above.
      // Either way the frame STOPS here: everything below belongs to the
      // connection that owns the row now, not to this disowned one.
      const stillLive = getLive(nodeId);
      if (stillLive !== ws.data.nodeConn) {
        if (stillLive === undefined) await projectNodeOffline(nodeId);
        return;
      }
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
          ...(event.selfInvoke ? { selfInvoke: event.selfInvoke } : {}),
          // Spec 2026-09-10 §5: the resume-path home. Conditional spread,
          // never bare `homeDir: event.homeDir` — an unreported field must
          // stay ABSENT on the facts (that is the state `canResume` reads as
          // "nothing reported"), not arrive as an undefined-valued key a
          // later `in`-check would misread. The env VALUES are NOT a ready
          // field: they answer on the plane's `detect` round trip, whose
          // driver stashes them here (inventory.ts `detectOnNode`).
          ...(event.homeDir ? { homeDir: event.homeDir } : {}),
          // Spec 2026-09-12 §6.1: how this agent PROCESS runs. Conditional
          // spread for the same reason as the two above — an agent that
          // predates the field must leave the key ABSENT, which is what the
          // detail view reads as "no Runtime card", not present-and-undefined.
          ...(event.runtime ? { runtime: event.runtime } : {}),
        };
      }
      // The floor FIRST, because its refusal is the one a person can act on:
      // it names the version to install and the version found, where a bare
      // protocol number names neither. Identity is already persisted above,
      // so the Nodes page can show the same thing.
      //
      // NEITHER GATE CLOSES ANY MORE (spec 2026-09-15 §5.3). Both HOLD the
      // socket instead: a refused agent is offline for every purpose except
      // `update`, which is the one command that can fix it, and dropping the
      // connection was what left an operator with nothing to do but walk to
      // the machine. Everything else about the refusal is unchanged — the
      // reason strings are the ones the agent already logs, and they travel
      // on the eventual idle close.
      if (!nodeVersionSupported(event.agentVersion)) {
        await holdRefusedNode(
          deps,
          ws,
          nodeId,
          event,
          "below-floor",
          `subshell ${MIN_NODE_VERSION} or newer required (this node is ${event.agentVersion || "unversioned"})`,
        );
        return;
      }
      // Backstop. An agent at or above the floor should always speak the
      // current protocol — they ship together — so reaching this means the
      // floor is set wrong, not that a node needs carrying. Kept because
      // parsing frames from an agent that does not speak them is worse than
      // refusing, and the message says which of the two failed.
      if (event.protocolVersion !== NODE_PROTOCOL_VERSION) {
        await holdRefusedNode(
          deps,
          ws,
          nodeId,
          event,
          "protocol-mismatch",
          `protocol v${NODE_PROTOCOL_VERSION} required (this node speaks v${event.protocolVersion})`,
        );
        return;
      }
      // Harness detection, now that this node is reachable. NOT the §5.3
      // inventory PULL Task 7 retired — that asked the agent to scan ITSELF
      // and answer with a harness claim, which a post-inversion agent fills
      // with an EMPTY array (the `inventory` case below explains why applying
      // `[]` is poison), so the round trip stored nothing. This is the
      // ordinary §4 request: the plane ships its own detect rules, the node
      // answers raw, and the driver merges. The plane asks and the node
      // answers, exactly as on a page load — what is new is only that
      // BECOMING REACHABLE counts as an occasion to ask.
      //
      // It is the half of the freshness story a person cannot supply: a
      // freshly enrolled agent connects the moment it is installed, so
      // enrolment needs no special case, and every reconnect and agent
      // restart is covered by the same line. Fire-and-forget — the answer
      // arrives as a later `result` frame behind this one in the socket's own
      // queue, so awaiting it here would deadlock, and a detect that fails
      // must never be why a handshake did.
      //
      // The periodic other half lives in `services/nodes/inventory-refresh.ts`,
      // armed at boot: this line answers "a machine appeared", that timer
      // answers "somebody installed a CLI on one an hour ago".
      try {
        (deps.detect ?? detectOnNodeBestEffort)(nodeId);
      } catch (err: unknown) {
        // Only a throwing seam can land here; the default absorbs everything
        // into a debug line by construction. Guarded anyway because the
        // maintenance reconcile below is load-bearing — the row must refuse
        // launches before this frame is done — and a probe is not allowed to
        // be the reason it did not run.
        logger.withError(err).debug(`node ws: connect-time detection kick for ${nodeId} failed`);
      }
      // The node re-learns its directory allowlist (spec 2026-09-05) on
      // every `ready` — that reconciliation is live data and STAYS.
      // This is the reconciliation: an owner may have changed the rules while
      // this node was offline, and nothing else would ever tell it.
      pushAllowedDirsBestEffort(nodeId);
      // And the dashboard re-learns that this machine is reachable: the same
      // transition as the close path, from the other side. Every running row
      // on it carries `nodeOffline`, and nothing writes to those rows when a
      // socket comes back either.
      announceNodePresence(nodeId);
      // Wave D (spec 2026-09-21): input writes that failed while this node
      // was unreachable are held per attached browser session
      // (`ws/input-hold.ts`). This ready moment is one of the hold's two
      // re-fire triggers — re-fire in id order, before anything newer is
      // written. Fire-and-forget like the detect kick above, and guarded the
      // same way: a hold must never be the reason a handshake did not
      // complete, and a re-fire failure re-holds by itself.
      try {
        refireInputHoldsForNode(nodeId);
      } catch (err: unknown) {
        logger.withError(err).debug(`node ws: input-hold refire for ${nodeId} failed`);
      }
      // Maintenance is the other half of that reconciliation and the harder
      // one, because it travels BOTH ways: the machine may have been flipped
      // at the keyboard while it was offline, and so may the row. The hook
      // decides by stamp and writes the winner. Awaited — the row must refuse
      // launches before this frame is done — while the expensive part (a kill
      // per running subshell) is voided inside the hook so it cannot stall
      // this socket's queue.
      const hooks = getNodeLifecycleHooks();
      if (hooks) await hooks.onMaintenance(nodeId, event.maintenance);
      else logger.debug(`node ws: ready from ${nodeId} with no lifecycle hook to reconcile maintenance`);
      return;
    }
    case "heartbeat":
      await deps.nodes.touch(nodeId);
      return;
    case "inventory":
      // Since the agent lost its plugin concept (inversion spec §6, Task 7),
      // an EMPTY `harnesses` array is the in-band spelling of "nothing to
      // claim": the field stays REQUIRED on the wire (protocol 3 dropped the
      // `plugins` field, not this one), so a plugin-less agent fills it with
      // `[]` on every connect push and every 5-min beat. Applying that
      // wholesale would WIPE the rows the plane's own `detect` driver cached
      // (§4) — and the next periodic beat would wipe them again, making
      // detection-only-on-request impossible.
      // So: empty (or absent) = don't touch; a NON-empty list is still a real
      // scan (an agent paired from before the demolition) and applies as it
      // always has. Pinned by the detect-cache test in
      // `__tests__/inventory-detect.test.ts`.
      // (The `plugins` DECLARATION that used to ride this event is gone —
      // protocol 3 — and with migration 0026 so is the mirror it wrote:
      // there is no plugin-report column left for a frame to populate.)
      if (event.harnesses && event.harnesses.length > 0) {
        await deps.nodes.applyInventory(nodeId, JSON.stringify(event.harnesses));
      }
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
    case "maintenance": {
      const hooks = getNodeLifecycleHooks();
      // Somebody ran `subshell maintenance on|off` at the machine. Same hook
      // as `ready`, on purpose: a flip reported mid-session and a flip
      // discovered at connect are the same disagreement, and one reconciler
      // is what keeps them from answering differently.
      if (hooks) await hooks.onMaintenance(nodeId, { on: event.on, changedAt: event.changedAt });
      else logger.warn(`node ws: maintenance from ${nodeId} with no lifecycle hook`);
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
      logger.withMetadata({ nodeId, code: event.code }).warn(`node reported error: ${event.message}`);
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
    // Every running row on this machine just became unreachable, and no write
    // touched any of them — so without this the dashboard keeps rendering
    // them as healthy until the viewer reconnects.
    announceNodePresence(nodeId);
    logger.debug(`node ws: ${nodeId} disconnected → offline`);
    return;
  }
  if (conn) {
    // A HELD socket lands here too — it was detached from `live` the moment
    // it was held, so the branch above cannot see it. Releasing is what stops
    // the registry from offering a dead socket to the next `update`, and it
    // also disarms the idle timer, which would otherwise fire minutes later
    // to close something that is already gone.
    //
    // The status projection is deliberately NOT touched: `holdRefusedNode`
    // already wrote `offline`, and a held node has no other state to leave.
    releaseHeld(nodeId, conn);
    // Superseded socket (4409) or an already-detached one: drain THIS
    // record's pendings; never touch the registry or the status projection.
    failConnPendings(conn, "offline");
  }
}
