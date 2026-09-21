/**
 * The per-subshell, per-session rolling window of COMPLETED input ids
 * (spec 2026-09-21 Wave A).
 *
 * It is what makes the client's reconnect re-send safe against the one fatal
 * ambiguity of at-least-once retry: the write landed, the ack was lost with
 * the dying socket. A re-sent id this window already holds is dropped without
 * touching the pane. Only COMPLETED writes are committed here; a failed write
 * must stay re-writable, because the client's retry is the only thing that
 * would carry the keystroke.
 *
 * Keyed (subshellId, sessionId), not by subshell alone, and not by socket.
 * Not by subshell alone because two viewers on one shared subshell each count
 * ids from 1, so a bare per-subshell window would drop the second viewer's
 * keystrokes. Not by socket (viewerId) because viewer ids live exactly as
 * long as one socket, and the whole point is to recognize a retry arriving on
 * the NEXT socket. The session id is the client's own `&sid=` attach param,
 * constant across that page's reconnects; a fresh page load starts a fresh
 * namespace, which is also what makes a client-side id restart safe.
 */

/** Ids kept per session, sized to match the browser queue's own frame cap
 * (MAX_PENDING in apps/server/web/src/lib/input-queue.ts). That match is the
 * guarantee: a reconnect resend carries at most this many ids, so it can
 * never consult an id the window has already evicted. A write that landed is
 * therefore ALWAYS recognized and never re-written by a retry; a failed
 * write never entered the window and is rewritten by the retry, so no
 * keystroke is ever lost; and the one duplicate still possible is the
 * documented in-flight race (the retry consults this window on ARRIVAL,
 * while the first write is still in flight), at most one extra write of one
 * id. Eviction can then only widen the at-least-once window, and only for a
 * client that broke the cap. */
const WINDOW_SIZE = 512;

/** Sessions kept process-wide. A session id is never seen again once its page
 * is gone, and each of its windows is bounded but not free; the cap is an LRU
 * so a burst of page loads cannot grow the map without bound. Evicting a
 * session that reconnects anyway costs it at-least-once duplicates only. */
const MAX_SESSIONS = 512;

/** One session's completed ids: a Set for O(1) consults plus the FIFO order
 * the eviction walks. */
class IdWindow {
  private readonly seen = new Set<number>();
  private readonly order: number[] = [];

  /** True when `id` was already written and has not been evicted. */
  has(id: number): boolean {
    return this.seen.has(id);
  }

  /** Commits a completed write. Idempotent: a late second commit is a no-op. */
  add(id: number): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > WINDOW_SIZE) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

/** subshellId → sessionId → that session's window. */
const windows = new Map<string, Map<string, IdWindow>>();

/** The sanitized session id a client may claim. Same posture as the attach
 * UA's `build=`: it is a key we own, never trusted display data, so it is
 * reduced to a safe alphabet and capped rather than validated. */
const MAX_SESSION_ID_LEN = 64;

/**
 * Sanitizes the client's `&sid=` attach param, or undefined when it sent
 * nothing usable (an older client, a hand-built socket).
 * @param raw - The raw query value
 * @returns The sanitized id, or undefined
 */
export function sanitizeInputSession(raw: string | undefined): string | undefined {
  const cleaned = (raw ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, MAX_SESSION_ID_LEN);
  return cleaned || undefined;
}

/**
 * Synchronously consults the window: has this input already been written?
 * Called in the frame handler BEFORE dispatch, so a re-send never queues a
 * second pane write behind the first. A read never CREATES: a miss leaves no
 * empty session behind, so the map holds only sessions that actually wrote.
 * @param subshellId - The subshell the input targets
 * @param sessionId - The client's attach session id
 * @param id - The client's input id
 * @returns True when the id is already committed
 */
export function inputWindowHas(subshellId: string, sessionId: string, id: number): boolean {
  const sessions = windows.get(subshellId);
  const window = sessions?.get(sessionId);
  if (!window) return false;
  // Refresh the session's LRU position without disturbing the window itself.
  sessions?.delete(sessionId);
  sessions?.set(sessionId, window);
  return window.has(id);
}

/**
 * Commits a completed write's id. Called in the `sendInput` success path,
 * never on failure: a failed write must stay re-writable. The touch also
 * refreshes the session's LRU position, so an actively writing session is
 * never the eviction candidate.
 * @param subshellId - The subshell the input targeted
 * @param sessionId - The client's attach session id
 * @param id - The client's input id
 */
export function inputWindowAdd(subshellId: string, sessionId: string, id: number): void {
  let sessions = windows.get(subshellId);
  if (!sessions) {
    sessions = new Map();
    windows.set(subshellId, sessions);
  }
  const existing = sessions.get(sessionId);
  const window = existing ?? new IdWindow();
  if (existing) sessions.delete(sessionId); // LRU: a touched session is the newest
  sessions.set(sessionId, window);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  window.add(id);
}

/**
 * Drops every input window. Only for tests, which reuse subshell ids across
 * cases; a surviving window would silently drop the next case's id-1
 * keystroke as an already-written duplicate.
 * @internal
 */
export function resetInputWindowsForTests(): void {
  windows.clear();
}
