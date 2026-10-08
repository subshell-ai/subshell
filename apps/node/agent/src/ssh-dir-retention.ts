import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.js";
import { pathAllowed } from "./path-policy.js";
import { isSubshellId, type SubshellMetaStore } from "./subshell-meta.js";

/**
 * Node-side sweep of orphaned per-pane ssh config dirs — the agent's own
 * pass over `<dataDir>/ssh/<id>` (spec 2026-10-07 ssh-anywhere, decision 4's
 * machine-side half).
 *
 * **Why this exists on the node at all.** An ssh pane's generated config is
 * a DIRECTORY (`<dataDir>/ssh/<id>/config`), but the plane-commanded
 * `remove_paths` executor unlinks FILES only — so a delete-after-death on an
 * AGENT node removed the config and left the empty per-pane dir forever
 * (the local twin of that leak was closed plane-side in the same wave; this
 * is the machine's copy of the rule, same doctrine as
 * `pane-log-retention.ts`). Nothing else ever names these paths: the id is
 * retired, the row is gone, and the dir outlives every fact that explains it.
 *
 * The rules, each inherited from the pane-log sweep's doctrines:
 *
 * - **Only immediate children of `<dataDir>/ssh` whose name passes
 *   `isSubshellId`.** Nothing else in the tree is ours; a name that is not
 *   a pane id is nobody's to remove. The gate is hex digits and hyphens
 *   only (`/^[0-9a-fA-F-]{1,64}$/`, uppercase hex included), so a name
 *   carries no separator and no dot: the join cannot escape the dir, and
 *   `pathAllowed`
 *   re-checks anyway — the `remove_paths` rule, which is what refuses a
 *   symlinked `ssh` parent pointing outside the data dir.
 * - **Never follow a symlink** (`lstat` first: a leaf whose name looks like
 *   an id is skipped with a log line, and a `rm -rf` never runs through it).
 * - **A tracked pane's dir survives** whatever its mtime says: `meta.list()`
 *   is the record of live AND queued panes (the exit watcher forgets only on
 *   death), so a running pane's config is untouchable even mid-restart.
 * - **Age floor, not a retention window:** a dir younger than one hour is
 *   kept. This guards the `execLaunch` write-before-meta-record window — a
 *   pane that launched seconds ago has a dir and no meta yet, and the
 *   tracked-pane rule alone could not save it. Unlike the pane-log sweep
 *   there is no operator window here and no keep-forever pair: a dead pane's
 *   empty config dir is pure garbage, and one hour is the grace, not a
 *   policy. That is also why the daemon schedules this OUTSIDE the log
 *   sweep's `forever` gate.
 * - **Total by construction:** every fs failure costs one log line and the
 *   pass continues; an absent `ssh` dir is a silent no-op (a node that has
 *   never hosted an ssh pane).
 */

const HOUR_MS = 3_600_000;

/** Younger than this, the dir is kept: the launch write→meta-record grace. */
export const ORPHAN_SSH_DIR_MIN_AGE_MS = HOUR_MS;

/** The dir the sweep walks; exported so the daemon, tests and the plane-side twin name it from one place. */
export function sshDirsDir(dataDir: string): string {
  return join(dataDir, "ssh");
}

/**
 * Remove per-pane ssh config dirs no pane owns anymore.
 *
 * @param dataDir - the node's data dir; the sweep touches only `<dataDir>/ssh/<valid-id>`.
 * @param meta - the launch records; `list()` IS "live or queued here" — a
 *   recorded id's dir is never garbage. (Narrowed to `list` exactly as
 *   `pane-log-retention.ts` narrows it, so a fake-meta test needs no store.)
 * @param nowMs - epoch-ms clock; the age floor is judged against THIS, so a
 *   test pins the boundary without sleeping.
 * @returns the number of dirs removed. Never rejects on fs failures (only a
 *   throwing `meta.list` can reject, same posture as the pane-log sweep, and
 *   the daemon's `.catch` covers that).
 */
export async function sweepOrphanSshDirs(
  dataDir: string,
  meta: Pick<SubshellMetaStore, "list">,
  nowMs: number,
): Promise<{ removed: number }> {
  const dir = sshDirsDir(dataDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      log(`ssh dir sweep: could not read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { removed: 0 };
  }
  const candidates = names.filter((n) => isSubshellId(n));
  if (candidates.length === 0) return { removed: 0 }; // nothing id-shaped — skip even the meta read

  // The tracked set FIRST: live AND queued panes are never garbage, whatever
  // their dir says. A record with a dead socket (node was offline for the
  // death) keeps the dir until the death report lands — the NEXT pass then
  // ages it out; unknown-tracked is kept, not guessed.
  const tracked = new Set((await meta.list()).map((m) => m.subshellId));

  let removed = 0;
  for (const name of candidates) {
    if (tracked.has(name)) continue;
    const path = join(dir, name);
    let st;
    try {
      st = await lstat(path);
    } catch (err) {
      // A dir that vanished under us is the sweep's job done by someone else.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`ssh dir sweep: could not stat ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (st.isSymbolicLink()) {
      // An id-named symlink is not ours to follow: log and leave it (a
      // hostile or accidental link out of the tree must not be `rm -rf`ed
      // through — the pane-log sweep's symlink-leaf refusal, made explicit).
      log(`ssh dir sweep: ${name} is a symlink; not following it`);
      continue;
    }
    if (st.mtimeMs > nowMs - ORPHAN_SSH_DIR_MIN_AGE_MS) continue; // the launch write→meta grace
    if (!(await pathAllowed(path, [dataDir]))) {
      // The name gate makes this unreachable for a plain child; it is the
      // belt for a symlinked `ssh` PARENT (realpath lands outside the data
      // dir), which a recursive delete must never follow.
      log(`ssh dir sweep: ${path} failed the path policy; left in place`);
      continue;
    }
    try {
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log(`ssh dir sweep: could not remove ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (removed > 0) log(`ssh dir sweep: removed ${removed} orphaned config dir(s)`);
  return { removed };
}
