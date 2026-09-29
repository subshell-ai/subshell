/**
 * A unique-enough id that WORKS ON EVERY ORIGIN. `crypto.randomUUID` exists
 * only in secure contexts: over plain http on a LAN address (a normal way
 * to run this app) it is absent, and a bare call throws - which read as a
 * dead picker click (2026-09-29) and then as a crashed subshell page (the
 * live-WS session id, same day). Both callers need uniqueness, not the UUID
 * shape, so the fallback is a timestamp+random string and nothing throws.
 */
export function newRandomId(prefix = "id"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
