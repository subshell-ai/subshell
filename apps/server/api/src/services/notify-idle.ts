import type { NotifyKind } from "@/services/notify.service.js";
import { logger } from "@/utils/logger.js";

/**
 * How long a subshell log must produce no new bytes before the watcher calls
 * the turn done. Comfortably longer than any realistic output burst — a
 * streaming harness writes constantly, so quiet really means "stopped".
 */
export const IDLE_QUIET_MS = 20_000;
/** Watcher poll interval. Cheap (one list query + one stat per row). */
export const IDLE_TICK_MS = 3_000;
/**
 * Grace between a waiting-stamp and any log growth that should NOT clear it:
 * a hook fires while the harness is still flushing its turn-ending redraw,
 * so the first seconds of growth after a stamp are the same turn's tail.
 */
export const IDLE_SETTLE_MS = 8_000;

/**
 * The per-row fields the watcher reads — a structural subset of
 * `SubshellTable`, so `SubshellsRepository.listRunning()` satisfies it.
 */
export interface IdleWatcherRow {
  /** Subshell id (also the subshell-log file name) */
  id: string;
  /** 1 = pane process alive; dead rows are ignored (reconcile owns them) */
  alive: number;
  /** Harness plugin id — decides hook-less (watcher fires) vs hooked (watcher only clears) */
  harnessId: string;
  /** ISO ts of the current "waiting for you" state (null = not waiting) */
  waitingSince: string | null;
}

/** Everything the watcher touches is injected: unit tests never hit fs/db/tmux. */
export interface IdleWatcherDeps {
  /** Lists the rows to consider (production: `listRunning()` — status-filtered). */
  listRows: () => Promise<IdleWatcherRow[]>;
  /** Subshell log mtime in epoch ms; null when the log does not exist (yet). */
  statMtimeMs: (id: string) => Promise<number | null>;
  /** True when the harness delivers native attention hooks (claude-code). */
  harnessHasHooks: (harnessId: string) => boolean;
  /** Rings the subshell owner's devices (bell gating lives inside). */
  notifySubshell: (id: string, kind: NotifyKind) => Promise<void>;
  /** Stamps the "waiting for you" state (production: `waitingSince` write). */
  setWaiting: (id: string) => Promise<void>;
  /** Clears the "waiting for you" state. */
  clearWaiting: (id: string) => Promise<void>;
}

/** Per-subshell watcher memory: last seen log mtime + whether it was consumed. */
interface IdleState {
  /** Last observed log mtime (epoch ms) */
  mtime: number;
  /** True once the quiet-fire for the current mtime was consumed (re-armed on growth) */
  fired: boolean;
}

/**
 * The universal "turn done" tier for harnesses without native attention
 * hooks (opencode/hermes/pi): when a subshell's output log goes quiet for
 * {@link IDLE_QUIET_MS}, the turn is over → push `turn_complete` and stamp
 * the waiting state.
 *
 * Firing rule (per tick, per `alive === 1` row):
 * - Unseen id → seed `{mtime, fired: nowMs - mtime >= IDLE_QUIET_MS}` and
 *   never fire on the seeding tick itself. A log already quiet at first
 *   sight — e.g. a subshell that was idle when the backend booted, or one
 *   reappearing after pruning — seeds consumed, so it never rings; only an
 *   mtime change re-arms (`fired = false`).
 * - mtime changed (grew) → new output: `clearWaiting` when the row was
 *   waiting (the watcher is the universal waiting-CLEARER WHERE IT CAN SEE —
 *   the log it stats is a plane-local file, so agent-node rows are skipped at
 *   the null-mtime guard and their hooked harnesses carry the clear in the
 *   `resumed` attention report instead), store the new mtime, re-arm.
 * - mtime unchanged AND quiet ≥ {@link IDLE_QUIET_MS} AND not yet fired →
 *   mark fired; hook-less harnesses additionally `notifySubshell(id,
 *   "turn_complete")` + `setWaiting(id)`. Hooked harnesses get nothing from
 *   the fire path — their hook owns the chip.
 * - Rows no longer listed → dropped from state (bounded memory); a
 *   reappearance re-seeds silently.
 *
 * A row whose log is missing (null mtime — not created yet) is skipped
 * entirely: there is nothing to measure quietness against.
 */
export function createIdleWatcher(deps: IdleWatcherDeps): {
  /** One poll. Never rejects: every failure is logged, the next tick retries. */
  tick(nowMs: number): Promise<void>;
} {
  const state = new Map<string, IdleState>();

  async function processRow(row: IdleWatcherRow, nowMs: number): Promise<void> {
    const mtime = await deps.statMtimeMs(row.id);
    if (mtime === null) return; // no log yet — nothing to measure

    const seen = state.get(row.id);
    if (!seen) {
      // Seed consumed-when-already-quiet: first sight never fires, and a log
      // that is already past the quiet window (idle at boot, or a pruned row
      // reappearing) stays consumed — the boot ring the spec forbids. Growth
      // below is the only re-arm.
      state.set(row.id, { mtime, fired: nowMs - mtime >= IDLE_QUIET_MS });
      return;
    }

    if (mtime !== seen.mtime) {
      // Activity since the last tick: whatever "waiting for you" state exists
      // is stale — cleared for every harness, hooked or not. Any change (not
      // just growth) counts: a recreated log is also new activity.
      //
      // SETTLE GRACE: a hook-fired chip is stamped DURING the turn's trailing
      // output (Claude's Stop hook runs before the TUI's final redraw
      // flushes), so growth within IDLE_SETTLE_MS of the stamp is that same
      // turn's tail, not the operator replying — the live bug this guard
      // fixes: the chip was cleared by its own turn within 3 s.
      if (row.waitingSince !== null && nowMs - Date.parse(row.waitingSince) >= IDLE_SETTLE_MS) {
        await deps.clearWaiting(row.id);
      }
      seen.mtime = mtime;
      seen.fired = false; // re-armed for the next quiet period
      return;
    }

    if (nowMs - mtime >= IDLE_QUIET_MS && !seen.fired) {
      seen.fired = true; // consume the fire even when the push path below skips it
      if (!deps.harnessHasHooks(row.harnessId)) {
        await deps.notifySubshell(row.id, "turn_complete");
        await deps.setWaiting(row.id);
      }
    }
  }

  async function tick(nowMs: number): Promise<void> {
    let rows: IdleWatcherRow[];
    try {
      rows = await deps.listRows();
    } catch (err) {
      logger.withError(err).warn("idle watcher: listRows failed; retrying next tick");
      return;
    }

    const alive = new Set<string>();
    for (const row of rows) {
      if (row.alive !== 1) continue; // dead/paused rows are reconcile's business
      alive.add(row.id);
      try {
        await processRow(row, nowMs);
      } catch (err) {
        // One row's failing stat/push/waiting write must not stall the loop.
        logger.withError(err).warn(`idle watcher: row ${row.id} failed; continuing`);
      }
    }

    // Bound memory: forget subshells that left the running list.
    for (const id of state.keys()) {
      if (!alive.has(id)) state.delete(id);
    }
  }

  return { tick };
}
