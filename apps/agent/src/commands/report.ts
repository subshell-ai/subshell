import { tmuxSocketFor } from "@internal/harnesses";
import type { NodeEvent } from "@internal/session-protocol";
import { log } from "../log.js";
import type { CommandContext } from "./context.js";

/**
 * The per-session exit watcher and the connect-time `sessions_report` scan
 * (spec 2026-08-31 §3.3/§7). Both read the same truth — `has-session` on the
 * recorded socket — from two directions: the watcher proves a pane died while
 * the agent was connected; the report re-projects every tracked session after
 * an agent restart (panes outlive the agent by design).
 */

/** Production watcher cadence (spec §7: 2 s `has-session`/`pane_dead_status` loop). */
export const EXIT_WATCH_INTERVAL_MS = 2_000;

/**
 * Clear one session's exit watcher, if any. Safe on unknown ids (a plain map
 * delete) — `execTerminate`/`execKill` call it BEFORE killing so a deliberate
 * kill can never double-report: the watcher only ever fires on NATURAL death.
 * (A raced event is harmless anyway — the backend's `applyRemoteExit` is
 * idempotent — but stopping first is the cheap rule.)
 * @param ctx - the daemon's command context (owns the watchers map)
 * @param sessionId - the mote session whose watcher to drop
 */
export function stopWatcher(ctx: CommandContext, sessionId: string): void {
  const timer = ctx.watchers.get(sessionId);
  if (timer !== undefined) {
    clearInterval(timer);
    ctx.watchers.delete(sessionId);
  }
}

/**
 * Watch one launched pane until it dies, then emit exactly one `exit` event
 * and clean up (clear interval, forget the meta record, drop the session's
 * tail pumps). Re-registering for the same id replaces the old watcher —
 * a relaunch on a restarted row rotates it.
 * @param ctx - the daemon's command context
 * @param sessionId - the mote session (already format-validated by the caller)
 * @param intervalMs - tick period; production default 2 s, tests pass a short one
 */
export async function startExitWatcher(
  ctx: CommandContext,
  sessionId: string,
  intervalMs = EXIT_WATCH_INTERVAL_MS,
): Promise<void> {
  stopWatcher(ctx, sessionId);
  // Same socket resolution as the executors: recorded socket wins, derivation is the orphan fallback.
  const socket = (await ctx.meta.get(sessionId))?.socket ?? tmuxSocketFor(sessionId);
  const tick = async (): Promise<void> => {
    if (ctx.tmux.hasSession(socket, sessionId)) return;
    // Read the death BEFORE unregistering: paneExitCode is a separate tmux call
    // and a cleared watcher must never swallow the code it was built to report.
    const exitCode = ctx.tmux.paneExitCode(socket, sessionId) ?? null;
    stopWatcher(ctx, sessionId); // stop-first: at most one event per registration
    ctx.ws.send({ type: "exit", sessionId, exitCode, at: new Date(ctx.nowMs()).toISOString() });
    await ctx.meta.forget(sessionId);
    dropTailsFor(ctx, sessionId);
  };
  const timer = setInterval(() => {
    // TOTAL per tick: a throwing tmux probe must not become an unhandled
    // rejection (nor silently kill the loop on the next throw).
    void tick().catch((err: unknown) =>
      log(`exit watcher for ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, intervalMs);
  timer.unref?.(); // a watcher must never hold the daemon (or a test process) open
  ctx.watchers.set(sessionId, timer);
}

/**
 * Stop and drop every tail pump belonging to a dead session. The `tails` map
 * keys by SUB-id (Task 5 owns `tail.ts`); the pinned {@link
 * import("./context.js").TailHandle} carries no session id yet, so this is the
 * forward-compatible hook — once Task 5's handles name their session, the
 * death sweep stops their pumps automatically. No-op today, which is correct:
 * no tails exist before Task 5.
 */
function dropTailsFor(ctx: CommandContext, sessionId: string): void {
  for (const [subId, handle] of ctx.tails) {
    if ((handle as { sessionId?: string }).sessionId === sessionId) {
      try {
        handle.stop(); // idempotent by contract; belt against a throwing pump
      } catch {
        /* nothing left to stop */
      }
      ctx.tails.delete(subId);
    }
  }
}

/**
 * Build the connect-time `sessions_report` (spec §3.3: "panes surviving agent
 * restart") — one row per recorded meta: alive panes report `null`, dead ones
 * carry `paneExitCode ?? null`. THROWS if tmux does; the daemon catch-logs it
 * — a failed scan must never cost the connection.
 * @param ctx - the daemon's command context
 * @returns the wire event (rows sorted by sessionId — `meta.list()` order)
 */
export async function buildSessionsReport(
  ctx: CommandContext,
): Promise<Extract<NodeEvent, { type: "sessions_report" }>> {
  const sessions: Extract<NodeEvent, { type: "sessions_report" }>["sessions"] = [];
  for (const m of await ctx.meta.list()) {
    const alive = ctx.tmux.hasSession(m.socket, m.sessionId);
    sessions.push({
      sessionId: m.sessionId,
      alive,
      exitCode: alive ? null : (ctx.tmux.paneExitCode(m.socket, m.sessionId) ?? null),
    });
  }
  return { type: "sessions_report", sessions };
}
