import { Duplex } from "node:stream";
import type { PreviewCloseReason } from "@internal/subshell-protocol";

/** One delivery from a broker lane: bytes, or the named reason the lane died. */
export type LaneEvent = { bytes: Uint8Array } | { closed: PreviewCloseReason };

/** What a LaneDuplex needs to stand in for a TCP socket on one broker lane. */
export interface LaneDuplexDeps {
  /** Ship bytes toward the pane-side target (the proxy: `sendLaneBytes`). */
  writeOut(bytes: Uint8Array): void;
  /** Receive lane deliveries; returns the unsubscriber. */
  onLane(cb: (event: LaneEvent) => void): () => void;
}

/**
 * A Node `Duplex` whose far end is a broker preview lane rather than a TCP
 * socket, so a stream consumer can speak over a lane. It would also be the
 * socket a `createConnection`-style transport plugged in, except Bun's
 * `node:http` client silently IGNORES that option (measured on 1.4.2: the
 * request dials `host:port` itself with the option set, so the duplex never
 * sees a byte); the proxy therefore speaks its protocols over this class
 * directly (`lane-http.ts`, `lane-ws-client.ts`).
 *
 * The broker's lane delivery is a firehose (a Set of subscribers, no
 * pause/resume), so `push` is unconditional and the Duplex's internal buffer
 * absorbs a slow consumer; the flow limit that matters sits on the node,
 * which pumps a lane only as fast as its own socket drains. A lane `closed`
 * ends the read side with `push(null)` (FIN semantics), never an `Error`:
 * the reason WORD is what the proxy needs, and it reads it from
 * `closedReason`, not from an exception that would flatten every death into
 * one error.
 */
export class LaneDuplex extends Duplex {
  /** The lane's close reason once the lane has closed; null while it lives. */
  closedReason: PreviewCloseReason | null = null;

  private readonly deps: LaneDuplexDeps;
  private readonly unsubscribe: () => void;

  constructor(deps: LaneDuplexDeps) {
    // Half-open stays closed: when the lane reports `closed` the read side
    // ends, and the writable side ending with it (the default) is what makes
    // the stream's `close` event fire, which is how `lane-wire.ts` and
    // `streamBody` learn the far end is gone.
    super();
    this.deps = deps;
    this.unsubscribe = deps.onLane((event) => {
      if ("closed" in event) {
        this.closedReason = event.closed;
        this.push(null);
        return;
      }
      this.push(Buffer.from(event.bytes));
    });
  }

  // Public because `node:stream`'s types declare these overrides public; a
  // `protected` one fails Liskov substitution even though nothing outside
  // a stream should ever call them.
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.deps.writeOut(chunk);
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _read(_size: number): void {
    // The firehose above pushes whenever the lane delivers; `_read` exists
    // only because Duplex requires one.
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.unsubscribe();
    callback(error);
  }
}
