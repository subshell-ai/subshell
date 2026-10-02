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
      releaseWriters?.();
      releaseWriters = undefined;
    }
  };
}

export function beginBackupCapture(): () => void {
  return acquireInstanceLock(captureLockPath(), "backup");
}
