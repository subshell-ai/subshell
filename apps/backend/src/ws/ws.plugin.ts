import { Elysia } from "elysia";
import { cleanupSessionWs, handleSessionMessage, handleSessionWs } from "@/ws/session-ws.js";

/**
 * WebSocket attach endpoint at /ws.
 *
 * Client connects with `?session=<id>&token=<session-token>`; the session
 * must belong to the authenticated user. The server streams `replay` +
 * `output` frames and accepts text frames as input to the tmux pane.
 */
export const wsPlugin = new Elysia({ name: "ws" }).ws("/ws", {
  open(ws) {
    // ElysiaWS.data carries the request context, including parsed query
    // params (session + token come from the query string).
    const query = (ws as unknown as { data: { query?: Record<string, string> } }).data.query ?? {};
    const sessionId = query.session ?? "";
    // Elysia decodes query params; re-encode path-special chars so URL parser
    // treats them as a single param value.
    const token = encodeURIComponent(query.token ?? "");
    const url = new URL(`/ws?session=${encodeURIComponent(sessionId)}&token=${token}`, "http://localhost");
    void handleSessionWs(ws as unknown as WsSocket, url).catch(() => ws.close(4000, "attach failed"));
  },
  message(ws, message) {
    // Elysia's WS middleware JSON-parses frames that start with `{`, so a
    // frame arrives as either the raw string or a parsed object.
    // parseClientFrame (inside handleSessionMessage) accepts both.
    if (typeof message === "string" || (message && typeof message === "object")) {
      handleSessionMessage(ws as unknown as WsSocket, message);
    }
  },
  close(ws) {
    cleanupSessionWs(ws as unknown as WsSocket);
  },
});

import type { WsSocket } from "@/ws/session-ws.js";
