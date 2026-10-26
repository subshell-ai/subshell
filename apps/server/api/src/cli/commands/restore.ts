import { executeRestore, type RestoreDeps } from "@/modules/backups/restore.js";
import type { RestoreOpts } from "@/modules/backups/restore-options.js";
import { promptBackupPassword } from "./backup-password.js";

/** Run the shared restore workflow with terminal password entry available. */
export function runRestore(opts: RestoreOpts, deps: RestoreDeps): Promise<number> {
  return executeRestore(opts, { ...deps, secretPrompt: deps.secretPrompt ?? promptBackupPassword });
}
