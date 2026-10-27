import { type FSWatcher, watch } from "node:fs";
import { captureToTerminalText } from "@/api/ws/capture-text.js";
import type { PaneSource } from "@/api/ws/pane-stream.js";
import { SyncStreamStripper } from "@/api/ws/sync-stripper.js";
import type { NodeLauncher } from "@/modules/nodes/node-launcher.js";
import type { RemoteLauncher } from "@/modules/nodes/remote-launcher.js";
import { logger } from "@/shared/logger.js";

/**
 * How often the pane log is re-read for new bytes.
 *
 * This is the PRIMARY delivery path, not a safety net, and its interval is the
 * latency a person feels when they type: the pane echoes a keystroke into the
 * log, and nothing ships it until the next poll. The `fs.watch` beside it is an
 * optimization that cannot be relied on — measured on bun 1.4.2 / macOS, a
 * watch on a file appended by ANOTHER process (which is what tmux `pipe-pane`
 * is: `sh -c 'cat >> log'`) fired 0/10 in one run and 1/3 in another, while
 * the same watch reports in-process writes reliably. At the old 1000ms
 * "backstop" that made every keystroke land 698ms late, every sample within
 * 2ms of the rest.
 *
 * 50ms costs one `stat` per poll per ATTACHED pane — 9.4µs measured, so
 * ~0.19ms of work per second per pane, and the pump exists only while somebody
 * is watching. That is a price worth paying twenty times a second for a
 * terminal that feels live.
 */
export const TAIL_POLL_MS = 50;

/** How often the capture fallback re-reads the pane. */
export const PANE_POLL_MS = 300;

/** What a source needs to read a subshell's replay log. */
export interface LogTailSourceOptions {
  /** Absolute path of the pipe-pane replay log. */
  logFile: string;
  /**
   * Byte offset the stream starts from.
   *
   * The attach samples this BEFORE it resizes the pane, so the snapshot and
   * the stream deliberately OVERLAP — see the JOIN-POINT RULE in
   * `subshell-ws.ts`. A gap is unrecoverable for a diff-rendering TUI; an
   * overlap heals on the next frame.
   */
  fromByte: number;
  /** Called once per emitted chunk, for the lastOutputAt heartbeat. */
  onOutput?: () => void;
}

/**
 * Streams new appends to a subshell's replay log.
 *
 * Event-driven: `fs.watch` fires the moment pipe-pane appends, so a
 * keystroke's echo arrives immediately instead of waiting out a poll
 * interval. The interval remains only as a backstop for watch events the OS
 * drops; both paths share one size-based read, so delivery is identical
 * either way.
 *
 * The decoder and the sync stripper are STREAM-lived, not per-viewer: a
 * multi-byte character or a DEC 2026 marker split across two reads must be
 * held until its other half arrives, and per-viewer copies of that state
 * would each see only part of the file and burn the split bytes to U+FFFD.
 * This is one of the reasons the pump is shared rather than duplicated.
 *
 * @param options - Log file, start offset, and the output heartbeat
 * @returns A source for {@link import("./pane-stream.js").PaneStreamRegistry}
 */
export function createLogTailSource(options: LogTailSourceOptions): PaneSource {
  return {
    start(emit) {
      let lastSize = options.fromByte;
      // Watch events and the backstop can land together; `pumping`/`again`
      // serialize the reads so a byte is never sliced twice.
      let pumping = false;
      let again = false;
      let stopped = false;
      const decoder = new TextDecoder();
      const stripper = new SyncStreamStripper();

      const pump = async (): Promise<void> => {
        if (pumping) {
          again = true;
          return;
        }
        pumping = true;
        do {
          again = false;
          try {
            const size = (await Bun.file(options.logFile).stat()).size;
            if (size > lastSize) {
              const buf = await Bun.file(options.logFile).slice(lastSize, size).arrayBuffer();
              lastSize = size;
              const text = stripper.push(decoder.decode(buf, { stream: true }));
              // Empty when the whole read was a held marker prefix or a false
              // sync marker: nothing paintable, so nothing to send or persist.
              if (!text) continue;
              if (stopped) break; // disposed mid-read; the bytes are the next stream's
              emit(text);
              options.onOutput?.();
            }
          } catch {
            // file gone
          }
        } while (again && !stopped);
        pumping = false;
      };

      let watcher: FSWatcher | null = null;
      try {
        watcher = watch(options.logFile, () => void pump());
        // If the inode dies the watcher is dead weight; the poll delivers.
        watcher.on("error", () => {
          watcher?.close();
          watcher = null;
        });
      } catch {
        watcher = null;
      }
      const timer = setInterval(() => void pump(), TAIL_POLL_MS);
      void pump(); // ship anything written between the offset and the attach

      return () => {
        stopped = true;
        stripper.flush(); // held partial-sequence bytes belong to the next stream
        watcher?.close();
        clearInterval(timer);
      };
    },
  };
}

/** What the capture fallback needs to poll a pane. */
export interface PanePollSourceOptions {
  /** Machine handle for the pane. */
  launcher: NodeLauncher;
  /** tmux socket. */
  socket: string;
  /** Subshell id. */
  subshellId: string;
  /** Called once per emitted chunk, for the lastOutputAt heartbeat. */
  onOutput?: () => void;
}

/**
 * Fallback for a subshell with no replay log: polls `capture-pane` and emits
 * whatever grew since the last read.
 *
 * The WHOLE capture is normalized before diffing, not the delta: the rows
 * need CRLF re-termination like any capture text (see `capture-text.ts`), and
 * stripping markers over the full string also catches one straddling the
 * boundary between what was already sent and what is new.
 *
 * Content only — this path cannot carry the cursor restore. A whole-grid
 * re-print (any non-prefix change: scroll, repaint) ends with the client's
 * cursor after the last painted row, so on a pane whose log never shows the
 * browser caret can sit below the visible prompt even though every character
 * is right. Degraded, not broken, and the attach's replay + `pane_cursor`
 * still fixed the BASE — this is the narrow fallback, not the stream.
 *
 * @param options - Launcher, pane handles, and the output heartbeat
 * @returns A source for {@link import("./pane-stream.js").PaneStreamRegistry}
 */
export function createPanePollSource(options: PanePollSourceOptions): PaneSource {
  return {
    start(emit) {
      let last = "";
      let stopped = false;

      const poll = async (): Promise<void> => {
        try {
          // Join like the replay: this stream is a viewer's BASE paint (no log
          // file means no byte source), and flattened wraps would strand the
          // same broken links and copied-in newlines the replay fix removes.
          const out = captureToTerminalText(
            await options.launcher.capture(options.socket, options.subshellId, undefined, true),
          );
          if (out === last) return;
          const delta = out.startsWith(last) ? out.slice(last.length) : out;
          last = out;
          if (!delta || stopped) return;
          emit(delta);
          options.onOutput?.();
        } catch {
          // subshell dead
        }
      };

      const timer = setInterval(() => void poll(), PANE_POLL_MS);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}

/** How often the remote tail's watchdog asks the node for the log's size. */
export const TAIL_STALL_CHECK_MS = 10_000;

/**
 * How long a pump may stay silent while the log it tails has moved before
 * the watchdog calls it dead. Comfortably above every honest delay on the
 * path (the agent polls every 50 ms, and `tail_start` itself times out at
 * 10 s), so it fires on a broken relay, never on a slow one.
 */
export const TAIL_STALL_AFTER_MS = 25_000;

/** What a source needs to tail a subshell running on a remote node. */
export interface RemoteTailSourceOptions {
  /** The node's launcher — the relay to the agent that owns the pane. */
  launcher: RemoteLauncher;
  /** Subshell id. */
  subshellId: string;
  /**
   * Byte offset the stream starts from — the FIRST viewer's pre-resize
   * sample. Later joiners never rewind the pump: their own replay already
   * carries the history, and re-playing the tail over a fresh capture is what
   * painted mid-stream redraw sequences into the snapshot.
   */
  fromByte: number;
  /** Called once per emitted chunk, for the lastOutputAt heartbeat. */
  onOutput?: () => void;
  /**
   * Fires exactly once when this pump can no longer deliver: the agent
   * refused `tail_start`, or the watchdog caught the pane's log growing
   * while the pump sat silent. The attach path needs this because the
   * registry builds ONE pump per subshell, for its first viewer: a source
   * that dies quietly becomes the permanent view of that pane, handed to
   * every later re-attach as long as any viewer lingers (a phone tab does
   * for hours). The honest recovery is to drop the whole stream so the next
   * attach builds a fresh pump, not to let a corpse stream paint replays.
   */
  onDead?: (reason: string) => void;
  /** Watchdog period; a test seam over {@link TAIL_STALL_CHECK_MS}. */
  stallCheckMs?: number;
  /** Silence that reads as a stall; a test seam over {@link TAIL_STALL_AFTER_MS}. */
  stallAfterMs?: number;
}

/**
 * Streams a node-hosted subshell's pane output over the agent relay.
 *
 * The remote twin of {@link createLogTailSource}, and it exists for the same
 * reason: `NodeLauncher`'s contract forbids overlapping per-subshell pumps,
 * because even serialized dispatch can flip the read-your-writes order two
 * tails rely on between their own successive calls. Two viewers each running
 * `tailStart` on one pane is exactly that — two independent dup-clamp and
 * backfill states over one byte stream, so each device can observe a
 * different order and neither is authoritative.
 *
 * `tailStart` is async while {@link PaneSource.start} is not, so the disposer
 * returned here closes over a promise: a stream torn down before the
 * round-trip lands still stops, because the late resolution finds `stopped`
 * and disposes immediately.
 *
 * Decoder and stripper are STREAM-lived for the same reason as the local
 * twin — a multi-byte character or a DEC 2026 marker split across two reads
 * must be held until its other half arrives.
 *
 * Because the pump outlives the attach that built it, it carries its own
 * liveness: a refused `tail_start` and a watchdog verdict (the log's size
 * moves while zero bytes arrive for {@link TAIL_STALL_AFTER_MS}) both report
 * the pump dead through {@link RemoteTailSourceOptions.onDead} rather than
 * going silent. That silence was the 2026-10-27 stuck-pane incident: one
 * dead source stayed every viewer's terminal for two hours because nothing
 * on the plane could notice.
 *
 * @param options - Launcher, subshell, start offset, output heartbeat, and
 *   the dead-pump report
 * @returns A source for {@link import("./pane-stream.js").PaneStreamRegistry}
 */
export function createRemoteTailSource(options: RemoteTailSourceOptions): PaneSource {
  return {
    start(emit) {
      const decoder = new TextDecoder();
      const stripper = new SyncStreamStripper();
      const checkMs = options.stallCheckMs ?? TAIL_STALL_CHECK_MS;
      const afterMs = options.stallAfterMs ?? TAIL_STALL_AFTER_MS;
      let stopped = false;
      let dispose: (() => void) | undefined;
      let reported = false;
      // What the launcher's relay has handed this source, and when. Both are
      // the watchdog's evidence: the cursor is what the pane has not yet
      // shown us past, and the timestamp is how long the silence has run.
      let cursor = options.fromByte;
      let lastDeliveryAt = Date.now();
      let probeInFlight = false;

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        clearInterval(watchdog);
        dispose?.();
      };

      const reportDead = (reason: string): void => {
        if (reported || stopped) return;
        reported = true;
        logger.warn(`remote tail dead for subshell ${options.subshellId}: ${reason}; dropping its viewers`);
        stop(); // a source that cannot produce must not stay the pane's stream
        options.onDead?.(reason);
      };

      const watchdog = setInterval(() => {
        if (stopped || reported || probeInFlight) return;
        // A pump that delivered recently needs no witness; a streaming pane
        // pays nothing beyond the bookkeeping inside onChunk.
        if (Date.now() - lastDeliveryAt < afterMs) return;
        probeInFlight = true;
        void options.launcher
          .readLogSized(options.subshellId, 0, 1)
          .then(({ size }) => {
            probeInFlight = false;
            if (stopped || reported) return;
            if (size === cursor) return; // a quiet pane is not a dead pump
            reportDead(`stalled: EOF ${size}, delivered ${cursor}, silent ${Date.now() - lastDeliveryAt}ms`);
          })
          .catch(() => {
            // A failing probe is link trouble, not a stalled tail: a lost
            // node socket is closed out-of-band, its viewers with it, so the
            // watchdog must never burn a healthy pump over a transient RPC
            // failure on the way back.
            probeInFlight = false;
          });
      }, checkMs);
      watchdog.unref?.(); // a tail must never hold the process open on its own

      void options.launcher
        .tailStart(options.subshellId, crypto.randomUUID(), options.fromByte, (bytes, next) => {
          if (stopped) return;
          cursor = next;
          lastDeliveryAt = Date.now();
          const text = stripper.push(decoder.decode(bytes, { stream: true }));
          if (!text) return; // nothing paintable yet — the whole read is held
          emit(text);
          options.onOutput?.();
        })
        .then((disposer) => {
          dispose = disposer;
          if (stopped) disposer(); // torn down during the tail_start round-trip
        })
        .catch((err: unknown) => {
          // The relay refused. This used to read as "a source that never
          // produces is the honest outcome"; with one pump per subshell,
          // inherited by every re-attach, that honesty was a pane frozen
          // until the server restarted. Report it, and let the viewers
          // rebuild the stream from a fresh join point.
          reportDead(`tail_start refused: ${err instanceof Error ? err.message : String(err)}`);
        });

      return () => {
        stopped = true;
        stripper.flush(); // held partial-sequence bytes belong to the next stream
        clearInterval(watchdog);
        dispose?.();
      };
    },
  };
}
