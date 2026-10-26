import type { Duplex } from "node:stream";
import { PREVIEW_LANE_BUFFER_MAX_BYTES } from "@internal/subshell-protocol";
import { LaneClosedError, LaneProtocolError, readLaneHead } from "@/preview/lane-wire.js";

/**
 * One HTTP/1.1 request over a preview lane duplex, and its streamed answer
 * (spec 2026-10-21 §6's HTTP half).
 *
 * This is hand-spoken because Bun's `node:http` client ignores
 * `createConnection` (measured on 1.4.2 in three shapes: top-level option,
 * `agent: false`, and through the `ws` client's socket override; the request
 * dials `host:port` itself every time). A proxy whose transport is silently
 * bypassed is worse than one that fails loudly, so the lane gets bytes
 * written to it directly. The lane IS a TCP stream (the node pumps it to the
 * target's loopback socket), so the wire format spoken here is exactly what
 * a vhost-aware dev server expects to see.
 */

export interface LaneRequestInit {
  method: string;
  /** Origin form including the query, already stripped of the proxy prefix. */
  path: string;
  /**
   * Header pairs, already transformed (no `host`, no `content-length`, no
   * `transfer-encoding`, no `connection` family, no browser `cookie`: this
   * function frames the body with its own `transfer-encoding: chunked` so
   * streaming bodies cannot disagree with a content length the proxy cannot
   * verify against the browser's stream.
   */
  headers: [string, string][];
  /** The browser's body stream, chunk-encoded toward the target; null for none. */
  body: ReadableStream<Uint8Array> | null;
}

export interface LaneResponse {
  status: number;
  statusText: string;
  /** Raw target answer, NOT hop-by-hop filtered and NOT rewritten: pv-http does that. */
  headers: [string, string][];
  /** Decoded body (chunked folded out); null when the request was HEAD. */
  body: ReadableStream<Uint8Array> | null;
}

/** Serialize the head, then pump the body chunk-encoded; the head is one write. */
function writeRequest(duplex: Duplex, init: LaneRequestInit): void {
  const lines = [`${init.method} ${init.path} HTTP/1.1`];
  for (const [name, value] of init.headers) lines.push(`${name}: ${value}`);
  if (init.body) lines.push("transfer-encoding: chunked");
  duplex.write(Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"));
  const body = init.body;
  if (!body) return;
  const pump = async (): Promise<void> => {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (duplex.destroyed) {
          await reader.cancel();
          return;
        }
        if (value.byteLength === 0) continue;
        duplex.write(Buffer.from(`${value.byteLength.toString(16)}\r\n`, "latin1"));
        duplex.write(Buffer.from(value));
        duplex.write(Buffer.from("\r\n", "latin1"));
      }
    } catch {
      // Never turn an interrupted upload into a valid, shorter request.
      duplex.destroy();
      return;
    } finally {
      reader.releaseLock();
    }
    duplex.write(Buffer.from("0\r\n\r\n", "latin1"));
  };
  void pump();
}

/**
 * Drive the body-framing reader and resolve as soon as the head is known.
 *
 * Framing rules, in the order a conforming HTTP/1.1 reader applies them: a
 * `chunked` transfer-encoding wins; else `content-length` bytes; else the
 * body runs to EOF. A 204/304 has no body whatever the headers say, and a
 * HEAD answer never has one.
 */
function streamBody(
  duplex: Duplex,
  headers: [string, string][],
  tail: Buffer,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  let mode: "chunked" | "length" | "eof";
  let remaining = 0;
  const transfer = headers.find(([n]) => n === "transfer-encoding")?.[1]?.toLowerCase() ?? "";
  const lengthRaw = headers.find(([n]) => n === "content-length")?.[1];
  if (transfer.includes("chunked")) mode = "chunked";
  else if (lengthRaw !== undefined && /^\d+$/.test(lengthRaw)) {
    mode = "length";
    remaining = Number(lengthRaw);
  } else mode = "eof"; // the close-delimited body of a connection: close answer

  let acc: Buffer = tail;
  let done = false;
  let chunkEnd = false;
  let chunkSize: number | null = null; // current chunked part; null = awaiting size line
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const finish = (): void => {
    if (done) return;
    done = true;
    duplex.removeListener("data", onData);
    duplex.removeListener("close", onClose);
    onDone();
    try {
      controller?.close();
    } catch {
      /* consumer already gone */
    }
  };
  const emit = (bytes: Buffer): void => {
    if (bytes.byteLength > (controller?.desiredSize ?? 0)) {
      fail("preview response exceeded the slow-reader buffer limit");
      return;
    }
    try {
      controller?.enqueue(new Uint8Array(bytes));
    } catch {
      /* consumer already gone; the lane close path will still run */
    }
  };
  const onData = (incoming: Buffer): void => {
    acc = acc.byteLength === 0 ? incoming : Buffer.concat([acc, incoming]);
    while (!done) {
      if (mode === "eof") {
        // Read to EOF means there is no framing: hand everything to the
        // consumer and let the lane close be the terminator.
        if (acc.byteLength > 0) {
          emit(acc);
          acc = Buffer.alloc(0);
        }
        return;
      }
      if (mode === "length") {
        if (remaining === 0) {
          finish();
          return;
        }
        const take = Math.min(remaining, acc.byteLength);
        if (take > 0) {
          emit(acc.subarray(0, take));
          acc = acc.subarray(take);
          remaining -= take;
        }
        if (remaining === 0) finish();
        return;
      }
      // Stream chunk data as it arrives; a declared chunk size never reserves memory.
      if (chunkEnd) {
        if (acc.byteLength < 2) return;
        if (acc[0] !== 13 || acc[1] !== 10) {
          fail("malformed chunk terminator");
          return;
        }
        acc = acc.subarray(2);
        chunkEnd = false;
      }
      if (chunkSize === null) {
        const eol = acc.indexOf("\r\n");
        if (eol > 8192 || (eol === -1 && acc.byteLength > 8192)) {
          fail("chunk size line exceeds 8 KiB");
          return;
        }
        if (eol === -1) return;
        const sizeLine = acc.subarray(0, eol).toString("latin1").split(";")[0] ?? "";
        const size = Number.parseInt(sizeLine.trim(), 16);
        acc = acc.subarray(eol + 2);
        if (!/^[0-9a-f]+$/i.test(sizeLine) || !Number.isSafeInteger(size)) {
          fail("malformed chunk size");
          return;
        }
        if (size === 0) {
          // Trailers until the blank line; consuming them header-by-header
          // would need a second parser, and every server we proxy sends bare
          // `0\r\n\r\n`. Take the blank line and call it done; any bytes past
          // it belong to a pipelined answer this one-shot lane will never read.
          finish();
          return;
        }
        chunkSize = size;
        continue;
      }
      const take = Math.min(chunkSize, acc.byteLength);
      if (take > 0) emit(acc.subarray(0, take));
      acc = acc.subarray(take);
      chunkSize -= take;
      if (chunkSize > 0) return;
      chunkSize = null;
      chunkEnd = true;
    }
  };
  const onClose = (): void => {
    // A truncated body is an error, not a complete response. This never
    // retries the request: a POST may already have changed the target.
    acc = Buffer.alloc(0);
    if (mode !== "eof" && !done) fail("preview response ended before its body was complete");
    else finish();
  };
  const fail = (message: string): void => {
    if (done) return;
    done = true;
    duplex.removeListener("data", onData);
    duplex.removeListener("close", onClose);
    onDone();
    try {
      controller?.error(new LaneProtocolError(message));
    } catch {
      /* consumer already gone */
    }
  };
  duplex.on("data", onData);
  duplex.on("close", onClose);
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      cancel() {
        acc = Buffer.alloc(0);
        finish();
      },
    },
    { highWaterMark: PREVIEW_LANE_BUFFER_MAX_BYTES, size: (bytes) => bytes?.byteLength ?? 0 },
  );
  if (mode === "length" && remaining === 0) finish();
  // The head reader handed us bytes past the head: drive the machine once so
  // they are not stranded in `acc` until the next arrival.
  else if (acc.byteLength > 0) onData(Buffer.alloc(0));
  return stream;
}

/**
 * Send one request on a lane duplex and resolve on the response head.
 * `requestIsHead` answers a HEAD request with the head only: the target's
 * framing would describe a body this response must not carry, and a 204/304
 * has no body whatever its headers say. `onBodyDone` runs once the body
 * reader finishes, fails, or sees the lane die, and once immediately for the
 * no-body cases: the caller owns lane release and must see exactly one call
 * for every request.
 */
export async function sendLaneRequest(
  duplex: Duplex,
  init: LaneRequestInit,
  requestIsHead: boolean,
  onBodyDone: () => void,
): Promise<LaneResponse> {
  writeRequest(duplex, init);
  const head = await readLaneHead(duplex);
  const status = Number(head.statusLine.slice(9, 12));
  const statusText = head.statusLine.slice(13).trim();
  const noBody = requestIsHead || status === 204 || status === 304;
  const body = noBody ? null : streamBody(duplex, head.headers, head.tail, onBodyDone);
  if (noBody) onBodyDone();
  return { status, statusText, headers: head.headers, body };
}

export { LaneClosedError, LaneProtocolError };
