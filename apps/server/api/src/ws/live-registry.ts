import type { LiveWsSocket } from "@/ws/live-ws.js";

/**
 * The open live-feed sockets, by viewer.
 *
 * **It exists so a revocation can reach an open connection.** A socket's
 * topics and rows are fixed at connect, and neither an account disable nor a
 * role change closes a WebSocket (auth happens at connect and is never
 * re-checked, `docs/security.md`), so something has to close it deliberately —
 * a disabled account must not keep streaming, and a changed role drops the
 * sockets so the reconnect rebuilds the client with the new role's chrome.
 * Since the 2026-10-09 ruling the role no longer chooses feed topics at all
 * (an admin subscribes to the same two topics as everyone else), which makes
 * the role-change drop hygiene rather than the safety this file was first
 * written for; the disable drop stays load-bearing.
 *
 * The feed's own snapshot-on-connect is what makes closing cheap: the client
 * reconnects on any close, re-resolves its role, and subscribes correctly. So
 * "drop this user's sockets" is a complete fix rather than a blunt one.
 */
const byUser = new Map<string, Set<LiveWsSocket>>();

/** Records an open socket so a later role change or account disable can find it. */
export function registerLiveSocket(userId: string, ws: LiveWsSocket): void {
  const set = byUser.get(userId) ?? new Set<LiveWsSocket>();
  set.add(ws);
  byUser.set(userId, set);
}

/** Forgets a socket. Safe for one never registered. */
export function unregisterLiveSocket(userId: string | undefined, ws: LiveWsSocket): void {
  if (!userId) return;
  const set = byUser.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) byUser.delete(userId);
}

/**
 * Closes every live socket a viewer holds, so their next connect re-derives
 * which topics they may subscribe to.
 *
 * Called when a role changes. The close code is deliberately BELOW 4000: the
 * client treats the 4xxx range as a refusal to report and anything under it as
 * a connection to retry, so this reconnects silently rather than surfacing as
 * an error — the same convention `performRestart` uses with 1012.
 *
 * Called when a role changes, and when an account is disabled — the two acts
 * that change what a (re)connect may legitimately subscribe to.
 *
 * @param userId - whose sockets to drop
 * @param reason - the close reason the sockets carry; defaults to the role
 *   change's own wording because that was the first caller
 * @returns how many were closed, for the audit line
 */
export function dropLiveSocketsFor(userId: string, reason = "role changed"): number {
  const set = byUser.get(userId);
  if (!set) return 0;
  const sockets = [...set];
  byUser.delete(userId);
  for (const ws of sockets) {
    try {
      ws.close(1012, reason);
    } catch {
      // A socket already gone is exactly what we wanted; nothing to report.
    }
  }
  return sockets.length;
}

/** Drops every record. Test seam only — @internal. */
export function resetLiveRegistryForTests(): void {
  byUser.clear();
}
