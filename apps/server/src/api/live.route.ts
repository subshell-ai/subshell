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
    const stream = new ReadableStream({
      async start(controller) {
        const tick = async () => {
          try {
            const subshells = await services.subshells.listSubshells(userId);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ subshells })}\n\n`));
          } catch {
            // subshell list errors are non-fatal; keep the feed alive
          }
        };
        await tick();
        const iv = setInterval(tick, SSE_INTERVAL_MS);
        // Abort when the client disconnects.
        const abort = () => clearInterval(iv);
        if (request.signal) request.signal.addEventListener("abort", abort);
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
