import { Elysia } from "elysia";
import { auth } from "@/auth.js";

/**
 * Mounts better-auth's fetch handler at /api/auth/*.
 *
 * NOTE: We deliberately pass the request through untouched (rather than using
 * Elysia's `.mount()`, which strips the mount prefix from the URL). better-auth
 * routes on the full path (`/api/auth/get-session` etc.), so the prefix must
 * reach the handler.
 *
 * The api-key plugin's self-service endpoints are blocked: every credential
 * this app trusts is minted server-side (per-session tokens) or through the
 * admin-only /api/system-keys route, and the plugin's public create endpoint
 * would let any signed-in user mint keys with arbitrary metadata. The auth
 * guard already rejects such keys (session-link / system-owner checks); this
 * just refuses to hand them out in the first place.
 */
export const authPlugin = new Elysia({ name: "auth" })
  .all("/api/auth/api-key/*", () =>
    Response.json({ message: "API keys are managed via /api/system-keys" }, { status: 403 }),
  )
  // Registered as .get() in ADDITION to .all(): the static plugin's SPA
  // fallback (a `.get("*")`) outranks `.all()` wildcards in Elysia's router,
  // so GET /api/auth/get-session would otherwise 404 (or get index.html).
  // A same-path `.get()` here outranks the fallback on specificity, and the
  // duplicate registration is harmless — the first matching route wins.
  .get("/api/auth/*", ({ request }) => auth.handler(request))
  .all("/api/auth/*", ({ request }) => auth.handler(request));
