import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BACKUP_RESTORE_DEFAULTS } from "@internal/subshell-protocol";
import type { BackupOpts } from "@/commands/backup-options.js";
import { askPassword, type PasswordDeps, readPasswordFile } from "@/commands/backup-password.js";
import { beginBackupCapture } from "@/services/backup-capture-lock.js";
import { listLocalBackups } from "@/services/backup-catalog.js";
import { createInstanceBackup } from "@/services/backups/index.js";
import type { InstancePaths } from "@/services/backups/types.js";
import { instanceBackupConfig, instanceBackupPaths } from "@/services/instance-backup-source.js";
import { SERVER_VERSION } from "@/version.js";

export interface BackupDeps extends PasswordDeps {
  log: (line: string) => void;
  error: (line: string) => void;
  confirm?: (question: string, def: boolean) => boolean | null | Promise<boolean | null>;
  source?: () => InstancePaths;
  effectiveConfig?: () => Record<string, string>;
  capture?: () => () => void;
}

/** Full-instance capture; legacy database snapshots are restore-only. */
export async function runBackup(opts: BackupOpts, deps: BackupDeps): Promise<number> {
  let release: (() => void) | undefined;
  try {
    const source = (deps.source ?? instanceBackupPaths)();
    if (opts.list) {
      if (opts.output || opts.passwordFile || opts.encrypt || opts.databaseOnly)
        throw new Error("--list accepts only --json");
      const backups = await listLocalBackups(source.dataDir);
      if (opts.json) deps.log(JSON.stringify({ backups }));
      else
        for (const file of backups)
          deps.log(
            `${file.createdAt} · ${file.legacyDatabaseOnly ? "Database-only snapshot" : "Full instance archive"} · ${file.path}`,
          );
      return 0;
    }
    if (opts.databaseOnly)
      throw new Error("--database-only is no longer supported; backups are full instance archives");
    let encrypt = opts.encrypt || !!opts.passwordFile;
    if (!encrypt && !opts.json && deps.isTTY && deps.confirm) {
      const answer = await deps.confirm("Encrypt this full backup with a password?", BACKUP_RESTORE_DEFAULTS.encrypt);
      if (answer === null) throw new Error("Cancelled; nothing was changed.");
      encrypt = answer;
    }
    const password = opts.passwordFile
      ? readPasswordFile(opts.passwordFile)
      : encrypt
        ? await askPassword(
            "Backup encryption password (at least 15 characters; use a unique random password or passphrase)",
            true,
            { ...deps, isTTY: !opts.json && deps.isTTY },
          )
        : undefined;
    const destinationPath = resolve(opts.output ?? freeArchiveName(join(source.dataDir, "backups"), encrypt));
    release = (deps.capture ?? beginBackupCapture)();
    const result = await createInstanceBackup({
      source,
      destinationPath,
      effectiveConfig: (deps.effectiveConfig ?? instanceBackupConfig)(),
      password,
    });
    if (opts.json) deps.log(JSON.stringify(result));
    else
      deps.log(
        `Full instance backup: ${destinationPath} (${statSync(destinationPath).size} bytes)${encrypt ? " — encrypted" : ""}`,
      );
    return 0;
  } catch (failure) {
    deps.error(`subshell-server: could not back up: ${failure instanceof Error ? failure.message : String(failure)}`);
    return 1;
  } finally {
    release?.();
  }
}

function freeArchiveName(dir: string, encrypted: boolean): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const base = join(dir, `subshell-instance-v${SERVER_VERSION}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  const suffix = encrypted ? ".tar.gz.enc" : ".tar.gz";
  for (let n = 0; n < 1000; n++) {
    const path = `${base}${n ? `-${n + 1}` : ""}${suffix}`;
    if (!existsSync(path)) return path;
  }
  throw new Error(`could not find a free archive name in ${dirname(base)}`);
}
