import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isNodeSubshellId, SSH_COMPLETED_RUN_RETENTION_MS } from "@internal/subshell-protocol";
import { listRunIds, readRun, removeRunDir } from "./ssh-run-store.js";

/**
 * The completed-run retention sweep, node-side (SSH-SUPPORT.md §3's retention
 * row: seven days, boot + hourly, imitating the `pane-log-retention.ts`
 * posture and its NEVER-THROW contract — a broken sweep must not cost the
 * node its connection, and the daemon wires the schedule via a seam request,
 * exactly like the transfer staging sweep).
 *
 * Age anchors on `finishedAtMs` (falling back to the acceptance stamp for a
 * record that died before it could write a finish). A state this sweep
 * cannot READ is a state it cannot prove completed, and unknown is not
 * dead: unreadable and still-active records are left for the next pass.
 * Deleting a run dir deletes the WHOLE subtree — the retention window is the
 * replay-protection window too, and past it the plane's DB rows are the
 * durable history (the run-id grammar means nothing here can escape the
 * subtree: `removeRunDir` re-guards, and this sweep only names ids that pass
 * `isNodeSubshellId`).
 */
export function sweepCompletedRuns(dataDir: string, nowMs: number = Date.now()): { deleted: number } {
  const deleted = { deleted: 0 };
  try {
    for (const id of listRunIds(dataDir)) {
      try {
        const rec = readRun(dataDir, id);
        if (!rec) continue; // unreadable half-pair: unknown is not deletable
        const { state } = rec;
        if (state.lifecycle !== "completed" && state.lifecycle !== "unknown") continue;
        const ageMs = nowMs - (state.finishedAtMs ?? rec.acceptance.acceptedAtMs);
        if (ageMs < SSH_COMPLETED_RUN_RETENTION_MS) continue;
        removeRunDir(dataDir, id);
        deleted.deleted += 1;
      } catch {
        // one unreadable subtree never stops the sweep
      }
    }
  } catch (err) {
    // listRunIds itself is throw-free; this is the last-ditch promise.
    void err;
  }
  return deleted;
}

/**
 * Sweep stranded SSH-terminal leftovers under `<dataDir>/ssh/terminals/`:
 * per-pane state files whose log names point at nothing left on disk. The
 * PANE log itself lives in the conventional `<dataDir>/subshells/` subtree
 * (so the existing tail/replay machinery works unchanged) and ages out with
 * the pane-log retention pass; this sweep owns only the ssh subtree's
 * `*.log.1` rotated segments and state files, gated on the state being older
 * than the same retention window. NEVER throws.
 */
export function sweepSshTerminalState(
  dataDir: string,
  nowMs: number,
  opts: { isPaneLive?: (subshellId: string) => boolean } = {},
): { deleted: number } {
  let deleted = 0;
  const dir = join(dataDir, "ssh", "terminals");
  try {
    const names = readdirSync(dir);
    for (const name of names) {
      try {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        if (!isNodeSubshellId(id)) continue; // only ids this plane could have minted, like every sweep
        const st = lstatSync(join(dir, name));
        if (!st.isFile()) continue; // a symlink leaf is never chased
        if (nowMs - st.mtimeMs < SSH_COMPLETED_RUN_RETENTION_MS) continue;
        if (opts.isPaneLive?.(id)) continue; // unknown-not-dead: a probe that throws counts LIVE (caller's contract)
        unlinkSync(join(dir, name));
        deleted += 1;
        // The rotated sibling in subshells/ (`<id>.log.1`) is pane-named, so
        // the pane-log sweep's `<valid-id>.log` matcher misses it; this sweep
        // owns it (it exists only because rotation created it).
        const rotated = join(dataDir, "subshells", `${id}.log.1`);
        try {
          const rSt = lstatSync(rotated);
          if (rSt.isFile()) unlinkSync(rotated);
        } catch {
          // no rotated segment: nothing to clean
        }
      } catch {
        // one bad entry never stops the sweep
      }
    }
  } catch {
    // terminals dir absent: this node never hosted an SSH terminal
  }
  return { deleted };
}
