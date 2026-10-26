import { PREVIEW_LANE_BUFFER_MAX_BYTES, type PreviewCloseReason } from "@internal/subshell-protocol";
import { Elysia } from "elysia";
import { jarCookieHeader, storeCookiesInJar } from "@/api/previews/http.js";
import { browserOriginAllowed } from "@/modules/network/browser-origin.js";
import { LaneDuplex } from "@/modules/previews/lane-duplex.js";
import { type LaneWsHandle, openLaneWebSocket } from "@/modules/previews/lane-ws-client.js";
import { getPreviewBroker, PreviewRefusal, type PreviewSession } from "@/modules/previews/preview-broker.js";
import { HttpError } from "@/shared/errors.js";

/**
 * The WS half of the `/pv/<ref>/...` proxy (pane-preview spec 2026-10-21 §6),
 * mounted on the SAME wildcard the HTTP half serves (`pv-http.ts`): Elysia
 * dispatches an upgrade GET to the `.ws()` route and plain GETs to the plain
 * routes (spike-verified for one dynamic pattern across two modules).
 *
 * The session ref in the path authorized this upgrade already (spec §10), so
 * any suffix is the tunnel root: noVNC dials its own path and Vite's HMR
 * dials its own. Gates run at UPGRADE (before any socket exists, the /ws
 * doctrine): `browserOriginAllowed` from `@/modules/network/browser-origin.js` (PR #424:
 * a foreign browser Origin is refused, a missing Origin is a non-browser
 * client and passes, registry origins pass; an exact plane-origin equality
 * would break a dashboard reached over a published Tailscale/NetBird
 * address), then the session lookup, then the broker's per-pane lane cap. A
 * queue-overflow refusal answers `503` carrying `preview-lane-over-cap` as
 * an HTTP status, never a hang or a socket that dies later.
 *
 * Two modes, because one pump cannot serve both consumers (decision 6):
 * `raw` websockify-pumps frame payloads straight onto the lane for a raw TCP
 * target (x11vnc would read an HTTP upgrade as a bogus RFB version), while
 * `http` REDIALS a real WebSocket handshake aimed at the lane. The brief's
 * shape here was the `ws` client's top-level `createConnection` option,
 * which ws itself does keep (`node_modules/ws/lib/websocket.js` lines
 * 766-767) but Bun 1.4.2's `node:http` client IGNORES (measured: the request
 * dials `host:port` itself and the lane sees no byte), so the redial rides
 * `lane-ws-client.ts` instead: the handshake spoken here, ws's own
 * `Receiver`/`Sender` doing the frames. It carries the jar's cookies and
 * captures the target's upgrade response `Set-Cookie` into the same jar.
 *
 * Close words reach the user, not only the audit: anything except the
 * viewer's own leaving closes the browser socket `1011` with the
 * `PreviewCloseReason` verbatim in the reason field (there is no "server
 * policy" close code, and every word in the set fits the 123-byte limit),
 * so Task 13's disconnect handling reads `revoked`/`pane-gone`/`target-gone`
 * off the close event.
 *
 * A text-frame caveat worth stating because it is the one byte-exactness
 * exception, and the shapes Elysia's `.ws()` parser leaves behind are the
 * ones `message` below has to sort out: a text frame that looks like JSON
 * arrives parsed, so one with significant whitespace rides re-stringified
 * (semantics kept, whitespace not); a text frame like `123`, `true`, or
 * `null` arrives as the coerced primitive and rides on as its string form;
 * plain strings, binary frames, and the dev-server dialects that matter
 * (Vite HMR's compact JSON, VNC's binary) ride exact. Being fully raw would
 * mean a hand-rolled `server.upgrade` route, which is a design change from
 * the `.ws()` mount the brief registers, not a line to quietly take.
 */

/** One live browser↔lane tunnel, stashed on `ws.data` at upgrade (socket identity is not state). */
interface PvTunnel {
  sessionRef: string;
  laneRef: string;
  mode: "http" | "raw";
  port: number;
  /** Suffix + query the browser dialed (http-mode redial path; raw ignores it). */
  rest: string;
  search: string;
  /** Browser headers the redial re-offers (origin, subprotocols); raw ignores it. */
  forward: [string, string][];
  session: PreviewSession;
  /** The browser side, filled in `open` (the upgrade ran before it existed). */
  ws?: { close: (code?: number, reason?: string) => void };
  /** http mode: the redialed target end, filled when the 101 lands. */
  handle?: LaneWsHandle;
  duplex?: LaneDuplex;
  unsub: () => void;
  /** http mode: the redial handshake has not completed yet. */
  pending: boolean;
  /** browser frames waiting on that handshake, and their running byte total. */
  queue: { text: boolean; bytes: Buffer }[];
  queuedBytes: number;
  closed: boolean;
}

const DEAD_LINK = "This preview link is no longer valid. Reopen the preview to get a fresh one.";

// The return type is left to inference: `.ws()` deepens the instance type, and an
// explicit `Elysia` annotation on the way out makes `server.ts` reject `.use()`
// on a variance the builder guarantees.
export function previewWsRoute(options: { preAckMaxBytes?: number } = {}) {
  // The seam the tests drive small: the same doctrine as Task 5's
  // `laneBufferMaxBytes`. Past this much browser bytes parked while the
  // target-side handshake has not completed, the link is not a slow link,
  // it is a dead one, and spec §6's no-phantom-success says say so.
  const preAckMax = options.preAckMaxBytes ?? PREVIEW_LANE_BUFFER_MAX_BYTES;

  /**
   * The single teardown: one owner, one reason word, both ends closed.
   *
   * `from` says who died: `browser` (their close or unmount: the lane gets
   * `viewer-left`, the browser socket needs no explanation), `lane` (the
   * node already named the death; re-closing the lane is not ours to do),
   * `target` (the far end hung up or refused before the lane said anything;
   * we own the lane and the honest word is `target-gone`). Everyone but the
   * browser gets `1011` + the word verbatim: there is no "server policy"
   * close code, and the word is the contract Task 13 renders.
   */
  function teardown(t: PvTunnel, reason: PreviewCloseReason, from: "browser" | "lane" | "target"): void {
    if (t.closed) return;
    t.closed = true;
    t.queue.length = 0;
    t.queuedBytes = 0;
    // A close frame before the lane dies: best-effort courtesy, a frame
    // that cannot be written is noise under the lane close right behind it.
    t.handle?.close(undefined, undefined);
    t.unsub();
    t.duplex?.destroy();
    if (from !== "lane") {
      void getPreviewBroker()
        .closeLaneForConnection(t.laneRef, from === "browser" ? "viewer-left" : reason)
        .catch(() => undefined);
    }
    try {
      if (from === "browser") t.ws?.close();
      else if (reason === "viewer-left") t.ws?.close(1000, "viewer-left");
      else t.ws?.close(1011, reason);
    } catch {
      /* the browser socket is already gone; the lane close was the point */
    }
  }

  return new Elysia({ name: "pv-ws" }).ws("/pv/:session/*", {
    async upgrade(context) {
      const { request, params } = context as { request: Request; params: Record<string, string> };
      // Sandboxed preview documents have an opaque Origin. This exception
      // belongs only to capability-bound preview tunnels, never dashboard WS.
      if (request.headers.get("origin") !== "null" && !browserOriginAllowed(request)) {
        throw new HttpError(403, "This request came from an untrusted origin.");
      }
      const broker = getPreviewBroker();
      const session = broker.sessionFor(params.session);
      if (!session) throw new HttpError(404, DEAD_LINK);
      let laneRef: string;
      try {
        // AWAITED here, before the socket: the cap decision is the upgrade's
        // answer, so the SPA sees a named 503 instead of a dying connection.
        ({ laneRef } = await broker.openLaneForConnection(params.session));
      } catch (err) {
        if (err instanceof PreviewRefusal) {
          throw new HttpError(
            503,
            `${err.code}: this pane is already carrying too many preview lanes. Try again once one closes.`,
          );
        }
        throw err;
      }
      const url = new URL(request.url);
      // The two browser headers worth re-offering on the redial: a
      // dev server that checks WS origins sees the same value it vetted
      // against the page (the plane origin the gate just passed), and a
      // dialect that names its subprotocols gets them offered. The
      // answer-back pick is ignored, not negotiated again: the browser's
      // own negotiation already completed with Bun.
      const forward: [string, string][] = [];
      const originHeader = request.headers.get("origin");
      if (originHeader) forward.push(["origin", originHeader]);
      const protocols = request.headers.get("sec-websocket-protocol");
      if (protocols) forward.push(["sec-websocket-protocol", protocols]);
      Object.assign(context as Record<string, unknown>, {
        pv: {
          sessionRef: session.ref,
          laneRef,
          mode: session.mode,
          port: session.port,
          rest: params["*"] ?? "",
          search: url.search,
          forward,
          session,
          unsub: () => undefined,
          pending: session.mode === "http",
          queue: [],
          queuedBytes: 0,
          closed: false,
        } satisfies PvTunnel,
      });
    },
    open(ws) {
      const t = (ws.data as unknown as { pv: PvTunnel }).pv;
      t.ws = ws;
      const broker = getPreviewBroker();
      if (t.mode === "raw") {
        // Raw mode: lane bytes out ARE binary frames, payloads verbatim,
        // nothing HTTP about it (spec §5's blind pump, exactly right for
        // RFB and exactly wrong for a target that is itself a WS server).
        t.unsub = broker.subscribeLane(t.laneRef, (event) => {
          if ("closed" in event) {
            teardown(t, event.closed, "lane");
            return;
          }
          if (t.closed) return;
          if (
            (ws.raw as unknown as { getBufferedAmount(): number }).getBufferedAmount() + event.bytes.byteLength >
            PREVIEW_LANE_BUFFER_MAX_BYTES
          ) {
            teardown(t, "slow-link", "target");
            return;
          }
          try {
            ws.send(Buffer.from(event.bytes));
          } catch {
            /* the browser socket is racing its own close */
          }
        });
        return;
      }

      // http mode subscribes the LaneDuplex FIRST, before anything else can
      // lose a byte: a separate "watch for closed" subscriber opened ahead of
      // the duplex would swallow out-bytes in the gap. The duplex owns the
      // lane subscription; its close event (with `closedReason`) is the lane
      // death signal.
      const duplex = new LaneDuplex({
        writeOut: (bytes) => broker.sendLaneBytes(t.laneRef, bytes),
        onLane: (cb) => broker.subscribeLane(t.laneRef, cb),
      });
      t.duplex = duplex;
      t.unsub = () => duplex.destroy();
      duplex.on("close", () => {
        const word = duplex.closedReason;
        if (word && !t.closed) teardown(t, word, "lane");
      });
      duplex.on("error", () => {
        if (!t.closed) teardown(t, "target-gone", "target");
      });
      const targetDied = (): void => {
        // The target hung up or refused the handshake. When the node
        // volunteers a better word (`target-gone` via the lane), the guard
        // keeps this path from overwriting it; when it never does (a refusal
        // answering a WS dial), `target-gone` is still the honest word:
        // nothing on the far end speaks WS.
        if (!t.closed) teardown(t, "target-gone", "target");
      };
      const jarCookie = jarCookieHeader(t.session.cookieJar);
      const redial = openLaneWebSocket(duplex, {
        host: t.session.service?.host,
        port: t.port,
        path: `/${t.rest}${t.search}`,
        headers: jarCookie ? [...t.forward, ["cookie", jarCookie]] : t.forward,
        onCookies: (cookies) => {
          // Spec §6's jar sentence is unqualified: an upgrade-set cookie
          // rides the session like an HTTP-lane one. (No Path rewrite here:
          // the browser never sees this handshake.)
          storeCookiesInJar(t.session.cookieJar, cookies);
        },
        onMessage: (data, isBinary) => {
          if (t.closed) return;
          if (
            (ws.raw as unknown as { getBufferedAmount(): number }).getBufferedAmount() + data.byteLength >
            PREVIEW_LANE_BUFFER_MAX_BYTES
          ) {
            teardown(t, "slow-link", "target");
            return;
          }
          try {
            ws.send(isBinary ? data : data.toString("utf8"));
          } catch {
            /* browser racing its close; the close handler reaps the lane */
          }
        },
        onOpen: (handle) => {
          if (t.closed) return;
          t.handle = handle;
          t.pending = false;
          for (const frame of t.queue.splice(0)) {
            t.queuedBytes -= frame.bytes.byteLength;
            handle.send(frame.bytes, frame.text);
          }
        },
        onDeath: targetDied,
      });
      // A head the lane never answered (LaneClosedError from the wire
      // reader) is a death like any other; the lane's own close event may
      // well have run first, and the guards make the double-call harmless.
      void redial.catch(targetDied);
    },
    message(ws, message) {
      const t = (ws.data as unknown as { pv: PvTunnel }).pv;
      if (t.closed) return;
      // Elysia's parser hands the frame over in whatever shape its coercion
      // left it, and the shape decides both the bytes and the frame type
      // back out. A string rides verbatim. A coerced PRIMITIVE (the parser
      // turns "123" into 123, "true" into true, "null" into null) rides as
      // text in its string form: the target receives the bare digits or
      // word it would receive unwrapped, which is reversible. A parsed JSON
      // object can only ride re-stringified: semantics kept, whitespace
      // not. Anything buffer-shaped rides byte-exact as binary.
      let bytes: Buffer;
      let text: boolean;
      if (typeof message === "string") {
        bytes = Buffer.from(message);
        text = true;
      } else if (message === null || typeof message !== "object") {
        bytes = Buffer.from(String(message));
        text = true;
      } else if (Buffer.isBuffer(message)) {
        bytes = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
        text = false;
      } else if (ArrayBuffer.isView(message)) {
        // isView, not a duck-check of the key names: a text frame whose whole
        // JSON content happens to pair `buffer` and `byteOffset` parses to a
        // plain object, and the duck would read the JSON values as view
        // offsets and destroy the frame.
        const view = message as ArrayBufferView;
        bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
        text = false;
      } else {
        bytes = Buffer.from(JSON.stringify(message));
        text = true;
      }
      if (bytes.byteLength > PREVIEW_LANE_BUFFER_MAX_BYTES) {
        teardown(t, "over-cap", "target");
        return;
      }
      if (t.mode === "raw") {
        getPreviewBroker().sendLaneBytes(t.laneRef, bytes);
        return;
      }
      if (!t.pending && t.handle) {
        t.handle.send(bytes, text);
        return;
      }
      // Pre-ack window: the redial handshake has not completed. Park, but
      // never park past the budget: spec §6 refuses phantom success. The
      // teardown carries the named death to the browser (1011 `slow-link`).
      t.queue.push({ text, bytes });
      t.queuedBytes += bytes.byteLength;
      if (t.queuedBytes > preAckMax) teardown(t, "slow-link", "target");
    },
    close(ws) {
      const t = (ws.data as unknown as { pv: PvTunnel }).pv;
      teardown(t, "viewer-left", "browser");
    },
  });
}
