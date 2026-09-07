import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError } from "@/api/auth-guard.js";
import { issueWsToken } from "@/ws/ws-token.js";

const WsTokenResponseSchema = t.Object({
  token: t.String({ description: "Single-use WebSocket attach token (30s TTL)" }),
});

/**
 * Issues a short-lived WebSocket attach token.
 *
 * The frontend cannot read its HttpOnly session cookie (and the Vite WS proxy
 * doesn't forward Cookie headers on upgrade), so it calls this authenticated
 * REST endpoint first — the cookie works for plain HTTP — then passes the
 * token as a query param on the /ws connection.
 *
 * Cookie-only: interactive terminal attach is a human path, and issueWsToken
 * binds the token to the *owner* — a subshell token could otherwise mint an
 * attach token for ANY of the owner's subshells and inject keystrokes into a
 * sibling agent's pane. No agent tool path calls this route (mcp/ never
 * touches /api/auth/ws-token or /ws).
 */
export const wsTokenRoutes = new Elysia({ prefix: "/api/auth" }).use(authGuard).post(
  "/ws-token",
  async ({ user, actor }) => {
    if (actor !== "cookie") throw new ForbiddenError();
    return { token: issueWsToken(user.id) };
  },
  {
    response: WsTokenResponseSchema,
    detail: {
      operationId: "issueWsToken",
      tags: ["auth"],
      description: "Issues a single-use, 30s WebSocket attach token (cookie session only)",
    },
  },
);
