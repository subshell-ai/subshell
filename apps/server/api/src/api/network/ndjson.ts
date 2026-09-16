/**
 * The streaming body shape `POST /api/network/:id/join` and `.../publish`
 * answer with — the same one `POST /api/setup/tmux/install` and the agent
 * installer already use, so the SPA reads all four with one reader.
 *
 * One JSON object per line: `{"type":"line","text":…}` while the act runs,
 * then exactly one terminal `{"type":"done",…}` or `{"type":"error","message":…}`.
 * A client that sees the stream end with neither treats that as a failure.
 *
 * **Everything a route can refuse is refused before this is called.** Once the
 * status line is sent a 200 cannot be taken back, so a refusal after the body
 * opens has to arrive as an `error` frame instead — which is worse for a
 * client to handle, and is why the refusal table is decided up front (the
 * tmux route's rule). The one thing that genuinely cannot be pre-decided is a
 * plugin THROWING on a malformed credential: the shape of a vendor's
 * pre-authentication key is the vendor's business, so the route cannot check
 * it and the throw arrives here as an `error` frame.
 */

/** Emits one NDJSON frame. Never throws — a closed reader must not fail the act. */
export type FrameSink = (frame: unknown) => void;

/**
 * Wraps a long-running act in an NDJSON response.
 *
 * The act keeps going when the reader disappears: it is changing this machine,
 * and abandoning a half-finished join because nobody is watching would be
 * worse than finishing it unobserved. `cleanup` runs after the act either way
 * — it is where the per-plugin lock is released.
 *
 * @param run - the act; whatever it throws becomes the terminal `error` frame
 * @param cleanup - always run once the act settles, before the stream closes
 */
export function ndjsonResponse(run: (send: FrameSink) => Promise<void>, cleanup: () => void | Promise<void>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: FrameSink = (frame) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          // The reader is gone (the page navigated). The act carries on.
        }
      };
      try {
        await run(send);
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        try {
          await cleanup();
        } catch {
          // A cleanup failure must not replace the act's own terminal frame.
        }
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      // Nothing between here and the page may hold these frames back: the
      // whole point is that they arrive while the act is still running.
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
