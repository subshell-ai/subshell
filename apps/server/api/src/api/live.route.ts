import { Elysia } from "elysia";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { consumeWsToken } from "@/ws/ws-token.js";

const SSE_INTERVAL_MS = 1500;

/**
 * Server-Sent Events feed of the user's live subshells (cards on the home page).
 *
 * Auth: like the WS attach path, the browser cannot read the HttpOnly cookie
 * for EventSource, so the client fetches a short-lived ws token via
 * `POST /api/auth/ws-token` and passes it as `?token=`.
 *
 * Emits one JSON event per tick containing the full (cheap) subshell list —
 * built by `SubshellsService.listSubshells`, the SAME sharing/admin-aware
 * method `GET /api/subshells` answers with. The client writes both producers
 * into one query cache, so a frame that resolves a different set than the
 * REST list would make rows flicker in and out (live report 2026-09-03: an
 * admin's SSE frames were owner-only while REST was admin-wide). The owner-
 * only `SubshellManagerService.listSubshells` must never back this feed.
 *
 * Known design debt (local service, accepted):
 * - Token TTL (30s) is shorter than the stream lifetime, so the client
 *   reconnects with a fresh token roughly every 30s; the `connected` badge
 *   may briefly flap to "offline" in between. Tokens are consumed on use, so
 *   a failed request (browser cancel) makes the NEXT connect 401 — the
 *   client's reconnect loop treats that as a normal retry (self-healing).
 * - EventSource cannot send the HttpOnly cookie, so if this endpoint is ever
 *   exposed beyond localhost it must move to real auth (cookie via
 *   `withCredentials`) — see .claude/rules/security-context.md.
 */
// NOTE: this route deliberately does NOT use authGuard — the client cannot
// send the HttpOnly cookie on an EventSource, so auth is via the ws-token
// query param only (single-use, 30s TTL).
export const liveRoutes = new Elysia({ prefix: "/api/events" }).use(contextPlugin).get(
  "/",
  async ({ query, set, request, ctx }) => {
    const userId = query.token ? consumeWsToken(query.token) : null;
    if (!userId) {
      set.status = 401;
      return "unauthorized";
    }
    set.headers["content-type"] = "text/event-stream";
    set.headers["cache-control"] = "no-cache";
    set.headers["connection"] = "keep-alive";

    // One long-lived request ⇒ ctx is resolved once and the closure reuses
    // it; the services below are stateless over the shared `db` singleton.
    const services = ctx.services;
    const encoder = new TextEncoder();
    // Hoisted so `cancel` can stop it: a consumer that drops the body without
    // aborting the request (any `reader.cancel()`) would otherwise leave this
    // interval running for the life of the process, re-listing subshells —
    // a DB read plus a tmux capture per running pane — for a client that is
    // gone. Measured in the test suite, where one such feed kept calling the
    // launcher long after its suite finished.
    let ticker: ReturnType<typeof setInterval> | null = null;
    const stopTicking = (): void => {
      if (ticker) clearInterval(ticker);
      ticker = null;
    };
    const stream = new ReadableStream({
      async start(controller) {
        const tick = async () => {
          let frame: string;
          try {
            const subshells = await services.subshells.listSubshells(userId);
            frame = `data: ${JSON.stringify({ subshells })}\n\n`;
          } catch {
            return; // subshell list errors are non-fatal; keep the feed alive
          }
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            // Enqueueing into a closed controller throws, and that is the only
            // disconnect signal that always arrives: `request.signal` may never
            // abort, and a consumer's `reader.cancel()` reaches this source only
            // if nothing re-wrapped the stream on the way out. Swallowing it
            // with the list errors above is what kept a feed ticking for a
            // client that had already gone — re-listing every subshell, which
            // is a DB read plus a tmux capture per running pane.
            stopTicking();
          }
        };
        await tick();
        ticker = setInterval(tick, SSE_INTERVAL_MS);
        // Abort when the client disconnects.
        if (request.signal) request.signal.addEventListener("abort", stopTicking);
      },
      // The other half: dropping the body is a disconnect too.
      cancel() {
        stopTicking();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  },
  {
    detail: { operationId: "streamLiveSubshells", tags: ["subshells"], description: "SSE: live subshell list" },
  },
);
