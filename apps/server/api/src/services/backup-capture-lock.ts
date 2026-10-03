import { join } from "node:path";
import { serverConfigDir } from "@/config-env.js";
import { IS_TEST, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { acquireInstanceLock } from "@/services/instance-state-lock.js";

const captureLockPath = () => join(IS_TEST ? SUBSHELL_SERVER_DATA_DIR : serverConfigDir(), "backup-capture.lock");
let writers = 0;
let releaseWriters: (() => void) | undefined;

/** Nested host writes share one exclusion, while backups require exclusive capture. */
export function beginBackupStateWrite(): () => void {
  if (writers === 0) releaseWriters = acquireInstanceLock(captureLockPath(), "state-write");
  writers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    writers--;
    if (writers === 0) {
      // CLEAR THE STORED RELEASE BEFORE CALLING IT. Releasing can throw when
      // the lock file was removed or replaced out from under this process;
      // doing it last used to leave `releaseWriters` set with `writers`
      // already zero, so the next acquisition skipped the acquire path that
      // would have detected the leaked handle and the state-write mutex
      // stayed conflicted for the life of the process.
      const release = releaseWriters;
      releaseWriters = undefined;
      release?.();
    }
  };
}

export function beginBackupCapture(): () => void {
  return acquireInstanceLock(captureLockPath(), "backup");
}
