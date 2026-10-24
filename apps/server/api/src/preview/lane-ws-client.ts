import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { PREVIEW_LANE_BUFFER_MAX_BYTES, serviceAuthority } from "@internal/subshell-protocol";
import { readLaneHead } from "@/preview/lane-wire.js";
// Bun 1.4.2 ships a BUILT-IN module named `ws` that shadows the pinned
// dependency for any import of the bare name (measured: its `Sender`
// constructor throws "Not supported yet in Bun" on the first frame setup,
// and it is what silently ignored `createConnection` when the ws client was
// imported the normal way). The real package's files are reached by path so
// the shadow cannot intercept them; the ship file is the installed package's.
import ReceiverFile from "../../node_modules/ws/lib/receiver.js";
import SenderFile from "../../node_modules/ws/lib/sender.js";

/**
 * One WebSocket client spoken by hand over a lane duplex (spec 2026-10-21
 * §6's http-mode redial).
 *
 * The brief's plan was the `ws` client itself with its top-level
 * `createConnection` aimed at the lane. That option IS kept by ws
 * (`node_modules/ws/lib/websocket.js` lines 766-767), and Bun 1.4.2's
 * `node:http` client ignores it anyway (measured: the request dials
 * `host:port` itself and the duplex never sees a byte), so the full client
 * would tunnel plane-local loopback while believing it had used the lane.
 * What the client genuinely needs from ws is its frame codec, and ws ships
 * that as standalone classes: the handshake head is written and read here
 * (`lane-wire.ts`, which the HTTP half already trusts), and `ws`'s
 * `Receiver` (a Writable fed lane bytes) and `Sender` (framing onto the
 * duplex, masked because we are the client) do every frame after it. They
 * are imported by file path because Bun's built-in `ws` shadows the bare
 * name (see the import); `@types/ws` does not describe them, hence the
 * narrow structural cast below.
 *
 * What the handshake carries and why: `Host` is the literal loopback the
 * node dials (same vhost rule as `pv-http.ts`); the browser's `Origin` rides
 * along because a dev server that checks WS origins checks it against the
 * SAME value it checked for the page (the plane's own origin, which the
 * upgrade gate already vetted); `Sec-WebSocket-Protocol` is offered as the
 * browser offered it, and a target that picks one has its answer logged and
 * otherwise ignored (the browser's own negotiation already completed with
 * Bun, and every dialect in use here is single-protocol); `Cookie` comes
 * from the session jar, never the browser. No `Sec-WebSocket-Extensions`
 * offer: permessage-deflate stays entirely off the lane, and the browser
 * link's own compression is Bun's business alone.
 */

/** The RFC 6455 magic string the `Sec-WebSocket-Accept` hash folds in. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface FrameReceiver {
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "ping", listener: (data: Buffer) => void): void;
  on(event: "conclude", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close" | "finish", listener: () => void): void;
  write(chunk: Buffer): boolean;
  end(): void;
}

interface FrameSender {
  send(
    data: Buffer,
    options: { binary: boolean; fin: boolean; mask: boolean },
    cb?: (err?: Error | null) => void,
  ): void;
  close(code: number | undefined, data: Buffer | undefined, mask: boolean, cb?: (err?: Error | null) => void): void;
  pong(data: Buffer, mask: boolean, cb?: (err?: Error | null) => void): void;
}

/** The untyped-but-real framing classes; see the casts and the import comment. */
const Receiver = ReceiverFile as unknown as new (options: { isServer: false; maxPayload: number }) => FrameReceiver;
const Sender = SenderFile as unknown as new (socket: Duplex, extensions: Record<string, never>) => FrameSender;

/** The live end of a redialed WebSocket: what `pv-ws.ts` pumps frames through. */
export interface LaneWsHandle {
  /** One browser frame onward, masked. Text keeps its text opcode. */
  send(bytes: Buffer, isText: boolean): void;
  /**
   * Best-effort close frame before the lane dies. `undefined` code lets ws
   * pick 1005 (no status); a frame that cannot be written is irrelevant: the
   * lane close right behind it is the real news.
   */
  close(code: number | undefined, reason: string | undefined): void;
}

export interface LaneWsInit {
  /** The port the node dials; it rides the `Host` header only. */
  port: number;
  host?: string;
  /** Origin-form path + query, proxy prefix already stripped. */
  path: string;
  /** The browser-derived headers worth forwarding (origin, subprotocols). */
  headers: [string, string][];
  /** The upgrade answer's `Set-Cookie` values, for the session jar (spec §6). */
  onCookies(cookies: string[]): void;
  onMessage(data: Buffer, isBinary: boolean): void;
  /**
   * Once, after the 101, with the live handle: the callback is called
   * before the promise resolves, and frames parked while the handshake rode
   * the lane can only be flushed against a handle that already exists.
   */
  onOpen(handle: LaneWsHandle): void;
  /**
   * Once: the target refused the handshake, hung up, or framed something
   * broken. No reason word here on purpose: when the node volunteers a
   * better one through the lane, that word wins (`pv-ws.ts`'s guard), and
   * `target-gone` is what the caller says when nothing else does.
   */
  onDeath(): void;
}

/** Returned when the redial died at the handshake: every pump call is a no-op. */
const inertHandle: LaneWsHandle = {
  send() {
    /* dead */
  },
  close() {
    /* dead */
  },
};

/**
 * Dial the redial: write the upgrade head, await the answer on the lane,
 * and hand both directions to ws's framing classes. Rejects only for a
 * head the lane could not answer (a `LaneClosedError` from `lane-wire.ts`)
 * or a head that is not parseable; every OTHER refusal (a 404, a plain
 * 200 HTML page, a wrong accept) settles as `onDeath`, mirroring the ws
 * client's `unexpected-response`-then-close shape.
 */
export async function openLaneWebSocket(duplex: Duplex, init: LaneWsInit): Promise<LaneWsHandle> {
  const key = randomBytes(16).toString("base64");
  const lines = [
    `GET ${init.path} HTTP/1.1`,
    `host: ${serviceAuthority(init.host ?? "127.0.0.1", init.port)}`,
    "connection: upgrade",
    "upgrade: websocket",
  ];
  for (const [name, value] of init.headers) lines.push(`${name}: ${value}`);
  lines.push(`sec-websocket-key: ${key}`, "sec-websocket-version: 13");
  duplex.write(Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"));

  const head = await readLaneHead(duplex);
  const status = Number(head.statusLine.slice(9, 12));
  if (status !== 101) {
    init.onDeath();
    return inertHandle;
  }
  const accept = head.headers.find(([n]) => n === "sec-websocket-accept")?.[1];
  if (
    accept !==
    createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64")
  ) {
    init.onDeath();
    return inertHandle;
  }
  const cookies = head.headers.filter(([n]) => n === "set-cookie").map(([, v]) => v);
  if (cookies.length > 0) init.onCookies(cookies);

  const sender = new Sender(duplex, {});
  const receiver = new Receiver({ isServer: false, maxPayload: PREVIEW_LANE_BUFFER_MAX_BYTES });
  receiver.on("message", (data, isBinary) => init.onMessage(data, isBinary));
  receiver.on("ping", (data) => sender.pong(data, true));
  // `conclude` is ws's "a close frame arrived": the target is done talking.
  receiver.on("conclude", () => init.onDeath());
  receiver.on("error", () => init.onDeath());
  receiver.on("close", () => init.onDeath());
  // The head reader may have handed bytes that are already frames; feed
  // them before attaching the pipe so their order survives.
  if (head.tail.byteLength > 0) receiver.write(head.tail);
  // The cast is the structural one from the top of the file: ws's
  // Receiver IS a `stream.Writable` at runtime; the narrow interface only
  // names the events and `write` we use, and `pipe` wants the stream.
  duplex.pipe(receiver as unknown as NodeJS.WritableStream);

  const handle: LaneWsHandle = {
    send(bytes, isText) {
      sender.send(bytes, { binary: !isText, fin: true, mask: true });
    },
    close(code, reason) {
      try {
        sender.close(code, reason === undefined ? undefined : Buffer.from(reason, "utf8"), true, () => undefined);
      } catch {
        /* a frame that cannot be written is noise; the lane close is the news */
      }
    },
  };
  init.onOpen(handle);
  return handle;
}
