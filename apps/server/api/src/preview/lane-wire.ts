import type { Duplex } from "node:stream";
import type { PreviewCloseReason } from "@internal/subshell-protocol";

/**
 * The shared HTTP/1.1 head reader for the lane clients (`lane-http.ts`,
 * `lane-ws-client.ts`).
 *
 * On Bun 1.4.2 `node:http`'s `createConnection` option is IGNORED (measured:
 * with `agent: false`, with an agent carrying `createConnection`, and through
 * `ws`'s client, the request dials `host:port` itself every time, so
 * `LaneDuplex` never sees a byte). The lane therefore gets hand-spoken
 * HTTP/1.1: writing a request head is trivial; reading one back is this
 * file. It resolves on the first complete head (status line + headers + the
 * blank line) and hands the caller any bytes that arrived past the head,
 * because a WebSocket upgrade response and its first frames can coalesce
 * into one packet. Informational 1xx heads (the `103 Early Hints` a dev
 * server may send) are consumed and the read continues.
 */
export interface LaneHead {
  /** Raw status line, e.g. `HTTP/1.1 200 OK`. */
  statusLine: string;
  /** Header name is lowercased; multi-values kept as separate entries. */
  headers: [string, string][];
  /** Bytes read past the head's blank line, ready to hand to a body reader. */
  tail: Buffer;
}

/** The lane died before an answer head arrived. */
export class LaneClosedError extends Error {
  constructor(readonly reason: PreviewCloseReason | null) {
    super(reason ? `the lane closed (${reason})` : "the lane closed");
    this.name = "LaneClosedError";
  }
}

/** The far end wrote bytes that are not a usable HTTP/1.1 head. */
export class LaneProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneProtocolError";
  }
}

/** Max head bytes before the answer is refused (dev-server heads are far under it). */
const HEAD_MAX = 64 * 1024;

/**
 * Read one (or more, skipping 1xx) response head from a lane duplex.
 *
 * Rejects with `LaneClosedError` when the lane dies before the head lands,
 * and `LaneProtocolError` for a status line that is not HTTP/1.x or a head
 * past 64 KiB. Unsubscribes/tears listeners on any outcome; the caller owns
 * the duplex.
 */
export function readLaneHead(duplex: Duplex): Promise<LaneHead> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      acc = Buffer.concat([acc, chunk]);
      if (acc.byteLength > HEAD_MAX) {
        cleanup();
        reject(new LaneProtocolError("response head exceeds 64 KiB"));
        return;
      }
      const end = acc.indexOf("\r\n\r\n");
      if (end === -1) return;
      const headText = acc.subarray(0, end).toString("latin1");
      const tail = acc.subarray(end + 4);
      const lines = headText.split("\r\n");
      const parsed: [string, string][] = [];
      for (const line of lines.slice(1)) {
        if (line === "") continue;
        // `obs-fold` continuations (RFC 7230: a line starting with a space
        // or tab) fold into the previous value. No proxied dev server emits
        // them, but the parser handles them anyway, and the check runs
        // BEFORE the colon check because a real continuation line carries no
        // colon at all: checked after, it would be refused as malformed and
        // the fold branch could never fire.
        if (/^[ \t]/.test(line)) {
          if (parsed.length === 0) {
            cleanup();
            reject(new LaneProtocolError("folded header with no header to fold into"));
            return;
          }
          parsed[parsed.length - 1][1] += ` ${line.trim()}`;
          continue;
        }
        const colon = line.indexOf(":");
        if (colon === -1) {
          cleanup();
          reject(new LaneProtocolError("malformed response header line"));
          return;
        }
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        parsed.push([name, value]);
      }
      if (!/^HTTP\/1\.[01] \d{3}/.test(lines[0] ?? "")) {
        cleanup();
        reject(new LaneProtocolError(`bad status line ${JSON.stringify(lines[0]?.slice(0, 40))}`));
        return;
      }
      const status = Number(lines[0].slice(9, 12));
      // 101 is NOT informational here: it is a WebSocket upgrade's success
      // answer, and swallowing it would hang the redial forever.
      if (status >= 100 && status < 200 && status !== 101) {
        // Informational (103 Early Hints, 100 Continue): consume and keep reading.
        acc = tail;
        return;
      }
      cleanup();
      resolve({ statusLine: lines[0], headers: parsed, tail });
    };
    const onClosed = (): void => {
      cleanup();
      reject(
        new LaneClosedError((duplex as unknown as { closedReason?: PreviewCloseReason | null }).closedReason ?? null),
      );
    };
    const cleanup = (): void => {
      duplex.removeListener("data", onData);
      duplex.removeListener("close", onClosed);
    };
    duplex.on("data", onData);
    duplex.on("close", onClosed);
    // Bytes that already arrived (the common case on a local link where the
    // head lands in the same tick as the request write) sit in the Duplex's
    // internal buffer, unread while paused in paused mode. Reading here
    // starts flowing; if the head is already buffered, the next read emits
    // it synchronously.
    duplex.resume();
  });
}
