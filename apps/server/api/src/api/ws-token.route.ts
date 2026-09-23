import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, HttpError } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";
import { issueWsToken } from "@/ws/ws-token.js";

/**
 * The body is OPTIONAL at the envelope level: the SPA and mobile POST this
 * route with no body at all (that byte-shape predates this schema), and only
 * machine credentials are required to fill it in — which is enforced per
 * actor below, not by the envelope.
 */
const WsTokenBodySchema = t.Optional(
  t.Object({
    subshellId: t.Optional(
      t.String({
        description:
          "Target subshell. REQUIRED for machine credentials (Bearer API keys); the token is bound to this id and is refused anywhere else. Ignored for cookie sessions, whose token is the human's own unrestricted attach token.",
      }),
    ),
  }),
);

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
 * A COOKIE mint is unscoped: the socket attaches wherever the session's own
 * access allows, exactly as the SPA and mobile always have.
 *
 * A MACHINE mint (Bearer key) is SCOPED by construction — `subshellId` is
 * required, recorded in the token at issue time, and enforced at every
 * redemption (`attach-resolve` refuses the token on any other subshell;
 * `/ws/live` refuses scoped tokens outright, which is what keeps bearer
 * credentials off the whole-user feed):
 *
 * - A subshell's OWN key may mint only for its OWN pane (`sess:` equality —
 *   the same cross-row rule the attention and name routes apply). This is
 *   what keeps the original reason this route was cookie-only true of
 *   siblings: the guard resolves a subshell key as its OWNER, and without
 *   the equality check one pane's key could drive any pane the owner has.
 *   The equality check runs BEFORE the row lookup on purpose: a subshell key
 *   naming a foreign id gets the same 403 whether that id exists or not, so
 *   the route enumerates nothing. Do not tidy the lookup above the check.
 * - A SYSTEM key may name ANY subshell. That is a stated widening, not an
 *   oversight: the system key is already the instance-wide bearer credential
 *   (docs/security.md §2), and containment sits in the SCOPED token — one
 *   pane, 30 s, single-use, never `/ws/live` — rather than in refusing to
 *   mint at all.
 */
export const wsTokenRoutes = new Elysia({ prefix: "/api/auth" })
  .use(authGuard)
  .use(contextPlugin)
  .use(apiModels)
  .post(
    "/ws-token",
    async ({ user, actor, principal, body, ctx }) => {
      if (actor === "cookie") {
        // The human path ignores subshellId: scoping only narrows, and the
        // cookie identity can already attach (with its own access) to
        // whatever it can reach — narrowing its token would only break the
        // SPA's own tab-switching.
        return { token: issueWsToken(user.id) };
      }
      if (!body?.subshellId) {
        throw new HttpError(400, "subshellId is required for machine credentials");
      }
      if (actor === "subshell-key" && principal !== `sess:${body.subshellId}`) {
        throw new ForbiddenError();
      }
      const row = await ctx.repos.subshells.findById(body.subshellId);
      if (!row) throw new HttpError(404, "subshell not found");
      // The token carries the OWNER, not the actor: a scoped token's access
      // resolves as the owner's (see ws-token.ts on why the system user
      // would resolve to `none`). The binding, not the identity, is the
      // containment.
      return { token: issueWsToken(row.userId, row.id) };
    },
    {
      body: WsTokenBodySchema,
      response: {
        200: WsTokenResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "issueWsToken",
        tags: ["auth"],
        description:
          "Issues a single-use, 30s WebSocket attach token. Cookie mints are unscoped; Bearer-key mints MUST name a subshell and are bound to it (a subshell key may name only its own).",
      },
    },
  );
