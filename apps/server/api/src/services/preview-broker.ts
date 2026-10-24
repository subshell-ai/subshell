import {
  type NodeCommandBody,
  type NodeEvent,
  type NodePreviewPortsResult,
  type NodePreviewScreenWire,
  PREVIEW_FORWARD_SESSIONS_PER_PANE,
  PREVIEW_FRAME_MAX_BYTES,
  PREVIEW_IDLE_MS,
  PREVIEW_LANE_QUEUE_MAX,
  PREVIEW_LIFETIME_MAX_MS,
  PREVIEW_STREAM_DEBT_MAX,
  PREVIEW_WATCH_SUBSCRIBERS_MAX,
  type PreviewCloseReason,
  type PreviewDataFrame,
  type PreviewStreamFrame,
  parseNodePreviewCloseResult,
  parseNodePreviewOpenResult,
  parseNodePreviewPortsResult,
  previewImageSizeAllowed,
} from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { type Access, accessAtLeast, loadSubshellAccess } from "@/lib/subshell-access.js";
import { getLocalPreviewRuntime, sweepLocalPreviewDisplays } from "@/preview/local-preview.js";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";
import { sendPreviewFrameOverNodeSocket } from "@/services/nodes/preview-frames.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The plane-side preview broker (pane-preview spec 2026-10-21 §5-§7).
 *
 * It owns everything the link carries but the link itself: forward sessions
 * and their byte lanes (§4), the one screencast bridge per pane with a
 * refcount of REST watchers (§6), the pane-keyed set of /ws/live sockets
 * entitled to frames, the launch-time display memory (§9), and the 5-second
 * ports cache. The shape is ssh-relay.service.ts's: a module singleton built
 * lazily over injectable seams, closes that recompute authorization rather
 * than diffing events, and an audit pair per SESSION-level close.
 *
 * What it is NOT: a gate. Routes and the live feed authorize (Task 9's REST
 * surface, Task 11's ws attach); the broker trusts the caller for `who` and
 * enforces only caps, refcounts, and revocation sweeps. And it imports
 * nothing from the `ws/` layer: the fan-out sender is INJECTED
 * (`configurePreviewStreamSender`, Task 11's wiring), because the broker must
 * stay testable without a socket and the /ws/live crossing belongs in
 * live-ws.ts.
 *
 * Refs are the one secret here: a session or lane ref IS the `/pv` path
 * credential (spec §6), minted from the CSPRNG and appearing nowhere else.
 * Unlike the relay's routing refs, it never rides an audit row, and every
 * `node.preview_*` metadata block carries pane/node/port/kind/reason instead.
 */

/* ------------------------------------------------------------------ */
/* refusals                                                            */
/* ------------------------------------------------------------------ */

/** Viewer-level refusals the broker itself raises (node refusals are NodeRpcError). */
export type PreviewRefusalCode =
  | "preview-lane-over-cap"
  | "preview-watch-over-cap"
  | "watch-port-conflict"
  | "preview-open-cancelled"
  | "preview-session-over-cap";

/**
 * A refusal raised by the broker's own caps, carrying the wire-stable code
 * Task 9 maps to HTTP (409 for `watch-port-conflict`, cap refusals to their
 * spec-named strings). Distinct from the bare word `over-cap`, which names
 * CLOSES (the sender's death), never refusals (spec §6's naming rule).
 */
export class PreviewRefusal extends Error {
  constructor(
    readonly code: PreviewRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewRefusal";
  }
}

/* ------------------------------------------------------------------ */
/* the socket seam (exported: Task 11 builds the real one)             */
/* ------------------------------------------------------------------ */

/**
 * What a stream recipient must offer. NOT the `ElysiaWS` wrapper: measured on
 * this repo's Elysia 1.4.29/Bun 1.4.2, the per-callback wrapper carries
 * neither a `bufferedAmount` property nor a `getBufferedAmount` method, while
 * the raw Bun socket carries the METHOD. Task 11 stores a two-member adapter
 * over `ws` + `ws.raw` (the `?? 0` read at remote-subshell-ws.ts:79 is that
 * precedent). An absent method reads as zero debt, which keeps frames
 * flowing for any other sendable object.
 */
export interface PreviewStreamSocket {
  send(data: string): unknown;
  getBufferedAmount?: () => number;
}

/**
 * The fan-out sender: it OWNS serialization (JSON.stringify is live-ws's
 * house, the broker stays frame-shaped), and it receives the frame built for
 * exactly one socket. Installed once at boot by Task 11
 * (`configurePreviewStreamSender`); an unconfigured broker never fans out.
 */
export type PreviewStreamSender = (socket: PreviewStreamSocket, frame: PreviewStreamFrame) => void;

/* ------------------------------------------------------------------ */
/* state shapes                                                        */
/* ------------------------------------------------------------------ */

/** One lane event: decoded bytes out, or the named death of the lane. */
export type PreviewLaneEvent = { bytes: Uint8Array } | { closed: PreviewCloseReason };

/** The per-subscriber callback shape (decision 2: keyed by LANE, not session). */
export type PreviewLaneCallback = (event: PreviewLaneEvent) => void;

/**
 * One duplex lane under a forward session. An iframe, an HMR socket, and
 * asset requests all hold lanes under ONE session, so subscriber sets live
 * here, not on the session: a session-keyed callback would pump one
 * connection's bytes into every duplex.
 */
export interface PreviewLane {
  /** The lane's 32-hex ref (the node-side lane id and the wire's lane key). */
  ref: string;
  /** The session this lane rides under. */
  sessionRef: string;
  /** Live subscribers; each connection adds and removes its own. */
  subscribers: Set<PreviewLaneCallback>;
}

/**
 * A live preview session: a forward lane-pool owner (`kind: "forward"`) or
 * the pane's one screencast bridge (`kind: "screencast"`).
 */
export interface PreviewSession {
  /** The 32-hex session ref (for forward, the PROBE ref: minted from the CSPRNG, this is the credential). */
  ref: string;
  /** Which preview surface this session fronts. */
  kind: "forward" | "screencast";
  /**
   * Discriminator for the proxy (decision 6): `raw` when the port is the
   * pane's registered screen `rfbPort` (bytes are RFB, no HTTP parsing),
   * `http` otherwise. Screencast bridges set `http` (they have no leg).
   */
  mode: "http" | "raw";
  /** The subshell whose pane this previews. */
  paneId: string;
  /** The node the lane/bridge was opened against. */
  nodeId: string;
  /** The target port (RFB port for raw, service port otherwise, CDP port for a bridge). */
  port: number;
  /** Who opened it (the forward tier holder that revocation re-asks). */
  createdBy: string;
  /** Epoch ms of the open (audit-time context; the sweeps use lastActivity). */
  createdAt: number;
  /** Lane ref -> lane. Forward sessions grow and shrink these. */
  lanes: Map<string, PreviewLane>;
  /**
   * REST watcher -> SUBSCRIPTION count, not a set: two tabs of one account
   * are two watchers, and a Set would let one tab's DELETE close the bridge
   * under its sibling's canvas.
   */
  viewers: Map<string, number>;
  /** Epoch ms of the last lane traffic (the idle sweep reads this; bridges ride refcount/lifetime, never traffic silence). */
  lastActivity: number;
  /**
   * Anchor for spec §6's per-session cookie jar. It lives HERE so it dies on
   * every session teardown path (this broker has all of them); its CONTENTS
   * are read and written only by Task 10's pv-http/pv-ws, which the broker
   * never calls into, and no wire type carries them.
   */
  cookieJar: Map<string, string>;
}

/** The verbs the routes, the ws feed, and the sweeps call (Tasks 9-11). */
interface PreviewOpenInput {
  viewerUserId: string;
  paneId: string;
  nodeId: string;
  port: number;
  /** The route rechecks current account/access after asynchronous node work. */
  authorize?: () => Promise<void>;
}

interface PendingPreviewOpen extends PreviewOpenInput {
  kind: "forward" | "screencast";
  cancelled?: PreviewCloseReason;
  registered?: boolean;
}

export interface PreviewBroker {
  /** Changes at every revocation, invalidating access reads already in flight. */
  streamAccessRevision(): number;
  openForward(input: PreviewOpenInput): Promise<{ ref: string }>;
  openLaneForConnection(sessionRef: string): Promise<{ laneRef: string }>;
  subscribeLane(laneRef: string, cb: PreviewLaneCallback): () => void;
  sendLaneBytes(laneRef: string, bytes: Uint8Array): void;
  closeLaneForConnection(laneRef: string, reason: PreviewCloseReason): Promise<void>;
  startWatch(input: PreviewOpenInput): Promise<{ ok: true }>;
  stopWatch(viewerUserId: string, paneId: string): Promise<{ ok: true }>;
  attachStream(
    paneId: string,
    socketKey: string,
    holderUserId: string,
    socket: PreviewStreamSocket,
  ): { ok: true } | { ok: false; code: "preview-stream-over-cap" };
  detachStream(paneId: string, socketKey: string): void;
  detachSocketsFor(socketKey: string): void;
  sessionFor(ref: string): PreviewSession | null;
  /** The pane's live screencast bridge, if any (tests and the feed read it by pane). */
  sessionForPane(paneId: string): PreviewSession | null;
  getPorts(nodeId: string, paneId: string): Promise<NodePreviewPortsResult>;
  onDisplayOpened(nodeId: string, paneId: string, screen: NodePreviewScreenWire): void;
  /**
   * The screen the plane remembers from this pane's launch ack, or null.
   * The ack names the display before the node's own ports scan reports it,
   * and Task 9's info route fills that window from here (a reported
   * `screenLost` still outranks the memory).
   */
  displayForPane(paneId: string): { nodeId: string; screen: NodePreviewScreenWire } | null;
  observeDisplay(nodeId: string, paneId: string, screen: NodePreviewScreenWire | null): void;
  onDisplayClosed(paneId: string, reason: PreviewCloseReason): Promise<void>;
  closeForPane(paneId: string, reason: PreviewCloseReason): Promise<void>;
  closeAllForNode(nodeId: string, reason: PreviewCloseReason): Promise<void>;
  /** Sweeps the user's forwards, watch counts, and held streams; answers how many SESSIONS it closed. */
  closeAllForUser(userId: string, reason: PreviewCloseReason): Promise<number>;
  closeUnauthorizedForPane(paneId: string): Promise<void>;
  onStreamEvent(nodeId: string, ev: Extract<NodeEvent, { type: "preview_stream" }>): void;
  onNodeLaneFrame(nodeId: string, frame: PreviewDataFrame): void;
  onNodeReportedClose(nodeId: string, ref: string, reason: PreviewCloseReason): Promise<void>;
  /** One idle pass over FORWARD sessions (the periodic timer runs it; tests drive it with a fake clock). */
  sweepIdle(): Promise<number>;
  /** Stops the sweep timer and clears all state (test isolation). */
  shutdown(): void;
}

/* ------------------------------------------------------------------ */
/* seams and the singleton                                             */
/* ------------------------------------------------------------------ */

/** The `getPorts` cache window (spec §6: 5 s, keyed by pane). */
export const PREVIEW_PORTS_CACHE_MS = 5_000;
export const PREVIEW_CAPABILITIES_PER_NODE = 64;
export const PREVIEW_PENDING_OPENS_PER_NODE = 32;
const PREVIEW_PORTS_CACHE_ENTRIES = 512;

/** How often the periodic idle sweep runs; tests call `sweepIdle()` directly. */
const PREVIEW_SWEEP_INTERVAL_MS = 60_000;

interface PreviewBrokerDeps {
  nowMs: () => number;
  /** The signed COMMAND path (open/close/ports), exactly sendCommand's contract. */
  send: (nodeId: string, cmd: NodeCommandBody) => Promise<unknown>;
  /** The byte-frame path (lane `in` legs), NOT the command path (preview-frames.ts). */
  linkSend: (nodeId: string, frame: PreviewDataFrame) => void;
  /** The shares resolver the revocation recompute asks per holder (production: the real one). */
  accessFor: (userId: string, paneId: string) => Promise<Access>;
  audit: (event: AuditEventInput) => Promise<void>;
  /** The fan-out sender; undefined means "not wired" and frames are never sent. */
  fanOut: PreviewStreamSender | undefined;
  log: (line: string) => void;
}

/** The access resolver's repos, built on first ask (never at import) and reused. */
let accessRepos: { subshells: SubshellsRepository; shares: SubshellSharesRepository } | undefined;

function productionDeps(): PreviewBrokerDeps {
  return {
    nowMs: () => Date.now(),
    send: async (nodeId, cmd) => {
      if (nodeId !== LOCAL_NODE_ID) return sendCommand(nodeId, cmd);
      await sweepLocalPreviewDisplays();
      return getLocalPreviewRuntime().execute(cmd, (event) => {
        const broker = getPreviewBroker();
        if (event.type === "preview_data") broker.onNodeLaneFrame(LOCAL_NODE_ID, event);
        else if (event.type === "preview_stream") broker.onStreamEvent(LOCAL_NODE_ID, event);
        else
          void broker
            .onNodeReportedClose(LOCAL_NODE_ID, event.ref, event.reason)
            .catch((err: unknown) => getLogger().warn(`Local preview teardown failed: ${String(err)}`));
      });
    },
    linkSend: (nodeId, frame) => {
      if (nodeId === LOCAL_NODE_ID) getLocalPreviewRuntime().forward.ingestInboundFrame(frame);
      else sendPreviewFrameOverNodeSocket(nodeId, frame);
    },
    // The repos are built directly (not through getRequestlessContext) so
    // this module never sits in the context <-> services import circle, and
    // once — they are stateless over `db`, and building them per ask was
    // pure allocation.
    accessFor: async (userId, paneId) => {
      accessRepos ??= { subshells: new SubshellsRepository(db), shares: new SubshellSharesRepository(db) };
      const { access } = await loadSubshellAccess(accessRepos, userId, paneId);
      return access;
    },
    audit,
    fanOut: productionStreamSender,
    log: (line) => getLogger().debug(line),
  };
}

/**
 * The production fan-out slot. One-shot by contract: Task 11's live-ws.ts
 * calls `configurePreviewStreamSender` once at boot (the singleton builds
 * lazily, so there is no construction site to inject at; a setter is the
 * seam that makes). `resetForTests` overrides it for the fake only.
 */
let productionStreamSender: PreviewStreamSender | undefined;

/** Installs the production fan-out sender (first call wins; tests use resetForTests). */
export function configurePreviewStreamSender(send: PreviewStreamSender): void {
  productionStreamSender ??= send;
}

let instance: PreviewBroker | undefined;

/** Returns the preview broker, building it lazily over the production seams. */
export function getPreviewBroker(): PreviewBroker {
  instance ??= buildPreviewBroker(productionDeps());
  return instance;
}

/**
 * Test seam: rebuilds the singleton over named seams (fake clock for the
 * idle sweep, fake command RPC, fake byte-frame path, fake access answers,
 * injected fan-out). With no argument it rebuilds over production seams. The
 * AUDIT seam stays real on purpose: the audit rows are half the contract, so
 * the fake writes them to the suite's migrated DB (Task 8's tests read them
 * back).
 */
export function resetForTests(seams?: {
  now?: () => number;
  send?: (nodeId: string, cmd: NodeCommandBody) => Promise<unknown>;
  linkSend?: (nodeId: string, frame: PreviewDataFrame) => void;
  accessFor?: (userId: string, paneId: string) => Promise<Access>;
  sendToSockets?: PreviewStreamSender;
}): void {
  instance?.shutdown();
  instance = undefined;
  const prod = productionDeps();
  const deps: PreviewBrokerDeps = {
    ...prod,
    ...(seams?.now ? { nowMs: seams.now } : {}),
    ...(seams?.send ? { send: seams.send } : {}),
    ...(seams?.linkSend ? { linkSend: seams.linkSend } : {}),
    ...(seams?.accessFor ? { accessFor: seams.accessFor } : {}),
    // An absent `sendToSockets` inherits the production slot (unset in tests
    // until something configures it): that is what "an unconfigured broker
    // never fans out" means here.
    fanOut: seams && "sendToSockets" in seams ? seams.sendToSockets : prod.fanOut,
  };
  instance = buildPreviewBroker(deps);
}

/** Drops the memoized instance entirely (builds nothing; pairs with resetForTests in suites that need a true blank). */
export function shutdownPreviewBrokerForTests(): void {
  instance?.shutdown();
  instance = undefined;
}

/**
 * The crash-case belt: close one pane's preview state from a death transition
 * that has no room to wait or to throw. Same shape as `closeRelayForPaneExit`
 * in ssh-relay.service.ts — fire-and-forget, every failure logged and none
 * re-raised — because a node whose pane just crashed may never answer the
 * lane closes, and a reconcile pass must keep walking rows whatever the
 * answer. The exit route's own awaited `closeForPane` is the fast path; this
 * is what stops forward lanes and browser stream sockets from outliving the
 * pane to the idle and lifetime caps when the hook report is lost. `closeForPane`
 * is idempotent, so route-and-belt together still audit exactly one close.
 */
export function closePreviewForPaneExit(paneId: string): void {
  try {
    void getPreviewBroker()
      .closeForPane(paneId, "pane-gone")
      .catch((err: unknown) => getLogger().warn(`preview teardown for pane ${paneId} failed: ${String(err)}`));
  } catch (err) {
    getLogger().warn(`preview teardown for pane ${paneId} threw before the close: ${String(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* the mint                                                            */
/* ------------------------------------------------------------------ */

/**
 * The session/lane ref: 128 bits from the CSPRNG, hex. This mint is the
 * credential (spec §10: "secret unguessability" is a property of HERE, not
 * of the format regex; a `Math.random()` hex still matches PREVIEW_REF_RE).
 */
function mintRef(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

/* ------------------------------------------------------------------ */
/* the broker                                                          */
/* ------------------------------------------------------------------ */

interface LaneRecord {
  lane: PreviewLane;
  session: PreviewSession;
  /**
   * True from the synchronous reservation until the node's ack: the cap and
   * the queue see the lane from before its `preview_open` is even sent
   * (review 2026-10-23). Nothing can address a pending lane externally —
   * its ref reaches callers only after the ack, and the node cannot name a
   * ref it has not acked — so `pending` guards no read path; it exists to
   * make the registration honest.
   */
  pending: boolean;
}

interface StreamEntry {
  socket: PreviewStreamSocket;
  holderUserId: string;
}

interface LaneWaiter {
  sessionRef: string;
  resolve: (answer: { laneRef: string }) => void;
  reject: (err: Error) => void;
}

function buildPreviewBroker(deps: PreviewBrokerDeps): PreviewBroker {
  const sessionsByRef = new Map<string, PreviewSession>();
  /** paneId -> the one screencast bridge's ref (spec §6: the watch is pane-keyed). */
  const bridgeRefByPane = new Map<string, string>();
  /** laneRef -> {lane, session}; the wire's lane key for both directions. */
  const lanesByRef = new Map<string, LaneRecord>();
  /** paneId -> socketKey -> entry. Keyed by the PER-CONNECTION id, NEVER socket identity (live-ws.ts's rule). */
  const streamsByPane = new Map<string, Map<string, StreamEntry>>();
  /** paneId -> the display the node reported at launch (the mac-leg fallback for `mode`). */
  const displaysByPane = new Map<string, { nodeId: string; screen: NodePreviewScreenWire }>();
  /** paneId -> cached `getPorts` answer (5 s window, spec §6). */
  const portsCache = new Map<string, { nodeId: string; at: number; answer: NodePreviewPortsResult }>();
  /** paneId -> queued lane requests beyond the per-pane cap (decision 2). */
  const laneWaitersByPane = new Map<string, LaneWaiter[]>();
  /**
   * paneId -> the flying zero->one bridge open (review 2026-10-23). One cold
   * open per pane may ever be in flight: concurrent startWatch callers await
   * the winner instead of each minting a bridge the last-set-wins map would
   * strand (an orphan no verb can reach and sweepIdle never walks). Cleared
   * when the chain settles either way, so a failed open is not sticky.
   */
  const watchOpeningByPane = new Map<string, Promise<PreviewSession>>();
  // Revocation must see opens before their node acknowledgement registers a session.
  const opening = new Set<PendingPreviewOpen>();
  let streamAccessRevision = 0;
  function cancelOpening(matches: (op: PendingPreviewOpen) => boolean, reason: PreviewCloseReason): void {
    for (const op of opening) if (matches(op)) op.cancelled = reason;
  }
  function checkOpening(op: PendingPreviewOpen): void {
    if (op.cancelled)
      throw new PreviewRefusal(
        "preview-open-cancelled",
        "Preview access changed while opening. Reopen it if you still have access.",
      );
  }
  async function authorizeOpening(op: PendingPreviewOpen): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkOpening(op);
      const revision = streamAccessRevision;
      await op.authorize?.();
      checkOpening(op);
      if (revision === streamAccessRevision) return;
    }
    throw new PreviewRefusal(
      "preview-open-cancelled",
      "Preview access changed while opening. Reopen it if you still have access.",
    );
  }
  async function withOpening<T>(
    input: PreviewOpenInput,
    kind: PendingPreviewOpen["kind"],
    run: (op: PendingPreviewOpen) => Promise<T>,
  ): Promise<T> {
    const pending = [...opening].filter((op) => op.nodeId === input.nodeId);
    if (pending.length >= PREVIEW_PENDING_OPENS_PER_NODE) {
      throw new PreviewRefusal(
        "preview-session-over-cap",
        "Too many previews are opening on this node. Wait for them to finish, then try again.",
      );
    }
    if (kind === "forward") {
      const retained = [...sessionsByRef.values()].filter(
        (session) => session.nodeId === input.nodeId && session.kind === "forward",
      ).length;
      const reserved = pending.filter((op) => op.kind === "forward" && !op.registered).length;
      if (retained + reserved >= PREVIEW_CAPABILITIES_PER_NODE) {
        throw new PreviewRefusal(
          "preview-session-over-cap",
          "Preview capacity on this node is full. Reuse an existing preview, or try again after inactive preview links expire.",
        );
      }
    }
    const op: PendingPreviewOpen = { ...input, kind };
    opening.add(op);
    try {
      return await run(op);
    } finally {
      opening.delete(op);
    }
  }

  const sweepTimer = setInterval(() => {
    void broker.sweepIdle().catch((err: unknown) => deps.log(`preview idle sweep failed: ${String(err)}`));
  }, PREVIEW_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  /**
   * Writes one `node.preview_*` row.
   *
   * The metadata deliberately OMITS the ref, diverging from the relay's
   * audit block (ssh-relay.service.ts:583 includes it because "a routing ref
   * is not a credential"): a preview session/lane ref IS the credential,
   * the `/pv` path secret, so it belongs in no row an operator can read
   * (spec §6). Byte content stays out the same way; only ids, port, kind,
   * reason, and counts ride.
   */
  async function auditPreview(action: string, nodeId: string | null, meta: Record<string, unknown>): Promise<void> {
    await deps.audit({
      actorUserId: null,
      action,
      targetType: "node",
      targetId: nodeId,
      metadataJson: JSON.stringify(meta),
    });
  }

  function laneCountForPane(paneId: string): number {
    let n = 0;
    for (const rec of lanesByRef.values()) if (rec.session.paneId === paneId) n += 1;
    return n;
  }

  async function sendPreviewClose(nodeId: string, ref: string, reason: PreviewCloseReason): Promise<void> {
    try {
      const data = await deps.send(nodeId, { type: "preview_close", ref, reason });
      parseNodePreviewCloseResult(data); // shape-checked; the ack's `closed` is advisory (the node forgot the ref either way)
    } catch (err) {
      // The close is a courtesy against a node that may already be gone (the
      // link-drop sweep reaps the rest). Loud in the debug log, never thrown
      // back into a sweep.
      deps.log(`preview_close ${reason} for ref on node ${nodeId} failed: ${String(err)}`);
    }
  }

  async function requestPreviewOpen(
    nodeId: string,
    command: Extract<NodeCommandBody, { type: "preview_open" }>,
  ): Promise<void> {
    try {
      const result = parseNodePreviewOpenResult(await deps.send(nodeId, command));
      if (!result || result.ref !== command.ref) {
        throw new Error("preview_open answered a shape or reference the grammar refuses");
      }
    } catch (err) {
      // Only an explicit refusal proves the node didn't open anything. A
      // lost or malformed reply still needs teardown for the allocated ref.
      if (!(err instanceof NodeRpcError && err.code === "failed")) {
        await sendPreviewClose(nodeId, command.ref, "viewer-left");
      }
      throw err;
    }
  }

  /** Removes the lane entry, notifies its subscribers, optionally tells the node, then frees a queue slot. */
  async function removeLane(rec: LaneRecord, reason: PreviewCloseReason, sendWire: boolean): Promise<void> {
    lanesByRef.delete(rec.lane.ref);
    rec.session.lanes.delete(rec.lane.ref);
    for (const cb of [...rec.lane.subscribers]) {
      rec.lane.subscribers.delete(cb);
      try {
        cb({ closed: reason });
      } catch (err) {
        deps.log(`preview lane subscriber threw on close: ${String(err)}`);
      }
    }
    if (sendWire) await sendPreviewClose(rec.session.nodeId, rec.lane.ref, reason);
    await dequeueWaiter(rec.session.paneId);
  }

  /** A freed lane slot goes to the pane's first still-living waiter. */
  async function dequeueWaiter(paneId: string): Promise<void> {
    const queue = laneWaitersByPane.get(paneId);
    if (!queue || queue.length === 0) return;
    if (laneCountForPane(paneId) >= PREVIEW_FORWARD_SESSIONS_PER_PANE) return;
    const waiter = queue.shift();
    if (!waiter) return;
    const session = sessionsByRef.get(waiter.sessionRef);
    if (!session) {
      // The session died while queued (the common case: its last connection
      // was the one that just closed). Reject rather than mint against a ref
      // nothing owns; later waiters get their turn on the next release.
      waiter.reject(new Error(`preview session ${waiter.sessionRef.slice(0, 8)}… closed while its lane was queued`));
      await dequeueWaiter(paneId);
      return;
    }
    try {
      waiter.resolve(await mintLane(session));
    } catch (err) {
      waiter.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Mints a fresh lane ref, OPENS it on the node, and flips the registration
   * live. The reservation is the load-bearing part (review 2026-10-23): the
   * placeholder lands in the very structures `laneCountForPane` counts BEFORE
   * the first await, so two concurrent callers can never both pass the cap
   * check and both spend a node slot; the second one queues instead. A
   * refusal releases through the same close path a real lane uses, so the
   * freed slot still promotes the pane's first waiter. The close reason on
   * the release is invisible (a placeholder has no subscribers yet); it says
   * `viewer-left` because the caller's promise rejecting IS the leaving.
   */
  async function mintLane(session: PreviewSession): Promise<{ laneRef: string }> {
    const laneRef = mintRef();
    const lane: PreviewLane = { ref: laneRef, sessionRef: session.ref, subscribers: new Set() };
    session.lanes.set(laneRef, lane);
    lanesByRef.set(laneRef, { lane, session, pending: true });
    try {
      await requestPreviewOpen(session.nodeId, {
        type: "preview_open",
        ref: laneRef,
        kind: "forward",
        paneId: session.paneId,
        port: session.port,
        lifetimeMs: PREVIEW_LIFETIME_MAX_MS,
      });
    } catch (err) {
      // requestPreviewOpen already closes uncertain node state. Releasing
      // this reservation only frees the server-side slot.
      const rec = lanesByRef.get(laneRef);
      if (rec) await removeLane(rec, "viewer-left", false);
      throw err;
    }
    const rec = lanesByRef.get(laneRef);
    if (!rec) {
      // The session died under the in-flight open (closeForwardSession walked
      // the placeholder away). A late node registration also needs an explicit
      // close: the earlier close could have arrived before it existed.
      await sendPreviewClose(session.nodeId, laneRef, "revoked");
      throw new Error(`preview session ${session.ref.slice(0, 8)}… closed while its lane was opening`);
    }
    rec.pending = false;
    session.lastActivity = deps.nowMs();
    return { laneRef };
  }

  function detachStreamEntries(paneId: string): void {
    // Drops the pane's stream set WITHOUT touching the sockets: the /ws/live
    // socket carries the whole feed and outlives a lost grant or a gone pane
    // (Task 11's matrix: "stops frames to that socket while the socket lives").
    streamsByPane.delete(paneId);
  }

  /** Tears down a forward session whole: lanes off the wire, waiters rejected, the pair audited. */
  async function closeForwardSession(session: PreviewSession, reason: PreviewCloseReason): Promise<void> {
    if (!sessionsByRef.has(session.ref)) return;
    sessionsByRef.delete(session.ref);
    // The session ref was the probe, closed on the node at open: the only
    // live node-side state under a forward session is its lanes, so each
    // lane's close is the wire work (and lane closes audit nothing; the
    // SESSION pair is the one row).
    const laneCloses = [...session.lanes.values()].map((lane) =>
      removeLane({ lane, session, pending: false }, reason, true).catch((err: unknown) =>
        deps.log(`preview lane close during sweep threw: ${String(err)}`),
      ),
    );
    await Promise.all(laneCloses);
    rejectWaitersFor(session.paneId, (w) => w.sessionRef === session.ref, new Error("preview session closed"));
    await auditPreview("node.preview_forward.close", session.nodeId, {
      paneId: session.paneId,
      nodeId: session.nodeId,
      port: session.port,
      kind: "forward",
      reason,
    });
  }

  /**
   * Tears down the pane's bridge: counts gone, sockets detached (never
   * closed), optionally told the node, the pair audited once per bridge
   * (not per watcher - that is the row's whole design).
   */
  async function closeWatchBridge(
    session: PreviewSession,
    reason: PreviewCloseReason,
    sendWire: boolean,
  ): Promise<void> {
    if (bridgeRefByPane.get(session.paneId) !== session.ref) return;
    bridgeRefByPane.delete(session.paneId);
    sessionsByRef.delete(session.ref);
    session.viewers.clear();
    detachStreamEntries(session.paneId);
    if (sendWire) await sendPreviewClose(session.nodeId, session.ref, reason);
    await auditPreview("node.preview_watch.close", session.nodeId, {
      paneId: session.paneId,
      nodeId: session.nodeId,
      port: session.port,
      kind: "screencast",
      reason,
    });
  }

  /** The live bridge's join path: true when the caller joined, refusal thrown by name. */
  function joinBridge({ viewerUserId, paneId, port }: { viewerUserId: string; paneId: string; port: number }): boolean {
    const bridgeRef = bridgeRefByPane.get(paneId);
    const bridge = bridgeRef ? sessionsByRef.get(bridgeRef) : undefined;
    if (!bridge) return false;
    if (bridge.port !== port) {
      // Two bridges on one pane would interleave on a channel with no
      // discriminator, and the pane-keyed stopWatch could not name the
      // right one. A matching port just joins.
      throw new PreviewRefusal(
        "watch-port-conflict",
        `this pane's screencast bridge is already watching port ${bridge.port}`,
      );
    }
    const sum = [...bridge.viewers.values()].reduce((a, b) => a + b, 0);
    if (sum + 1 > PREVIEW_WATCH_SUBSCRIBERS_MAX) {
      // PER BRIDGE (decision 7): a per-viewer cap would let one
      // account's 40 tabs sail past the limit the spec named.
      throw new PreviewRefusal(
        "preview-watch-over-cap",
        `this pane's screencast bridge already has ${PREVIEW_WATCH_SUBSCRIBERS_MAX} subscribers`,
      );
    }
    bridge.viewers.set(viewerUserId, (bridge.viewers.get(viewerUserId) ?? 0) + 1);
    bridge.lastActivity = deps.nowMs();
    return true;
  }

  /** The serialized zero->one edge: ask the node, register the bridge, audit the pair. */
  async function openBridge(
    {
      viewerUserId,
      paneId,
      nodeId,
      port,
    }: {
      viewerUserId: string;
      paneId: string;
      nodeId: string;
      port: number;
    },
    op: PendingPreviewOpen,
  ): Promise<PreviewSession> {
    if (1 > PREVIEW_WATCH_SUBSCRIBERS_MAX) {
      throw new PreviewRefusal("preview-watch-over-cap", "screencast subscribers cap below one");
    }
    const ref = mintRef();
    await requestPreviewOpen(nodeId, {
      type: "preview_open",
      ref,
      kind: "screencast",
      paneId,
      port,
      lifetimeMs: PREVIEW_LIFETIME_MAX_MS,
    });
    try {
      await authorizeOpening(op);
    } catch (err) {
      await sendPreviewClose(nodeId, ref, op.cancelled ?? "revoked");
      throw err;
    }
    // The ack's `subscribers` count is IGNORED: the bridge counts itself
    // (this broker owns the refcount; the node's number is advisory at best).
    const session: PreviewSession = {
      ref,
      kind: "screencast",
      mode: "http", // bridges have no leg; the member exists for the proxy's discriminator
      paneId,
      nodeId,
      port,
      createdBy: viewerUserId,
      createdAt: deps.nowMs(),
      lanes: new Map(),
      viewers: new Map([[viewerUserId, 1]]),
      lastActivity: deps.nowMs(),
      cookieJar: new Map(),
    };
    sessionsByRef.set(ref, session);
    bridgeRefByPane.set(paneId, ref);
    await auditPreview("node.preview_watch.open", nodeId, { paneId, nodeId, port, kind: "screencast" });
    return session;
  }

  function rejectWaitersFor(paneId: string, which: (w: LaneWaiter) => boolean, err: Error): void {
    const queue = laneWaitersByPane.get(paneId);
    if (!queue || queue.length === 0) return;
    const kept: LaneWaiter[] = [];
    for (const w of queue) {
      if (which(w)) w.reject(err);
      else kept.push(w);
    }
    if (kept.length === 0) laneWaitersByPane.delete(paneId);
    else laneWaitersByPane.set(paneId, kept);
  }

  /** The live screen record for `mode`: getPorts answer FIRST, launch memory second (decision 6). */
  async function resolveMode(nodeId: string, paneId: string, port: number): Promise<"http" | "raw"> {
    try {
      const answer = await broker.getPorts(nodeId, paneId);
      if (answer.screen && answer.screen.rfbPort === port) return "raw";
      // The screen exists but is not this port: `http`, decided (the memory
      // cannot disagree upward, and on the mac leg there is no memory).
      if (answer.screen) return "http";
    } catch (err) {
      deps.log(
        `preview getPorts refused during open (${paneId.slice(0, 8)}…): ${String(err)}; falling back to display memory`,
      );
    }
    const memory = displaysByPane.get(paneId);
    if (memory && memory.screen.rfbPort === port) return "raw";
    return "http";
  }

  function dropPortsCache(paneIds: Iterable<string>): void {
    for (const p of paneIds) portsCache.delete(p);
  }

  const broker: PreviewBroker = {
    streamAccessRevision: () => streamAccessRevision,
    async openForward(input) {
      return withOpening(input, "forward", async (op) => {
        const { viewerUserId, paneId, nodeId, port } = input;
        await authorizeOpening(op);
        const ref = mintRef();
        const mode = await resolveMode(nodeId, paneId, port);
        checkOpening(op);
        // The PROBE open (spec §5): validates the node will serve this pane at
        // all, and the refusal path records nothing and opens nothing. Every
        // preview_open rides the lifetime cap: the absolute ceiling is
        // belt-and-braces while refcount/idle/revoke are the real lifecycle,
        // and the value is named here so two executors cannot pick two.
        await requestPreviewOpen(nodeId, {
          type: "preview_open",
          ref,
          kind: "forward",
          paneId,
          port,
          lifetimeMs: PREVIEW_LIFETIME_MAX_MS,
        });
        await sendPreviewClose(nodeId, ref, op.cancelled ?? "viewer-left");
        await authorizeOpening(op);
        const session: PreviewSession = {
          ref,
          kind: "forward",
          mode,
          paneId,
          nodeId,
          port,
          createdBy: viewerUserId,
          createdAt: deps.nowMs(),
          lanes: new Map(),
          viewers: new Map(),
          lastActivity: deps.nowMs(),
          cookieJar: new Map(),
        };
        sessionsByRef.set(ref, session);
        op.registered = true;
        await auditPreview("node.preview_forward.open", nodeId, { paneId, nodeId, port, kind: "forward" });
        checkOpening(op);
        return { ref };
      });
    },

    async openLaneForConnection(sessionRef) {
      const session = sessionsByRef.get(sessionRef);
      if (!session) throw new Error(`no live preview session ${sessionRef.slice(0, 8)}… for a new lane`);
      if (session.kind !== "forward") throw new Error("preview lanes belong to forward sessions only");
      if (laneCountForPane(session.paneId) >= PREVIEW_FORWARD_SESSIONS_PER_PANE) {
        const queue = laneWaitersByPane.get(session.paneId) ?? [];
        if (queue.length >= PREVIEW_LANE_QUEUE_MAX) {
          throw new PreviewRefusal(
            "preview-lane-over-cap",
            `this pane already carries ${PREVIEW_FORWARD_SESSIONS_PER_PANE} preview lanes with ${PREVIEW_LANE_QUEUE_MAX} waiting; try again when one frees`,
          );
        }
        return new Promise<{ laneRef: string }>((resolve, reject) => {
          queue.push({ sessionRef, resolve, reject });
          laneWaitersByPane.set(session.paneId, queue);
        });
      }
      return mintLane(session);
    },

    subscribeLane(laneRef, cb) {
      const rec = lanesByRef.get(laneRef);
      if (!rec) return () => {};
      rec.lane.subscribers.add(cb);
      return () => {
        rec.lane.subscribers.delete(cb);
      };
    },

    sendLaneBytes(laneRef, bytes) {
      const rec = lanesByRef.get(laneRef);
      if (!rec) return; // the lane already died (the common race at teardown)
      if (bytes.byteLength > PREVIEW_FRAME_MAX_BYTES) {
        // The plane-side twin of the node's pump cap (spec §6): BOTH proxy
        // consumers funnel through this choke point, so an oversized HTTP
        // body chunk and an oversized browser WS message get the same named
        // death Task 1 pins from the receiver side. Nothing rides the link;
        // the LANE dies (the session survives it), and this is the ONE
        // lane-level audit row.
        void removeLane(rec, "over-cap", true)
          .catch((err: unknown) => deps.log(`preview over-cap lane close threw: ${String(err)}`))
          .then(() =>
            auditPreview("node.preview_lane.over_cap", rec.session.nodeId, {
              paneId: rec.session.paneId,
              nodeId: rec.session.nodeId,
              port: rec.session.port,
              kind: "forward",
              reason: "over-cap",
            }),
          )
          .catch((err: unknown) => deps.log(`preview over-cap audit threw: ${String(err)}`));
        return;
      }
      try {
        deps.linkSend(rec.session.nodeId, {
          type: "preview_data",
          ref: laneRef,
          dir: "in",
          blob: Buffer.from(bytes).toString("base64"),
        });
        rec.session.lastActivity = deps.nowMs();
      } catch (err) {
        // A dead link is not the sender's problem to resolve: the link-drop
        // sweep reaps this node's sessions named `node-dropped` (or the close
        // hook already did). Log, drop, and let the sweep own it.
        deps.log(`preview lane write dropped (link send threw): ${String(err)}`);
      }
    },

    async closeLaneForConnection(laneRef, reason) {
      const rec = lanesByRef.get(laneRef);
      if (!rec) return; // already gone (the one-shot response won the race to the idle sweep)
      await removeLane(rec, reason, true);
    },

    async startWatch(input) {
      return withOpening(input, "screencast", async (op) => {
        const { viewerUserId, paneId, nodeId, port } = input;
        await authorizeOpening(op);
        if (joinBridge({ viewerUserId, paneId, port })) return { ok: true };
        const flying = watchOpeningByPane.get(paneId);
        if (flying) {
          // The pane's one cold open is already flying (two tabs POSTed at
          // once): await the winner's ack, then take the join path against the
          // now-live bridge — port-conflict and the per-bridge cap apply to
          // the joiner exactly as to a late caller. If the open FAILED, the
          // rejection is this caller's honest answer too; the map entry is
          // already cleared, so the NEXT startWatch flies fresh.
          await flying;
          checkOpening(op);
          return broker.startWatch(input);
        }
        // Cold: this caller owns the open, and registering the bridge happens
        // inside the serialized chain — the race is gone because only one open
        // per pane ever flies (review 2026-10-23).
        const opening = openBridge({ viewerUserId, paneId, nodeId, port }, op);
        watchOpeningByPane.set(paneId, opening);
        try {
          await opening;
          checkOpening(op);
        } finally {
          watchOpeningByPane.delete(paneId);
        }
        return { ok: true } as const;
      });
    },

    async stopWatch(viewerUserId, paneId) {
      const bridgeRef = bridgeRefByPane.get(paneId);
      const bridge = bridgeRef ? sessionsByRef.get(bridgeRef) : undefined;
      if (!bridge) return { ok: true }; // REST DELETE is idempotent, and stays so after a node-reported teardown
      const count = bridge.viewers.get(viewerUserId) ?? 0;
      if (count <= 1) bridge.viewers.delete(viewerUserId);
      else bridge.viewers.set(viewerUserId, count - 1);
      // DECREMENT, never delete-key: one DELETE with two tabs open leaves
      // count 1 and the bridge alive.
      if (bridge.viewers.size === 0) await closeWatchBridge(bridge, "viewer-left", true);
      return { ok: true };
    },

    attachStream(paneId, socketKey, holderUserId, socket) {
      // The key is a PER-CONNECTION id the caller resolves from ws.data;
      // Elysia builds a fresh wrapper per callback, so socket identity is not
      // a style preference but dead code (live-ws.ts:36-42). The socket stays
      // the VALUE (its `send` reaches the shared raw).
      const map = streamsByPane.get(paneId) ?? new Map<string, StreamEntry>();
      if (!map.has(socketKey) && map.size >= PREVIEW_WATCH_SUBSCRIBERS_MAX) {
        // Refused AT ATTACH, answering a value, never throwing: the /ws/live
        // switch swallows it, the socket stays open, the ninth tab's
        // experience is the dark canvas, and this row is the operator's.
        void auditPreview("node.preview_watch.viewer_drop", null, { paneId, reason: "over-cap" }).catch(
          (err: unknown) => deps.log(`preview attach-cap audit threw: ${String(err)}`),
        );
        return { ok: false, code: "preview-stream-over-cap" };
      }
      map.set(socketKey, { socket, holderUserId });
      streamsByPane.set(paneId, map);
      return { ok: true };
    },

    detachStream(paneId, socketKey) {
      const map = streamsByPane.get(paneId);
      if (!map) return;
      map.delete(socketKey);
      if (map.size === 0) streamsByPane.delete(paneId);
    },

    detachSocketsFor(socketKey) {
      // The socket's `close` handler knows only the id (the wrapper it hands
      // Task 11 is not the wrapper it came in as), so the walk is by key.
      for (const [paneId, map] of [...streamsByPane]) {
        map.delete(socketKey);
        if (map.size === 0) streamsByPane.delete(paneId);
      }
    },

    sessionFor(ref) {
      return sessionsByRef.get(ref) ?? null;
    },

    sessionForPane(paneId) {
      const ref = bridgeRefByPane.get(paneId);
      return ref ? (sessionsByRef.get(ref) ?? null) : null;
    },

    async getPorts(nodeId, paneId) {
      const hit = portsCache.get(paneId);
      if (hit && hit.nodeId === nodeId && deps.nowMs() - hit.at < PREVIEW_PORTS_CACHE_MS) return hit.answer;
      // A node refusal (preview-ports-unsupported, offline, ...) REJECTS with
      // the named error rather than fabricating an empty answer; Task 9's
      // info route is what turns the rejection into `{ nodeEnabled, reason }`.
      const raw = await deps.send(nodeId, { type: "preview_ports_get", paneId });
      const answer = parseNodePreviewPortsResult(raw);
      if (answer === null) throw new Error("preview_ports_get answered a shape the grammar refuses");
      if (!portsCache.has(paneId) && portsCache.size >= PREVIEW_PORTS_CACHE_ENTRIES) {
        const oldest = portsCache.keys().next().value;
        if (oldest !== undefined) portsCache.delete(oldest);
      }
      portsCache.set(paneId, { nodeId, at: deps.nowMs(), answer });
      return answer;
    },

    onDisplayOpened(nodeId, paneId, screen) {
      displaysByPane.set(paneId, { nodeId, screen });
      void auditPreview("node.preview_display.open", nodeId, { paneId, nodeId, ...screen }).catch((err: unknown) =>
        deps.log(`preview display-open audit threw: ${String(err)}`),
      );
    },

    observeDisplay(nodeId, paneId, screen) {
      if (screen) displaysByPane.set(paneId, { nodeId, screen });
      else displaysByPane.delete(paneId);
    },

    displayForPane(paneId) {
      return displaysByPane.get(paneId) ?? null;
    },

    async onDisplayClosed(paneId, reason) {
      const entry = displaysByPane.get(paneId);
      if (!entry) return; // double-close is idempotent; a pane that never displayed audits nothing
      displaysByPane.delete(paneId);
      await auditPreview("node.preview_display.close", entry.nodeId, {
        paneId,
        nodeId: entry.nodeId,
        ...entry.screen,
        reason,
      });
    },

    async closeForPane(paneId, reason) {
      streamAccessRevision++;
      cancelOpening((op) => op.paneId === paneId, reason);
      for (const session of [...sessionsByRef.values()]) {
        if (session.paneId !== paneId) continue;
        if (session.kind === "forward") await closeForwardSession(session, reason);
        else await closeWatchBridge(session, reason, true);
      }
      detachStreamEntries(paneId);
      await broker.onDisplayClosed(paneId, reason);
      dropPortsCache([paneId]);
      rejectWaitersFor(paneId, () => true, new Error(`preview pane ${paneId.slice(0, 8)}… closed`));
    },

    async closeAllForNode(nodeId, reason) {
      streamAccessRevision++;
      cancelOpening((op) => op.nodeId === nodeId, reason);
      const panesTouched = new Set<string>();
      for (const session of [...sessionsByRef.values()]) {
        if (session.nodeId !== nodeId) continue;
        panesTouched.add(session.paneId);
        if (session.kind === "forward") await closeForwardSession(session, reason);
        else await closeWatchBridge(session, reason, true);
      }
      for (const [paneId, display] of [...displaysByPane]) {
        if (display.nodeId !== nodeId) continue;
        await broker.onDisplayClosed(paneId, reason);
      }
      // Forward panes with attached sockets but no bridge still lose their
      // sockets: nothing on this node can ever feed them again.
      for (const paneId of panesTouched) detachStreamEntries(paneId);
      dropPortsCache(panesTouched);
    },

    async closeAllForUser(userId, reason) {
      streamAccessRevision++;
      cancelOpening((op) => op.viewerUserId === userId, reason);
      let closed = 0;
      for (const session of [...sessionsByRef.values()]) {
        if (session.kind === "forward") {
          if (session.createdBy === userId) {
            await closeForwardSession(session, reason);
            closed += 1;
          }
          continue;
        }
        if (!session.viewers.has(userId)) continue;
        session.viewers.delete(userId);
        if (session.viewers.size === 0) {
          await closeWatchBridge(session, reason, true);
          closed += 1;
        }
      }
      for (const [paneId, map] of [...streamsByPane]) {
        for (const [socketKey, entry] of [...map]) {
          if (entry.holderUserId === userId) map.delete(socketKey);
        }
        if (map.size === 0) streamsByPane.delete(paneId);
      }
      return closed;
    },

    async closeUnauthorizedForPane(paneId) {
      streamAccessRevision++;
      // THE shares cut. Riding the relay's recompute posture (spec §6 names
      // it): re-ask authorization per holder from THIS broker's own state,
      // never diff the event that triggered the recompute. One verb covers
      // removal, the edit->view downgrade, and the Everyone row's level
      // change, because `loadSubshellAccess` already folds the NULL-grantee
      // row into what each holder resolves to - a per-grantee diff keyed on
      // named users would miss the row that reaches everybody.
      const asked = new Map<string, Access>();
      const access = async (userId: string): Promise<Access> => {
        const cached = asked.get(userId);
        if (cached) return cached;
        const a = await deps.accessFor(userId, paneId);
        asked.set(userId, a);
        return a;
      };
      for (const op of [...opening]) {
        if (
          op.paneId === paneId &&
          !accessAtLeast(await access(op.viewerUserId), op.kind === "forward" ? "edit" : "view")
        )
          op.cancelled = "revoked";
      }
      for (const session of [...sessionsByRef.values()]) {
        if (session.paneId !== paneId) continue;
        if (session.kind === "forward") {
          // Below EDIT closes the whole session (lanes included) named
          // `revoked`: an edit->view grantee loses ONLY the edit tier.
          if (!accessAtLeast(await access(session.createdBy), "edit")) {
            await closeForwardSession(session, "revoked");
          }
          continue;
        }
        // Watchers and stream holders below VIEW drop; a bridge emptied by
        // revocation closes `revoked`, not `viewer-left` (the audit names
        // what actually ended it).
        for (const viewer of [...session.viewers.keys()]) {
          if (!accessAtLeast(await access(viewer), "view")) session.viewers.delete(viewer);
        }
        if (session.viewers.size === 0) await closeWatchBridge(session, "revoked", true);
      }
      // Stream sockets are PANE-keyed, not session-keyed: a pane can hold
      // attached sockets with no bridge alive (the node reported the bridge
      // closed; the sockets ride until something feeds them again). So this
      // walk runs for EVERY shares write on the pane, forward-only included —
      // pane-complete by construction, harmless when empty.
      const map = streamsByPane.get(paneId);
      if (map) {
        for (const [socketKey, entry] of [...map]) {
          if (!accessAtLeast(await access(entry.holderUserId), "view")) map.delete(socketKey);
        }
        if (map.size === 0) streamsByPane.delete(paneId);
      }
    },

    onStreamEvent(nodeId, ev) {
      if (!previewImageSizeAllowed(ev.w, ev.h, ev.blob)) return;
      const session = sessionsByRef.get(ev.ref);
      if (session?.kind !== "screencast" || session.nodeId !== nodeId) return; // foreign node's bridge, or a lane ref, or gone
      const map = streamsByPane.get(session.paneId);
      if (!map || map.size === 0) return;
      const send = deps.fanOut;
      if (!send) return; // never wired: an unconfigured broker never fans out
      // The frame is pane-keyed and carries NO ref: the ref never crosses to
      // the browser (spec §6; §8's frame type from the protocol package).
      const frame: PreviewStreamFrame = {
        type: "preview-stream",
        id: session.paneId,
        seq: ev.seq,
        w: ev.w,
        h: ev.h,
        blob: ev.blob,
      };
      for (const [socketKey, entry] of [...map]) {
        // The METHOD (never a property) over the raw socket, read through the
        // adapter's `?? 0`: spec §9 drops slow VIEWERS, never the bridge.
        const debt = entry.socket.getBufferedAmount?.() ?? 0;
        if (debt > PREVIEW_STREAM_DEBT_MAX) {
          map.delete(socketKey);
          // The row explains a dark canvas: which node, which port, which
          // kind, why. (The attach-cap row above keeps what it has — at that
          // point no session has even been consulted.)
          void auditPreview("node.preview_watch.viewer_drop", session.nodeId, {
            paneId: session.paneId,
            nodeId: session.nodeId,
            port: session.port,
            kind: "screencast",
            reason: "slow-link",
          }).catch((err: unknown) => deps.log(`preview slow-link drop audit threw: ${String(err)}`));
          continue;
        }
        try {
          send(entry.socket, frame);
        } catch (err) {
          deps.log(`preview fan-out threw for one socket: ${String(err)}`);
        }
      }
      if (map.size === 0) streamsByPane.delete(session.paneId);
    },

    onNodeLaneFrame(nodeId, frame) {
      const rec = lanesByRef.get(frame.ref);
      if (!rec || rec.session.nodeId !== nodeId) return; // the socket's node is the fence
      if (frame.dir !== "out") return; // the plane owns the `in` leg; a node pushing one is nonsense
      rec.session.lastActivity = deps.nowMs();
      const bytes = new Uint8Array(Buffer.from(frame.blob, "base64"));
      for (const cb of rec.lane.subscribers) {
        try {
          cb({ bytes });
        } catch (err) {
          deps.log(`preview lane subscriber threw on bytes: ${String(err)}`);
        }
      }
    },

    async onNodeReportedClose(nodeId, ref, reason) {
      // The node volunteering a death it observed (plan decision 3): a lane,
      // a bridge, or a stray. The plane's own closes need no report, so
      // whatever arrives here names state the node tore down machine-side.
      const rec = lanesByRef.get(ref);
      if (rec) {
        if (rec.session.nodeId !== nodeId) return;
        // A NODE-reported lane close stays WIRE-ONLY: spec §9's actions are
        // the plane's own acts, and the reason word already reaches the
        // viewer on the wire. No audit row, no second preview_close.
        await removeLane(rec, reason, false);
        return;
      }
      const session = sessionsByRef.get(ref);
      if (!session) {
        deps.log(`preview_closed for unknown ref ${ref.slice(0, 8)}… on node ${nodeId} (${reason})`);
        return;
      }
      if (session.nodeId !== nodeId) return;
      if (session.kind !== "screencast") {
        // A forward SESSION ref was closed by us at probe time; a report
        // naming one is stale. Its lanes, if any are still registered, were
        // not named by the node (lane refs are distinct).
        deps.log(`preview_closed naming a forward session ref on node ${nodeId} (${reason}); ignoring`);
        return;
      }
      // The bridge's twin: tear the plane's half down WITH it, so the next
      // startWatch hits the zero->one edge and re-sends preview_open ("a
      // matching port just joins" may only ever join a LIVE bridge).
      await closeWatchBridge(session, reason, false);
    },

    async sweepIdle() {
      let closed = 0;
      const now = deps.nowMs();
      for (const session of [...sessionsByRef.values()]) {
        // FORWARD sessions only. The constant's own JSDoc names a forward
        // lane; a screencast bridge's life is refcount, revocation, the
        // node-reported close, and the node's lifetime event - never
        // plane-side traffic silence (a watched static page produces zero
        // frames by definition).
        if (session.kind !== "forward") continue;
        if (now - session.lastActivity < PREVIEW_IDLE_MS) continue;
        await closeForwardSession(session, "idle");
        closed += 1;
      }
      return closed;
    },

    shutdown() {
      streamAccessRevision++;
      cancelOpening(() => true, "node-dropped");
      clearInterval(sweepTimer);
      sessionsByRef.clear();
      bridgeRefByPane.clear();
      watchOpeningByPane.clear(); // the chains die with the instance they were flying on
      lanesByRef.clear();
      streamsByPane.clear();
      displaysByPane.clear();
      portsCache.clear();
      for (const queue of laneWaitersByPane.values()) {
        for (const w of queue) w.reject(new Error("preview broker reset"));
      }
      laneWaitersByPane.clear();
    },
  };

  return broker;
}
