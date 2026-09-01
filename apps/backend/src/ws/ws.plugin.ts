import { Elysia } from "elysia";
import {
  authenticateNodeUpgrade,
  getNodeWsDeps,
  handleNodeClose,
  handleNodeMessage,
  handleNodeOpen,
  type NodeWsSocket,
} from "@/services/nodes/node-ws-handler.js";
import { logger } from "@/utils/logger.js";
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

/**
 * Agent dial-in endpoint at /ws/node (spec 2026-08-31 §5.3).
 *
 * Auth happens at UPGRADE: `Authorization: Bearer <node-key>` is verified
 * (async — Elysia awaits the hook) and a failure THROWS a status-carrying
 * error, which Elysia turns into a pre-socket HTTP 401/403 — no socket
 * exists yet, so no close codes apply. On success the hook mutates the
 * upgrade context, and those fields arrive in `ws.data`.
 */
wsPlugin.ws("/ws/node", {
  async upgrade(context) {
    const request = (context as { request: Request }).request;
    const identity = await authenticateNodeUpgrade(getNodeWsDeps(), request.headers.get("authorization"));
    // The adapter spreads the (mutated) context into every socket's `data`,
    // so this stash is what `open` reads back — the spike-verified channel.
    Object.assign(context as Record<string, unknown>, identity);
  },
  open(ws) {
    // `ws.data` already carries the identity (the adapter built it by
    // spreading the context the upgrade hook mutated) — cast to the typed
    // view and attach.
    handleNodeOpen(ws as unknown as NodeWsSocket);
  },
  message(ws, message) {
    // Same JSON pre-parse behavior as /ws: frames arrive as text or objects.
    if (typeof message !== "string" && !(message && typeof message === "object")) return;
    void handleNodeMessage(getNodeWsDeps(), ws as unknown as NodeWsSocket, message).catch((err: unknown) => {
      logger.withError(err).warn("node ws: frame handling failed");
    });
  },
  close(ws) {
    void handleNodeClose(getNodeWsDeps(), ws as unknown as NodeWsSocket).catch((err: unknown) => {
      logger.withError(err).warn("node ws: close teardown failed");
    });
  },
});

import type { WsSocket } from "@/ws/session-ws.js";
