import type { NodeEvent } from "@internal/session-protocol";
import { log } from "../log.js";
import type { CommandContext, WatcherRegistration } from "./context.js";

/**
 * The shared exit watcher and the connect-time `sessions_report` scan
 * (spec 2026-08-31 §3.3/§7). Both read the same truth — tmux liveness on the
 * recorded socket — from two directions: the watcher proves a pane died while
 * the agent was connected; the report re-projects every tracked session after
 * an agent restart (panes outlive the agent by design).
 *
 * The watcher is ONE loop for ALL supervised panes (the `execProbe` batching
 * pattern applied to the death watch): a per-pane `setInterval` + `has-session`
 * meant K tmux subprocess spawns per tick forever. The shared tick instead
 * groups the supervised set by socket and asks each socket ONCE per tick
 * (`list-sessions -F '#{session_name}'`), then runs the per-pane exit path
 * for the panes that vanished — gated on the snapshotted registration token,
 * so a tick never reports or cleans up an id a newer registration owns.
 */

/** Production watcher cadence (spec §7: 2 s liveness/`pane_dead_status` loop). */
export const EXIT_WATCH_INTERVAL_MS = 2_000;

/** Stop the shared tick if one is running (idempotent). */
function stopLoop(ctx: CommandContext): void {
  if (ctx.watchTick !== undefined) {
    clearInterval(ctx.watchTick);
    ctx.watchTick = undefined;
  }
}

/**
 * Remove one session from exit supervision. Safe on unknown ids (a plain map
 * delete) — `execTerminate`/`execKill` call it BEFORE killing so a deliberate
 * kill can never double-report: the watcher only ever fires on NATURAL death.
 * (A raced event is harmless anyway — the backend's `applyRemoteExit` is
 * idempotent — but stopping first is the cheap rule.) Draining the last entry
 * also stops the shared tick.
 * @param ctx - the daemon's command context (owns the watched set + shared tick)
 * @param sessionId - the mote session to stop supervising
 */
export function stopWatcher(ctx: CommandContext, sessionId: string): void {
  ctx.watchers.delete(sessionId);
  if (ctx.watchers.size === 0) stopLoop(ctx);
}

/**
 * Put one launched pane under exit supervision: when its socket stops listing
 * it, the shared tick emits exactly one `exit` event and cleans up (unregister,
 * forget the meta record, drop the session's tail pumps). Re-registering for
 * the same id REPLACES the old entry with a fresh registration token — a
 * relaunch on a restarted row rotates its socket, and the tick that
 * snapshotted the old pane sees the token mismatch and never reports the live
 * relaunch dead or sweeps its meta/tails. Starting the first watcher arms the
 * ONE shared interval; later registrations ride it, so `intervalMs` only takes
 * effect on that first call (production is always
 * {@link EXIT_WATCH_INTERVAL_MS}; tests pass a short one into a fresh ctx).
 * The socket arrives from the launch wire — no meta re-read.
 * @param ctx - the daemon's command context
 * @param sessionId - the mote session (already format-validated by the caller)
 * @param socket - the tmux socket the pane was created on (`cmd.socket`)
 * @param intervalMs - tick period for the shared loop; production default 2 s
 * @returns the registration object — the tick compares it BY REFERENCE for
 * ownership (the `.token` inside gives callers/tests an explicit identity
 * handle; the tick itself never reads the symbol)
 */
export function startExitWatcher(
  ctx: CommandContext,
  sessionId: string,
  socket: string,
  intervalMs = EXIT_WATCH_INTERVAL_MS,
): symbol {
  const token = Symbol(sessionId);
  ctx.watchers.set(sessionId, { socket, token });
  if (ctx.watchTick !== undefined) return token; // loop already running for the existing set
  const timer = setInterval(() => {
    // TOTAL per tick: a throwing tmux probe must not become an unhandled
    // rejection (nor silently kill the loop on the next throw).
    void runExitWatchTick(ctx).catch((err: unknown) =>
      log(`exit watcher tick failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, intervalMs);
  timer.unref?.(); // a watcher must never hold the daemon (or a test process) open
  ctx.watchTick = timer;
  return token;
}

/**
 * Run ONE tick of the shared exit watch: every supervised socket is asked for
 * its session names ONCE (one spawn per socket, not per pane), and each pane
 * missing from its socket's answer goes through the per-pane exit path —
 * identical to the old loop's semantics (exit code read before unregistering,
 * at most one event per registration, meta forgotten, tails dropped).
 * Exposed for tests; production only ever runs it from the shared interval.
 * @param ctx - the daemon's command context
 */
export async function runExitWatchTick(ctx: CommandContext): Promise<void> {
  if (ctx.watchers.size === 0) {
    stopLoop(ctx);
    return;
  }
  // Group the supervised set by socket — watchers CAN span sockets (the wire
  // carries a per-launch socket; production mints one per session, but a
  // shared socket is legal), so the batch unit is the socket, not the node.
  // The group carries each entry's registration object: the per-id exit path
  // only proceeds while the map still holds THAT registration (see below).
  const bySocket = new Map<string, Array<{ sessionId: string; reg: WatcherRegistration }>>();
  for (const [sessionId, reg] of ctx.watchers) {
    const entries = bySocket.get(reg.socket);
    if (entries) entries.push({ sessionId, reg });
    else bySocket.set(reg.socket, [{ sessionId, reg }]);
  }
  for (const [socket, entries] of bySocket) {
    try {
      const alive = new Set(ctx.tmux.listSessionNames(socket));
      for (const { sessionId, reg } of entries) {
        if (alive.has(sessionId)) continue;
        // Re-check OWNERSHIP, not just membership: execKill/execTerminate may
        // have dropped this pane since the snapshot (the forget await below
        // yields to the dispatcher) — a deliberately killed pane must never
        // report death — AND a relaunch of the same id may have REPLACED the
        // entry. A token mismatch means a newer registration owns the id now:
        // this stale tick reports nothing and cleans nothing of theirs.
        if (ctx.watchers.get(sessionId) !== reg) continue;
        // Read the death BEFORE unregistering: paneExitCode is a separate tmux
        // call and a cleared watcher must never swallow the code it was built
        // to report.
        const exitCode = ctx.tmux.paneExitCode(socket, sessionId) ?? null;
        ctx.watchers.delete(sessionId); // stop-first: at most one event per registration
        ctx.ws.send({ type: "exit", sessionId, exitCode, at: new Date(ctx.nowMs()).toISOString() });
        await ctx.meta.forget(sessionId);
        // Post-await re-check: a relaunch that armed a fresh registration
        // while this forget was in flight owns its own tails now — never drop
        // them. (Residual window: forget's own internal fs await; a relaunch
        // landing in that microsecond keeps its watchers entry and re-asserts
        // meta — launch writes meta BEFORE watchSession, so the record's
        // ordering self-heals, and this recheck covers the tails sweep.)
        if (ctx.watchers.get(sessionId) === undefined) dropTailsFor(ctx, sessionId);
      }
    } catch (err) {
      // One socket's failing probe must not starve the other sockets' panes.
      log(`exit watcher for socket ${socket} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (ctx.watchers.size === 0) stopLoop(ctx); // last pane left the building — no idle tick
}

/**
 * Stop and drop every tail pump belonging to a dead session (Task 5 made this
 * real: {@link import("./context.js").TailHandle} names its session, so the
 * death sweep stops a dead pane's subs the moment the watcher reports). A
 * tailed session dying is the common case — the control plane re-`log_read`s
 * the final bytes, so streaming into a corpse is pure waste.
 */
function dropTailsFor(ctx: CommandContext, sessionId: string): void {
  for (const [subId, handle] of ctx.tails) {
    if (handle.sessionId === sessionId) {
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
