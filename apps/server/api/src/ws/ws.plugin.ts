import { Elysia } from "elysia";
import {
  authenticateNodeUpgrade,
  getNodeWsDeps,
  handleNodeClose,
  handleNodeMessageQueued,
  handleNodeOpen,
  type NodeWsSocket,
} from "@/services/nodes/node-ws-handler.js";
import { logger } from "@/utils/logger.js";
import { attachUrlFromQuery } from "@/ws/attach-params.js";
import { handleLiveClose, handleLiveOpen, type LiveWsSocket, liveWsDeps } from "@/ws/live-ws.js";
import { cleanupSubshellWs, handleSubshellMessage, handleSubshellWs } from "@/ws/subshell-ws.js";
import type { WsSocket } from "@/ws/viewers.js";

/**
 * WebSocket attach endpoint at /ws.
 *
 * Client connects with `?subshell=<id>&token=<subshell-token>`; the subshell
 * must belong to the authenticated user. The server streams `replay` +
 * `output` frames and accepts text frames as input to the tmux pane.
 */
export const wsPlugin = new Elysia({ name: "ws" }).ws("/ws", {
  /**
   * Stash the upgrade request's User-Agent where `open` can read it.
   *
   * `ws.raw.request` is NOT populated in Elysia's WS open context, so the
   * attach journal line's `ua=` read "unknown" for every client — useless
   * exactly when it mattered (telling a stale PWA bundle apart from a current
   * one). The upgrade hook DOES have the request, and the adapter spreads the
   * mutated context into `ws.data` — the same channel `/ws/node` uses for its
   * node identity.
   */
  upgrade(context) {
    const request = (context as { request?: Request }).request;
    Object.assign(context as Record<string, unknown>, {
      attachUa: request?.headers.get("user-agent") ?? "unknown",
    });
  },
  open(ws) {
    // ElysiaWS.data carries the request context, including parsed query
    // params. FORWARD THEM ALL to the handler — subshell + token (auth) and
    // cols/rows (the geometry it resizes the pane to BEFORE capturing the
    // replay). Cherry-picking params here is how the browser's size used to
    // be silently dropped and every attach captured at the pane's stale
    // width (jumbled-until-resize, 2026-09-01).
    const query = (ws as unknown as { data: { query?: Record<string, string> } }).data.query ?? {};
    const url = attachUrlFromQuery(query);
    void handleSubshellWs(ws as unknown as WsSocket, url).catch(() => ws.close(4000, "attach failed"));
  },
  message(ws, message) {
    // Elysia's WS middleware JSON-parses frames that start with `{`, so a
    // frame arrives as either the raw string or a parsed object.
    // parseClientFrame (inside handleSubshellMessage) accepts both.
    if (typeof message === "string" || (message && typeof message === "object")) {
      handleSubshellMessage(ws as unknown as WsSocket, message);
    }
  },
  close(ws) {
    cleanupSubshellWs(ws as unknown as WsSocket);
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
    // Queued variant (P1-T10): frames serialize per socket so an inventory
    // EVENT is stored before its command's result settles the waiting RPC.
    if (typeof message !== "string" && !(message && typeof message === "object")) return;
    void handleNodeMessageQueued(getNodeWsDeps(), ws as unknown as NodeWsSocket, message).catch((err: unknown) => {
      logger.withError(err).warn("node ws: frame handling failed");
    });
  },
  close(ws) {
    void handleNodeClose(getNodeWsDeps(), ws as unknown as NodeWsSocket).catch((err: unknown) => {
      logger.withError(err).warn("node ws: close teardown failed");
    });
  },
});

/**
 * The dashboard's live feed at /ws/live (spec 2026-09-19).
 *
 * Replaces the `/api/events` SSE stream, which held one of the browser's six
 * per-origin HTTP/1.1 connections for the life of every tab. Auth is the same
 * single-use `?token=` the attach path uses, redeemed in `open`; there is no
 * upgrade hook because nothing here needs the request — unlike `/ws`, which
 * stashes the User-Agent, and `/ws/node`, which authenticates a bearer key.
 *
 * The client sends nothing on this socket yet, so there is no `message`
 * handler to write; `watch-previews` arrives with the preview work.
 */
wsPlugin.ws("/ws/live", {
  open(ws) {
    // Fire-and-forget: the handler owns its own refusal (close 4001) and its
    // own failures, and awaiting here would hold Elysia's open callback for a
    // role read and a list build.
    void handleLiveOpen(ws as unknown as LiveWsSocket, liveWsDeps()).catch((err: unknown) => {
      logger.withError(err).warn("live ws: open failed");
    });
  },
  close(ws) {
    handleLiveClose(ws as unknown as LiveWsSocket);
  },
});
