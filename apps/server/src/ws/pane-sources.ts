import { type FSWatcher, watch } from "node:fs";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { captureToTerminalText } from "@/ws/capture-text.js";
import type { PaneSource } from "@/ws/pane-stream.js";
import { SyncStreamStripper } from "@/ws/sync-stripper.js";

/** Safety net for missed watch events (file replaced under the watch, quota). */
export const TAIL_BACKSTOP_MS = 1000;

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
        // If the inode dies the watcher is dead weight; the backstop delivers.
        watcher.on("error", () => {
          watcher?.close();
          watcher = null;
        });
      } catch {
        watcher = null;
      }
      const timer = setInterval(() => void pump(), TAIL_BACKSTOP_MS);
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
          const out = captureToTerminalText(await options.launcher.capture(options.socket, options.subshellId));
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
