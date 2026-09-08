/**
 * One output pump per subshell, fanned out to every viewer watching it.
 *
 * Until now each attach ran its own pump: its own `fs.watch` + backstop over
 * the replay log, or its own 300 ms `capture-pane` poll. That was safe only
 * because a subshell had exactly one viewer — the server evicted the previous
 * one (close 4003) to keep it that way.
 *
 * Sharing the pump is not an optimization, it is the precondition for letting
 * several devices watch one pane. `NodeLauncher`'s contract is explicit:
 *
 *   Callers MUST NOT overlap per-subshell pumps (capture loop + poll loop, two
 *   attach streams) on one subshell: even serialized dispatch can flip the
 *   read-your-writes order these pumps rely on between their own successive
 *   calls.
 *
 * Two pollers reading one pane can each observe a different instant, so two
 * devices would drift apart and neither would be authoritative. With one
 * source every viewer receives byte-identical chunks, in the same order, by
 * construction.
 *
 * ## Joining without a gap
 *
 * A subscriber starts QUEUED and delivers nothing until {@link Subscription.open}.
 * That exists for the attach sequence, which must run in this order:
 *
 *   1. subscribe  — the stream starts holding chunks for this viewer
 *   2. capture    — take the replay snapshot and send it
 *   3. open       — flush what arrived in between, then stream live
 *
 * Subscribing FIRST is what makes the join gap-free: a byte produced between
 * the snapshot and the subscription would otherwise be lost, and a skipped
 * byte desynchronizes a diff-rendering TUI permanently. The cost is a brief
 * overlap — a few frames may be painted twice — which is the trade the attach
 * path already documents (see apps/server/api/AGENTS.md): a visible transient
 * beats a permanent desync.
 *
 * A joiner is never sent chunks from before it subscribed. Its own replay
 * already carries that history, and re-playing the tail over a fresh capture
 * is what painted mid-stream redraw sequences into the snapshot.
 */

/** Produces the pane's output. One instance per subshell, per stream lifetime. */
export interface PaneSource {
  /**
   * Begins producing output.
   * @param emit - Called with each chunk of pane output, in order
   * @returns A disposer that stops production and releases its resources
   */
  start(emit: (text: string) => void): () => void;
}

/** One viewer's attachment to a subshell's stream. */
export interface Subscription {
  /**
   * Starts delivery, flushing anything that arrived while queued. Call it
   * after the replay has been sent — see the module docstring.
   */
  open(): void;
  /** Detaches this viewer. Idempotent, and safe to call after a later attach. */
  close(): void;
}

/** Per-subshell fan-out registry. */
export interface PaneStreamRegistry {
  /**
   * Attaches a viewer, starting the subshell's pump if it is the first.
   *
   * @param key - Subshell id
   * @param makeSource - Builds the source; called ONLY for the first viewer
   * @param deliver - Receives each chunk once the subscription is open
   * @returns The subscription handle
   */
  subscribe(key: string, makeSource: () => PaneSource, deliver: (text: string) => void): Subscription;
  /** How many viewers are attached to `key`. */
  viewerCount(key: string): number;
  /**
   * Stops every pump and forgets every viewer.
   *
   * Only for tests, which reuse subshell ids across cases: a case that leaves
   * a subscription open would otherwise hand the NEXT case a running pump, so
   * its own attach silently reuses that stream and never builds a source at
   * all — the failure looks like "the tail never started" and is really "the
   * previous test's tail is still running".
   * @internal
   */
  resetForTests(): void;
}

/** One subshell's live fan-out. */
interface Stream {
  /** Open + queued viewers, in attach order. */
  viewers: Set<Viewer>;
  /** Stops the source. */
  stop: () => void;
}

/** One attached viewer. */
interface Viewer {
  /** False until `open()`, while the joiner's replay is still being sent. */
  live: boolean;
  /** Chunks that arrived before `open()`, in order. */
  queued: string[];
  /** Where chunks go once live. */
  deliver: (text: string) => void;
}

/**
 * Creates a registry of per-subshell output streams.
 * @returns The registry
 */
export function createPaneStreamRegistry(): PaneStreamRegistry {
  const streams = new Map<string, Stream>();

  return {
    subscribe(key, makeSource, deliver) {
      const viewer: Viewer = { live: false, queued: [], deliver };
      let stream = streams.get(key);
      if (!stream) {
        const created: Stream = { viewers: new Set(), stop: () => {} };
        streams.set(key, created);
        created.stop = makeSource().start((text) => {
          // Snapshot the viewer set: a delivery may close a socket, and
          // mutating the set mid-iteration would skip the viewer after it.
          for (const target of [...created.viewers]) {
            if (!target.live) {
              target.queued.push(text);
              continue;
            }
            try {
              target.deliver(text);
            } catch {
              // A socket that throws is already gone; its close path does the
              // bookkeeping. One dead tab must not stop the other devices.
            }
          }
        });
        stream = created;
      }
      stream.viewers.add(viewer);
      const attached = stream;

      return {
        open() {
          if (viewer.live) return;
          viewer.live = true;
          const pending = viewer.queued.splice(0);
          for (const text of pending) {
            try {
              viewer.deliver(text);
            } catch {
              // See above — a failed flush is a gone socket, not a stream fault.
            }
          }
        },
        close() {
          // Guard on the CAPTURED stream, not the current one: a stale handle
          // closing after the last viewer left and a new viewer started a
          // fresh stream must not tear that new stream down.
          if (!attached.viewers.delete(viewer)) return;
          if (attached.viewers.size > 0) return;
          if (streams.get(key) === attached) streams.delete(key);
          attached.stop();
        },
      };
    },
    viewerCount(key) {
      return streams.get(key)?.viewers.size ?? 0;
    },
    resetForTests() {
      for (const stream of streams.values()) stream.stop();
      streams.clear();
    },
  };
}
