import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isNodeSubshellId, SSH_COMPLETED_RUN_RETENTION_MS, type SshRunFactsWire } from "@internal/subshell-protocol";
import {
  buildRunFacts,
  ensureSshDirs,
  listRunIds,
  readRun,
  removeRunDir,
  type SshRunState,
  writeRunState,
} from "./ssh-run-store.js";

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
/**
 * Crash reconciliation for runs the RECORD keeps but no supervised process
 * owns: every state claiming `accepted`/`running` outside `liveRunIds` reads
 * back `unknown`. The same function serves the boot pass (live set empty) and
 * an hourly safety pass (live set from the in-process supervisor), which is
 * why it lives beside the sweeps rather than only on the class — retention
 * wiring must not have to conjure a supervisor (and its ssh-binary
 * resolution) to finish a dead run's record. Never a restart, never a retry,
 * never a claim about what an orphan may have done remotely. Returns the
 * facts it changed, for any caller that wants to report the reconciliation.
 */
export function reconcileUnsupervisedRuns(
  dataDir: string,
  liveRunIds: ReadonlySet<string>,
  nowMs: number = Date.now(),
): SshRunFactsWire[] {
  const out: SshRunFactsWire[] = [];
  ensureSshDirs(dataDir);
  for (const id of listRunIds(dataDir)) {
    if (liveRunIds.has(id)) continue;
    const rec = readRun(dataDir, id);
    if (!rec) continue;
    if (rec.state.lifecycle === "accepted" || rec.state.lifecycle === "running") {
      const state: SshRunState = { ...rec.state, lifecycle: "unknown", finishedAtMs: nowMs };
      writeRunState(dataDir, state);
      out.push(buildRunFacts(state));
    }
  }
  return out;
}

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
 * Sweep stranded connection-test probe configs under `<dataDir>/ssh/probes/`
 * (review M3). The probe is transient by construction - `ssh-test` writes it
 * `O_EXCL` and unlinks it in a `finally` - but an uncaught crash between the
 * create and the unlink leaves a 0600 rendered config that carries the
 * approved destination's host facts (host, port, user, identity/known-hosts
 * refs, the ProxyJump chain). `ssh-test`'s comment promised "a lingering
 * rendered config is swept with the ssh subtree by retention"; this IS that
 * sweep. Age is the file's own mtime (a probe config is written once); a file
 * younger than the window is left (an in-flight probe's config is live for at
 * most the 30-second probe budget, far under the window), an unparseable name
 * is skipped, and a symlink leaf is refused, never chased. The `<uuid>.config`
 * name grammar is this sweep's own contract (the probe mints `randomUUID()`),
 * so the matcher is the name form, not the subshell-id grammar. NEVER throws.
 */
export function sweepSshProbes(dataDir: string, nowMs: number = Date.now()): { deleted: number } {
  let deleted = 0;
  const dir = join(dataDir, "ssh", "probes");
  const PROBE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.config$/i;
  try {
    const names = readdirSync(dir);
    for (const name of names) {
      try {
        if (!PROBE_NAME.test(name)) continue; // only names the probe could have written
        const path = join(dir, name);
        const st = lstatSync(path);
        if (!st.isFile()) continue; // a symlink leaf is never chased
        if (nowMs - st.mtimeMs < SSH_COMPLETED_RUN_RETENTION_MS) continue;
        unlinkSync(path);
        deleted += 1;
      } catch {
        // one bad entry never stops the sweep
      }
    }
  } catch {
    // probes dir absent: no connection test has run on this node
  }
  return { deleted };
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
