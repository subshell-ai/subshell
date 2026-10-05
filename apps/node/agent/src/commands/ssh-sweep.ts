import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PANE_LOG_FILE_FLAG,
  peekSshRunSupervisor,
  reconcileUnsupervisedRuns,
  rotateTerminalLogIfNeeded,
  shellQuote,
  sweepCompletedRuns,
  sweepSshTerminalState,
  terminalLogPath,
} from "@internal/pane-runtime";
import { isNodeSubshellId } from "@internal/subshell-protocol";
import { log } from "../log.js";
import { selfInvocation } from "../self-invoke.js";
import type { CommandContext } from "./context.js";

/**
 * The SSH state sweep: boot + hourly, NEVER throws (posture copied from
 * `sweepStaleTransfers` / the pane-log retention pass — a broken sweep must
 * not cost the node its connection). Four bounded jobs, shallow inside the
 * subtrees the SSH surface owns:
 *
 * 1. **Reconcile** run records no supervised process owns → `unknown`
 *    (the crash-between-accept-and-spawn and daemon-restart cases; never a
 *    retry, never a kill-by-reused-pid).
 * 2. **Rotate** oversized live terminal logs: rename the segment, bump the
 *    log generation (held cursors come back `cursor-expired`, never silently
 *    reused), and RE-ARM the capture — deliberately without `-o`, because the
 *    old child still holds the rotated inode's fd and a `-o` re-arm would
 *    silently no-op while bytes keep landing in the dead segment. Bytes are
 *    never lost to the swap: the old child appends to the renamed inode until
 *    the replacement takes the pipe.
 * 3. **Sweep** completed/unknown run subtrees past the 7-day retention.
 * 4. **Sweep** dead terminals' ssh-subtree state + rotated segments past the
 *    same window (the live half of a terminal's log ages out with the
 *    pane-log retention pass, which owns `<id>.log` naming in `subshells/`).
 *
 * Daemon wiring is requested in the handoff report (boot + hourly, unref'd
 * timer) — this file owns the pass, the daemon owns the schedule.
 */

/** A liveness probe for terminal panes; a probe that THROWS counts LIVE (unknown is not dead). */
async function terminalPaneLiveness(ctx: CommandContext, subshellId: string): Promise<boolean> {
  try {
    const meta = await ctx.meta.get(subshellId);
    if (!meta) return false; // no launch record: this daemon did not start a pane under this id
    return await ctx.tmux.hasSubshell(meta.socket, subshellId);
  } catch {
    return true; // tmux did not answer: unknown is not dead, and rotation of a live pane would fight its child
  }
}

/** Execute one SSH sweep pass (safe at boot, safe hourly, safe never-wired-but-asked). */
export async function sweepSshState(ctx: CommandContext): Promise<void> {
  try {
    const dataDir = ctx.config.dataDir;
    // (1) reconcile — only ids the in-process supervisor (if one exists) does
    // not own. A never-built supervisor means no runs were started since boot,
    // so the empty live set is the right answer, not a guess.
    const live = new Set(peekSshRunSupervisor(dataDir)?.liveRunIds() ?? []);
    for (const facts of reconcileUnsupervisedRuns(dataDir, live, ctx.nowMs())) {
      log(`ssh run ${facts.runId} reconciled to unknown (no supervised process owns it)`);
    }

    // (2) rotate live terminal logs (the sweep cannot await the liveness
    // probe inside the pane-runtime helper, so the caller decides per pane).
    const termDir = join(dataDir, "ssh", "terminals");
    try {
      for (const name of readdirSync(termDir)) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        if (!isNodeSubshellId(id)) continue;
        try {
          if (!(await terminalPaneLiveness(ctx, id))) continue;
          const rotated = rotateTerminalLogIfNeeded(dataDir, id);
          if (rotated === null) continue;
          const meta = await ctx.meta.get(id);
          if (!meta) continue;
          // RE-ARM replaces the capture child (no `-o`): the rotated file is
          // gone from the name, and the fresh `pane-log` child creates the
          // new 0600 log on its first write.
          const child = selfInvocation("pane-log");
          const append = `(umask 077; exec ${[child.command, ...child.args].map(shellQuote).join(" ")} ${PANE_LOG_FILE_FLAG} ${shellQuote(terminalLogPath(dataDir, id))})`;
          await ctx.tmux.runAsync(["-L", meta.socket, "pipe-pane", "-t", id, append], {});
          log(`ssh terminal ${id} log rotated to generation ${rotated.logGeneration}`);
        } catch {
          // one pane's rotation failure never stops the pass
        }
      }
    } catch {
      // no terminals dir yet: this node never hosted an SSH terminal
    }

    // (3) completed-run retention.
    sweepCompletedRuns(dataDir, ctx.nowMs());

    // (4) dead-terminal ssh-subtree state, gated on the SAME unknown-not-dead
    // probe (sync closure over the answers the async probes already collected).
    const liveness = new Map<string, boolean>();
    try {
      for (const name of readdirSync(termDir)) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        if (!isNodeSubshellId(id)) continue;
        liveness.set(id, await terminalPaneLiveness(ctx, id));
      }
    } catch {
      // dir gone mid-sweep: nothing further to do here
    }
    sweepSshTerminalState(dataDir, ctx.nowMs(), {
      isPaneLive: (id) => liveness.get(id) ?? true, // unanswered: alive (fail closed)
    });
  } catch (err) {
    log(`ssh sweep failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}
