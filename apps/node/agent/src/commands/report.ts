import type { NodeEvent } from "@internal/subshell-protocol";
import { log } from "../log.js";
import type { CommandContext, WatcherRegistration } from "./context.js";

/**
 * The shared exit watcher and the connect-time `subshells_report` scan
 * (spec 2026-08-31 §3.3/§7). Both read the same truth — tmux liveness on the
 * recorded socket — from two directions: the watcher proves a pane died while
 * the agent was connected; the report re-projects every tracked subshell after
 * an agent restart (panes outlive the agent by design).
 *
 * The watcher is ONE loop for ALL supervised panes (the `execProbe` batching
 * pattern applied to the death watch): a per-pane `setInterval` + `has-session`
 * meant K tmux subprocess spawns per tick forever. The shared tick instead
 * groups the supervised set by socket and asks each socket ONCE per tick
 * (`list-sessions -F '#{session_name}'`), then runs the per-pane exit path
 * for the panes that vanished — or whose socket stayed silent past the
 * unreachable threshold — gated on the snapshotted registration token, so a
 * tick never reports or cleans up an id a newer registration owns.
 */

/** Production watcher cadence (spec §7: 2 s liveness/`pane_dead_status` loop). */
export const EXIT_WATCH_INTERVAL_MS = 2_000;

/**
 * Consecutive failed probes (ok:false ticks) a registration must absorb before
 * the watcher reports its pane dead (design 2026-09-02 §1). One tick ≈ 2 s, so
 * 2 means ≈ 4 s of sustained unreachability: a client-side blip (fork failure,
 * EINTR, overloaded server) costs nothing, genuine death costs +2 s, and
 * sustained tmux breakage still converges — no zombie rows. RULING: a
 * threshold, not failure-classification — "server gone" and "probe blip" are
 * both rc=1 from one CLI call, only stderr differs.
 */
export const NODE_EXIT_UNREACHABLE_TICKS = 2;

/** Stop the shared tick if one is running (idempotent). */
function stopLoop(ctx: CommandContext): void {
  if (ctx.watchTick !== undefined) {
    clearInterval(ctx.watchTick);
    ctx.watchTick = undefined;
  }
}

/**
 * Remove one subshell from exit supervision. Safe on unknown ids (a plain map
 * delete) — `execTerminate`/`execKill` call it BEFORE killing so a deliberate
 * kill can never double-report: the watcher only ever fires on NATURAL death.
 * (A raced event is harmless anyway — the backend's `applyRemoteExit` is
 * idempotent — but stopping first is the cheap rule.) Draining the last entry
 * also stops the shared tick.
 * @param ctx - the daemon's command context (owns the watched set + shared tick)
 * @param subshellId - the subshell to stop supervising
 */
export function stopWatcher(ctx: CommandContext, subshellId: string): void {
  ctx.watchers.delete(subshellId);
  if (ctx.watchers.size === 0) stopLoop(ctx);
}

/**
 * Put one launched pane under exit supervision: when its socket stops listing
 * it — or stops ANSWERING for {@link NODE_EXIT_UNREACHABLE_TICKS} consecutive
 * ticks (design §1: one blip never reports a live pane dead) — the shared tick
 * emits exactly one `exit` event and cleans up (unregister,
 * forget the meta record, drop the subshell's tail pumps). Re-registering for
 * the same id REPLACES the old entry with a fresh registration token — a
 * relaunch on a restarted row rotates its socket, and the tick that
 * snapshotted the old pane sees the token mismatch and never reports the live
 * relaunch dead or sweeps its meta/tails. Starting the first watcher arms the
 * ONE shared interval; later registrations ride it, so `intervalMs` only takes
 * effect on that first call (production is always
 * {@link EXIT_WATCH_INTERVAL_MS}; tests pass a short one into a fresh ctx).
 * The socket arrives from the launch wire — no meta re-read.
 * @param ctx - the daemon's command context
 * @param subshellId - the subshell (already format-validated by the caller)
 * @param socket - the tmux socket the pane was created on (`cmd.socket`)
 * @param intervalMs - tick period for the shared loop; production default 2 s
 * @returns the registration object — the tick compares it BY REFERENCE for
 * ownership (the `.token` inside gives callers/tests an explicit identity
 * handle; the tick itself never reads the symbol)
 */
export function startExitWatcher(
  ctx: CommandContext,
  subshellId: string,
  socket: string,
  intervalMs = EXIT_WATCH_INTERVAL_MS,
): symbol {
  const token = Symbol(subshellId);
  ctx.watchers.set(subshellId, { socket, token, unreachable: 0 });
  if (ctx.watchTick !== undefined) return token; // loop already running for the existing set
  // NON-REENTRANT. The probe is async and bounded by the tmux deadline
  // (15 s), while this interval is 2 s — so a wedged socket would let seven
  // ticks run at once, each re-probing the same sockets and racing the same
  // registrations through the same death sequence. That could not happen
  // while the probe was synchronous: it blocked the loop, which IS the
  // mutual exclusion the async version has to state for itself. A tick that
  // arrives while one is in flight is DROPPED rather than queued — the next
  // one is two seconds away and reads fresher state than a queued one would.
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    // TOTAL per tick: a throwing tmux probe must not become an unhandled
    // rejection (nor silently kill the loop on the next throw).
    void runExitWatchTick(ctx)
      .catch((err: unknown) => log(`exit watcher tick failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  timer.unref?.(); // a watcher must never hold the daemon (or a test process) open
  ctx.watchTick = timer;
  return token;
}

/**
 * Run ONE tick of the shared exit watch: every supervised socket is probed
 * ONCE with `tmux.listSubshellsChecked` (one spawn per socket, not per pane).
 * `ok:true` is authoritative — a pane missing from the answer goes
 * through the per-pane exit path immediately (identical to the old loop's
 * semantics: exit code read before unregistering, at most one event per
 * registration, meta forgotten, tails dropped). `ok:false` counts: a
 * registration reports only after {@link NODE_EXIT_UNREACHABLE_TICKS}
 * CONSECUTIVE failed probes, via the SAME death sequence — one transient
 * probe blip never reports a live pane dead (design 2026-09-02 §1). Exposed
 * for tests; production only ever runs it from the shared interval.
 * @param ctx - the daemon's command context
 */
export async function runExitWatchTick(ctx: CommandContext): Promise<void> {
  if (ctx.watchers.size === 0) {
    stopLoop(ctx);
    return;
  }
  // Group the supervised set by socket — watchers CAN span sockets (the wire
  // carries a per-launch socket; production mints one per subshell, but a
  // shared socket is legal), so the batch unit is the socket, not the node.
  // The group carries each entry's registration object: the per-id exit path
  // only proceeds while the map still holds THAT registration (see below).
  const bySocket = new Map<string, Array<{ subshellId: string; reg: WatcherRegistration }>>();
  for (const [subshellId, reg] of ctx.watchers) {
    const entries = bySocket.get(reg.socket);
    if (entries) entries.push({ subshellId, reg });
    else bySocket.set(reg.socket, [{ subshellId, reg }]);
  }
  for (const [socket, entries] of bySocket) {
    try {
      // Tri-state probe (design §1): ok:true is AUTHORITATIVE — a pane the
      // socket answered without is confirmed dead. ok:false is a BLIP OR a
      // dead server — indistinguishable from one CLI call (both are rc=1,
      // only stderr differs), so it costs a counter tick, not a death report.
      const probe = await ctx.tmux.listSubshellsChecked(socket);
      if (probe.ok) {
        const alive = new Set(probe.names);
        for (const { subshellId, reg } of entries) {
          if (alive.has(subshellId)) {
            reg.unreachable = 0; // an authoritative answer breaks any unreachable streak
            continue;
          }
          // Re-check OWNERSHIP, not just membership: execKill/execTerminate may
          // have dropped this pane since the snapshot (the forget await below
          // yields to the dispatcher) — a deliberately killed pane must never
          // report death — AND a relaunch of the same id may have REPLACED the
          // entry. A token mismatch means a newer registration owns the id now:
          // this stale tick reports nothing and cleans nothing of theirs.
          if (ctx.watchers.get(subshellId) !== reg) continue;
          await reportDeath(ctx, socket, subshellId);
        }
      } else {
        for (const { subshellId, reg } of entries) {
          // Ownership re-check BEFORE any counting: a replaced registration is
          // another tick's problem (and starts its budget fresh at 0).
          if (ctx.watchers.get(subshellId) !== reg) continue;
          reg.unreachable += 1;
          if (reg.unreachable < NODE_EXIT_UNREACHABLE_TICKS) continue; // blip: stay watched, silently
          log(
            `exit watcher: socket ${socket} unreachable for ${reg.unreachable} consecutive ticks ` +
              `(threshold ${NODE_EXIT_UNREACHABLE_TICKS}; last probe: ${probe.detail}); reporting ${subshellId} dead`,
          );
          await reportDeath(ctx, socket, subshellId);
        }
      }
    } catch (err) {
      // One socket's failing probe must not starve the other sockets' panes.
      log(`exit watcher for socket ${socket} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (ctx.watchers.size === 0) stopLoop(ctx); // last pane left the building — no idle tick
}

/**
 * The per-pane death sequence — SHARED by both report paths (confirmed-absent
 * on an ok:true probe, and threshold-escalated unreachable) so a blip that
 * aged out reports EXACTLY what the old immediate report did. Ownership was
 * re-checked by the caller; the post-await tails guard re-checks for a
 * relaunch that lands while the forget is in flight.
 * @param ctx - the daemon's command context
 * @param socket - the tmux socket the pane was supervised on
 * @param subshellId - the pane this registration covers, now reported dead
 */
async function reportDeath(ctx: CommandContext, socket: string, subshellId: string): Promise<void> {
  // Read the death BEFORE unregistering: paneExitCode is a separate tmux
  // call and a cleared watcher must never swallow the code it was built
  // to report. (On the unreachable path the socket is not answering, so
  // this reads null — the same shape a dead server always produced.)
  const exitCode = (await ctx.tmux.paneExitCode(socket, subshellId)) ?? null;
  ctx.watchers.delete(subshellId); // stop-first: at most one event per registration
  ctx.ws.send({ type: "exit", subshellId, exitCode, at: new Date(ctx.nowMs()).toISOString() });
  await ctx.meta.forget(subshellId);
  // Post-await re-check: a relaunch that armed a fresh registration
  // while this forget was in flight owns its own tails now — never drop
  // them. (Residual window: forget's own internal fs await; a relaunch
  // landing in that microsecond keeps its watchers entry and re-asserts
  // meta — launch writes meta BEFORE watchSubshell, so the record's
  // ordering self-heals, and this recheck covers the tails sweep.)
  if (ctx.watchers.get(subshellId) === undefined) dropTailsFor(ctx, subshellId);
}

/**
 * Stop and drop every tail pump belonging to a dead subshell (Task 5 made this
 * real: {@link import("./context.js").TailHandle} names its subshell, so the
 * death sweep stops a dead pane's subs the moment the watcher reports). A
 * tailed subshell dying is the common case — the control plane re-`log_read`s
 * the final bytes, so streaming into a corpse is pure waste.
 */
function dropTailsFor(ctx: CommandContext, subshellId: string): void {
  for (const [subId, handle] of ctx.tails) {
    if (handle.subshellId === subshellId) {
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
 * Build the connect-time `subshells_report` (spec §3.3: "panes surviving agent
 * restart") — one row per recorded meta: alive panes report `null`, dead ones
 * carry `paneExitCode ?? null`. THROWS if tmux does; the daemon catch-logs it
 * — a failed scan must never cost the connection.
 *
 * That throw now includes a tmux that did not ANSWER (`hasSubshell` re-throws
 * a `TmuxTimeoutError`), and losing the whole census is the right answer
 * rather than a shortcoming: `alive` is a boolean with no room for "could not
 * tell", and sending `false` for a live pane is what the plane would act on.
 * No report means the plane keeps the view it already had.
 * @param ctx - the daemon's command context
 * @returns the wire event (rows sorted by subshellId — `meta.list()` order)
 */
export async function buildSubshellsReport(
  ctx: CommandContext,
): Promise<Extract<NodeEvent, { type: "subshells_report" }>> {
  const subshells: Extract<NodeEvent, { type: "subshells_report" }>["subshells"] = [];
  for (const m of await ctx.meta.list()) {
    const alive = await ctx.tmux.hasSubshell(m.socket, m.subshellId);
    subshells.push({
      subshellId: m.subshellId,
      alive,
      exitCode: alive ? null : ((await ctx.tmux.paneExitCode(m.socket, m.subshellId)) ?? null),
    });
  }
  return { type: "subshells_report", subshells };
}
