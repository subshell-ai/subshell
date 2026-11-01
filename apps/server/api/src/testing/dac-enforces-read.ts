import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";

/**
 * Whether a chmod-000 file is actually unreadable HERE. A root process carries
 * DAC_OVERRIDE and reads it anyway (the CI runners are root — measured on
 * PR #348's first shard, where the unreadable-copy cells failed as designed
 * scenarios the runner cannot stage), so the cells that stage unreadability
 * through file modes skip under such a process rather than assert a lie.
 */
export const DAC_ENFORCES_READ = (() => {
  mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
  const probe = join(NODE_ARTIFACTS_DIR, `.dac-probe-${process.pid}`);
  try {
    writeFileSync(probe, "x");
    chmodSync(probe, 0o000);
    readFileSync(probe);
    return false; // the mode did not stop the read: no DAC enforcement here
  } catch {
    return true;
  } finally {
    // Restore a mode unlink behaves under before removing it.
    chmodSync(probe, 0o644);
    rmSync(probe, { force: true });
  }
})();
