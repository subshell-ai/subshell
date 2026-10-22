import { originRegistry } from "@/services/trusted-origins.js";

/**
 * Reject browser requests from outside the configured origin set. CORS only
 * hides responses, and SameSite cookies still accompany requests from a
 * different origin on the same site. Native clients may omit Origin; browsers
 * supply it on form submissions and WebSocket handshakes.
 */
export function browserOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || originRegistry().has(origin);
}
