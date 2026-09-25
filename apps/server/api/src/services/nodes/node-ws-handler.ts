import {
  MIN_NODE_VERSION,
  NODE_CLOSE_HANDSHAKE_REQUIRED,
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeEvent,
  nodeVersionSupported,
  parseNodeEvent,
} from "@internal/subshell-protocol";
import type { LinkSession } from "@internal/subshell-protocol/node-link-crypto";
import { HttpError } from "@/api/auth-guard.js";
import { getAuth } from "@/auth.js";
import type { NodeReadyReport, NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { NodeStatus } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { accountDisabled } from "@/services/account-status.js";
import { pushAllowedDirsBestEffort } from "@/services/nodes/allowed-dirs-sync.js";
import { detectOnNodeBestEffort } from "@/services/nodes/inventory.js";
import {
  beginLinkUpgrade,
  HANDSHAKE_TIMEOUT_MS,
  handleLinkFrame,
  handshakeIncomplete,
  type LinkFrame,
  type LinkMode,
  type LinkPhase,
  type LinkSessionDeps,
} from "@/services/nodes/link-session.js";
import { loadNodeEncryptionKeys, nodeEncryptionPublicKey } from "@/services/nodes/node-encryption-keys.js";
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
import { binaryPayload, failConnPendings, resolveResult } from "./node-rpc.js";
import { recordNodeDisconnect, recordNodeReady } from "./update-tracker.js";

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
  /**
   * How the row's encryption state classifies this socket, decided by
   * {@link beginLinkUpgrade} from the row's pin — no second query. A pinned
   * row is `"handshake"` (a v14 socket, which never runs on plaintext once
   * this is set); a pin-less row is `"legacy"` (plaintext until it registers).
   * Every real frame is routed through the link machine on the strength of
   * this field; an UNSET `linkMode` is the only shape that bypasses the
   * machine, and nothing the upgrade hook produces leaves it unset.
   */
  linkMode: LinkMode;
  /**
   * The row's pinned node static (canonical base64), or null on a legacy row.
   * Handshake mode compares a `kx` claim against it (spec §4 step 3); legacy
   * mode never has one. Read off the same row the classification used.
   */
  linkEncryptPublicKey: string | null;
}

/** Per-socket data: the upgrade-stashed identity plus the registry record. */
export interface NodeWsData {
  nodeId?: string;
  apiKeyId?: string;
  /** Part of the stashed identity — see {@link NodeWsIdentity.ownerUserId}. */
  ownerUserId?: string;
  /**
   * Part of the stashed link classification ({@link NodeWsIdentity.linkMode}).
   * The link machine's per-frame decision reads it off the shared data object;
   * a socket that never ran the upgrade has it undefined, which is how the
   * unit-fake plaintext path bypasses the machine.
   */
  linkMode?: LinkMode;
  /** Part of the stashed link classification — see {@link NodeWsIdentity.linkEncryptPublicKey}. */
  linkEncryptPublicKey?: string | null;
  /**
   * Handshake progress, machine-owned scratch (absent = `awaiting-kx`). Lives
   * here because Elysia shares this object across every per-event wrapper.
   * @internal
   */
  linkPhase?: LinkPhase;
  /**
   * The derived session once `kx` is accepted, machine-owned scratch. Its
   * presence is implied by `linkPhase`; {@link handleNodeMessage} also copies
   * it onto {@link NodeWsData.nodeConn}`.link so the send path seals.
   * @internal
   */
  linkSession?: LinkSession;
  /** Registry connection created at `open`; close teardown fails THIS record. */
  nodeConn?: NodeConnection;
  /**
   * Handshake deadline armed by {@link handleNodeOpen} for a `handshake`-mode
   * socket, cleared once the link establishes or the socket closes. A socket
   * still awaiting kx/binding when it fires is refused 4410 (spec §6).
   */
  handshakeTimer?: ReturnType<typeof setTimeout>;
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
  /**
   * Resolve this node's update-tracker entry against a `ready`'s reported
   * version (default `update-tracker.ts`'s `recordNodeReady`; the `??` at the
   * call site is the production wiring, {@link NodeWsDeps.detect}'s shape).
   * Seam so a test can watch the CALL without a tracker of its own.
   */
  recordNodeReady?(nodeId: string, agentVersion: string): void;
  /**
   * Note that this node's authenticated socket dropped (default
   * `recordNodeDisconnect` — deliberately a no-op; see its doc). Carried as a
   * seam for symmetry with {@link NodeWsDeps.recordNodeReady}: the moments the
   * handler witnesses are all injectable, including the ones that do nothing.
   */
  recordNodeDisconnect?(nodeId: string): void;
  /**
   * The link-handshake machine's dependencies, passed straight through to
   * {@link handleLinkFrame} for every frame on a socket the upgrade classified.
   * Its `verifyApiKey` is the SAME re-prove the upgrade's `verifyApiKey` is
   * (the binding re-checks the bearer key inside the encrypted channel), and
   * its keypair/pin handles reach `node-encryption-keys.ts` and the nodes
   * repository. Required, not optional: a socket that reached the message
   * handler was classified at upgrade, so the machine always has what it needs.
   */
  link: LinkSessionDeps;
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
    const nodes = getRequestlessContext().repos.nodes;
    // Shared by the upgrade tier and the binding re-prove (link-session's
    // `verifyApiKey`): better-auth hashes internally, so BOTH asks are "resolve
    // a raw key to its live api-key row", and the binding re-RUNS this rather
    // than comparing a plaintext the plane never holds.
    const verifyApiKey = async (rawKey: string): Promise<NodeVerifiedKey | null> => {
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
    };
    prodDeps = {
      verifyApiKey,
      nodes,
      // The one account-disabled function, taken from the requestless graph's
      // db — the same one `authGuard` consults on the bearer path, so the
      // upgrade tier cannot disagree with REST about which accounts are dead.
      accountDisabled: (userId) => accountDisabled(getRequestlessContext().db, userId),
      resolveResult: (conn, event) => resolveResult(conn, event),
      link: {
        verifyApiKey,
        loadNodeEncryptionKeys,
        nodeEncryptionPublicKey,
        setEncryptPublicKey: (id, key) => nodes.setEncryptPublicKey(id, key),
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

  // Classify the socket for the link machine from the SAME row every other
  // check above read — no second query. A pinned row must handshake (it will
  // never speak plaintext `ready`; a kx-less first frame closes 4410); a
  // pin-less row is legacy (plaintext until it registers, and even then a
  // would-pass ready is held, not admitted — ledger R3). The result rides the
  // stashed identity into `ws.data`, which is what lets the message entry route
  // every frame through `handleLinkFrame` without ever asking the DB again.
  const { mode } = beginLinkUpgrade(node);
  return {
    nodeId: meta.nodeId,
    apiKeyId: row.id,
    ownerUserId: node.ownerUserId,
    linkMode: mode,
    linkEncryptPublicKey: node.encryptPublicKey ?? null,
  };
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
 * @param deps - the one account gate the re-ask reads, plus the optional
 *   test-only `handshakeTimeoutMs` override of the deadline interval
 * @param ws - the authenticated socket (identity stashed by the upgrade hook)
 */
export async function handleNodeOpen(
  deps: Pick<NodeWsDeps, "accountDisabled"> & {
    /**
     * Test-only override of the handshake-deadline interval, so a unit test can
     * pin that a handshake-mode socket which never establishes is closed with
     * the GENERIC 4410 when it fires (ruling R12b's I-1 regression: this 4410
     * must NOT drop the agent's pin). Production wiring omits it →
     * {@link HANDSHAKE_TIMEOUT_MS}.
     */
    handshakeTimeoutMs?: number;
  },
  ws: NodeWsSocket,
): Promise<void> {
  const nodeId = ws.data.nodeId;
  if (!nodeId) {
    // Unreachable behind a correctly-wired upgrade hook; refuse loudly
    // rather than attach an anonymous socket.
    ws.close(NODE_CLOSE_UNAUTHENTICATED, "no verified identity on this socket");
    return;
  }
  const conn = attachConnection(nodeId, connectionSocket(ws));
  // Ruling I-2: this socket's plaintext policy, decided from the SAME
  // classification every frame is routed on. A HANDSHAKE (protocol-14) row
  // may never receive a plaintext command — not even in the open→established
  // window, where `conn.link` is unset: `sendCommand` refuses `offline` there
  // instead of killing the in-flight handshake with a frame the agent will
  // refuse anyway. A LEGACY row legitimately runs plaintext until it
  // registers — which is also how every HELD socket reaches us (a handshake
  // row's plaintext `ready` never survives to the gates that hold it), so the
  // frozen `update` rescue keeps its plaintext verbatim.
  conn.plaintextAllowed = ws.data.linkMode === "legacy";
  ws.data.nodeConn = conn;
  logger.debug(`node ws: ${nodeId} connected`);

  // A handshake-mode socket owes the machine a kx and a binding before it may
  // do anything. Arm the deadline here — the socket is owned by the handler,
  // not by the pure machine (which only answers {@link handshakeIncomplete}).
  // A socket still awaiting-kx or awaiting-binding when this fires is refused
  // 4410 (spec §6: close, do not wait; the encrypted stream has no resync).
  // A LEGACY socket arms nothing: it is legitimately plaintext until it
  // registers, and the plaintext deadline would be the downgrade guard run
  // backwards. Cleared the moment the link establishes, or by any close.
  if (ws.data.linkMode === "handshake") {
    const timer = setTimeout(
      () => {
        if (handshakeIncomplete(ws.data)) {
          try {
            ws.close(NODE_CLOSE_HANDSHAKE_REQUIRED, "handshake required: no kx/binding within the deadline");
          } catch {
            // already gone
          }
        }
      },
      // Test seam: a unit test drives this at a few-ms interval to pin the
      // deadline's GENERIC 4410 (not a 4411) firing on a stalled-but-pinned
      // socket. Omitted in production → the real HANDSHAKE_TIMEOUT_MS.
      deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    );
    // Never let an unfinished handshake hold the process (or a test runner).
    timer.unref?.();
    ws.data.handshakeTimer = timer;
  }

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
 * Shape an inbound frame into the {@link LinkFrame} union the handshake machine
 * reads, WITHOUT losing information.
 *
 * Elysia delivers a `/ws/node` frame in three shapes and the machine accepts
 * exactly two (`{text}` / `{bytes}`), so the middle one needs a decision:
 * - a **string** is plaintext, handed to the machine as `{text}` verbatim;
 * - a **Buffer / Uint8Array / ArrayBuffer** is secretstream ciphertext, handed
 *   as `{bytes}` (a Buffer is a Uint8Array; an ArrayBuffer is wrapped, no copy
 *   of the bytes beyond the view);
 * - a **pre-parsed plain object** is what Elysia produced when it JSON-parsed a
 *   TEXT frame that began with `{` — it is NOT ciphertext, it is plaintext that
 *   merely arrived parsed. Re-serializing it to `{text}` is the whole trick: the
 *   handshake's `kx`/`register` frames are JSON objects, and a socket that gets
 *   its `kx` pre-parsed must still reach `parseKxFrame` rather than be mistaken
 *   for bytes and closed 4410. The machine's own `parseJson` round-trips this
 *   string back to the identical object, so nothing is lost — this pins that
 *   the pre-parsed form is accepted, which is where a real socket most quietly
 *   breaks (spec 2026-09-24 §4).
 */
function normalizeLinkFrame(raw: string | object): LinkFrame {
  if (typeof raw === "string") return { text: raw };
  if (raw instanceof ArrayBuffer) return { bytes: new Uint8Array(raw) };
  if (raw instanceof Uint8Array) return { bytes: raw };
  return { text: JSON.stringify(raw) };
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
 * @param raw - frame as Elysia delivered it: JSON text, a pre-parsed object, or
 *   a Buffer of link ciphertext. After the size cap it is routed through the
 *   link machine (spec 2026-09-24 §4) when the upgrade classified this socket;
 *   the machine either fully owns the frame (a handshake step, a refusal, the
 *   legacy register answer, the ledger-R3 hold) or hands back the plaintext to
 *   continue down the untouched path below.
 */
export async function handleNodeMessage(deps: NodeWsDeps, ws: NodeWsSocket, raw: string | object): Promise<void> {
  const nodeId = ws.data.nodeId;
  if (!nodeId) return; // never authenticated — ignore, the close will clean up

  if (frameBytes(raw) > NODE_MAX_FRAME_BYTES) {
    ws.close(NODE_CLOSE_TOO_BIG, `frame exceeds ${NODE_MAX_FRAME_BYTES} bytes`);
    return;
  }

  // ── pre-classify every frame through the link machine (spec §4/§5/§6) ──
  //
  // The machine runs BEFORE the held-gate, supersede-probe and switch that
  // follow, and this is the ordering decision the Task 7 review asked to be
  // made deliberately. Running it first means a HELD socket — e.g. one held a
  // moment ago for ledger R3 — can still carry a `register` on the SAME socket:
  // the machine's legacy path handles the register, writes the pin, and closes
  // normally so the reconnect is a handshake, which is the self-heal the plain-
  // text register exists to be. Had the held-gate run first, it would have
  // dropped that register as "not a result" and the socket would only heal on a
  // later reconnect. Routing the machine first does NOT touch the held-gate/
  // supersede/switch themselves — a `{forwarded}` frame continues into them
  // byte-identically, so every below-floor/protocol-mismatch/superseded/
  // disconnect behaviour downstream is unchanged.
  //
  // The gate on this block is the CLASSIFICATION (the upgrade ran), not the
  // mode: a `legacy` socket runs the machine too (register self-heal + R3 are
  // legacy's). Only a socket whose `data` never went through the upgrade hook —
  // a unit fake — has an unset `linkMode` and so skips to the plaintext path.
  let resolved: string | object = raw;
  if (ws.data.linkMode !== undefined) {
    const outcome = await handleLinkFrame(deps.link, ws, normalizeLinkFrame(raw));
    if ("close" in outcome) {
      // The machine owns this socket's refusal (4410 handshake, or a legacy
      // register it could not validate); the agent relays the reason. Handled.
      ws.close(outcome.close.code, outcome.close.reason);
      return;
    }
    if ("sendText" in outcome) {
      // Ruling R7 — the legacy register answer: send the ONE plaintext
      // `register-ok`, then close NORMALLY (code 1000, not 4410). The agent
      // reconnects encrypted; its freshly-written pin classifies that socket
      // `handshake`, so the ordinary path never runs on the same socket (§5).
      ws.send(outcome.sendText);
      ws.close();
      return;
    }
    if ("consumed" in outcome) {
      if ("sendBytes" in outcome) {
        // The handshake just completed: this is the server's FIRST push, the
        // sealed `{"t":"ok"}` (secretstream header included). It must leave as a
        // BINARY frame — a bare Uint8Array would be JSON-stringified to text by
        // Elysia's `send`, so it goes through the Buffer-view `binaryPayload`
        // seam (the send-side mirror of ruling R2).
        ws.send(binaryPayload(outcome.sendBytes));
      }
      if ("established" in outcome) {
        // Key THIS connection's send path on the session so every later
        // command seals (spec §4); the deadline is no longer owed.
        const linkConn = ws.data.nodeConn ?? getLive(nodeId);
        if (linkConn) linkConn.link = outcome.established;
        if (ws.data.handshakeTimer) {
          clearTimeout(ws.data.handshakeTimer);
          ws.data.handshakeTimer = undefined;
        }
      }
      return;
    }
    if ("holdEncryptionRequired" in outcome) {
      // Ledger R3 — a would-pass `ready` on a pin-less (un-encrypted) row. This
      // is the DOWNGRADE attempt the handshake exists to refuse, NOT a
      // legitimately-old agent, so the plane must not bless its self-claimed
      // identity onto the row: `applyReady` (which writes `status: online` and
      // the machine facts) NEVER runs here — the node is never brought online.
      // Hold DIRECTLY with the parsed `ready`'s facts for the HELD ENTRY only
      // (offline for every purpose but `update`, so the Updates page still names
      // the version through `held`), and return. A below-floor or
      // protocol-mismatch ready on the same legacy socket is NOT this arm — the
      // machine FORWARDS those, and they run `applyReady` + hold with their
      // existing reason exactly as they always have.
      const refused = parseNodeEvent(raw);
      if (refused?.type === "ready") {
        await holdRefusedNode(
          deps,
          ws,
          nodeId,
          refused,
          "encryption-required",
          "this node must pair its encryption key (subshell update + re-register)",
        );
      } else {
        // The machine only signals R3 for a `ready` that passed both gates, so a
        // non-ready reaching here is an impossible state; refuse the socket
        // rather than leave it attached and unheld.
        ws.close(NODE_CLOSE_HANDSHAKE_REQUIRED, "handshake refused: encryption required");
      }
      return;
    } else if ("forwarded" in outcome) {
      // Plaintext for the untouched path below: the decrypted string of an
      // established link, or a legacy frame as it arrived (binary included — a
      // pin-less row has no stream, so binary stays what it always was here:
      // unrecognized).
      resolved = outcome.forwarded;
    }
  }

  const event = parseNodeEvent(resolved);
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
      // The tracker's one piece of evidence about what actually boots there
      // (design 2026-09-25): beside the row write, NOT after the gates below,
      // because a refused-and-held ready reports the same fact about the
      // machine — a swap that reverted at boot is exactly a ready that comes
      // back on the old version. The frame may still be rejected downstream;
      // the version it proved is already recorded.
      (deps.recordNodeReady ?? recordNodeReady)(nodeId, event.agentVersion);
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
      // A ready that reaches THIS point (past both gates, about to come online)
      // has already cleared the ledger-R3 check in the pre-switch machine block
      // above: a LEGACY row's would-pass plaintext `ready` was held with
      // `encryption-required` and never got here, and a handshake row's
      // established link never carries a plaintext `ready` at all. So anything
      // arriving here is legitimately online-able — a forwarded encrypted ready,
      // or an unclassified (pre-encryption) agent's ready.
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
  // A handshake that never finished must not fire its 4410 at a socket that has
  // already gone (the close that lands on the way here IS its going).
  if (ws.data.handshakeTimer) {
    clearTimeout(ws.data.handshakeTimer);
    ws.data.handshakeTimer = undefined;
  }
  const conn = ws.data.nodeConn;
  const current = getLive(nodeId);
  const mine = connectionSocket(ws);

  if (current && current.ws === mine) {
    detachConnection(nodeId, mine);
    failConnPendings(conn ?? current, "offline");
    await deps.nodes.setStatus(nodeId, "offline" satisfies NodeStatus);
    // Witnessed, and deliberately NOT read as a restart (design 2026-09-25):
    // this branch is the authenticated socket's own death, which is exactly
    // what an updated agent exiting to re-dial also looks like, and exactly
    // what a flap looks like. The tracker's no-op here is the tested posture;
    // the held/superseded branch below cannot be a disconnect at all, which
    // is why the call lives HERE and not above the identity guard.
    (deps.recordNodeDisconnect ?? recordNodeDisconnect)(nodeId);
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
