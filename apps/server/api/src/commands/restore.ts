import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BACKUP_RESTORE_DEFAULTS } from "@internal/subshell-protocol";
import type { RestoreOpts } from "@/commands/backup-options.js";
import { askPassword, type PasswordDeps, readPasswordFile } from "@/commands/backup-password.js";
import { syncPortListening } from "@/commands/status.js";
import { parseEnvFile } from "@/config-env.js";
import { SERVER_PORT } from "@/constants.js";
import { controlService, queryService, type ServiceDeps, type ServiceState } from "@/service.js";
import { prepareBackupAdminRecovery } from "@/services/backup-admin-recovery.js";
import {
  createRestoreStage,
  type StageRecord,
  saveRestoreStage,
  stagedBackupFromRecord,
} from "@/services/backup-staging.js";
import { restoreConfig } from "@/services/backups/config.js";
import {
  instanceRestoreJournalPath,
  readInstanceRestoreResult,
  restoreInstanceBackup,
  rollbackInstanceRestore,
  stageInstanceBackup,
  validateRestoreConfigOverrides,
} from "@/services/backups/index.js";
import { replacementsFor } from "@/services/backups/journal.js";
import { assertSafeHostPath } from "@/services/backups/paths.js";
import type { InstancePaths, StagedInstanceBackup } from "@/services/backups/types.js";
import { instanceBackupPaths } from "@/services/instance-backup-source.js";
import { acquireInstanceLock, readInstanceLock } from "@/services/instance-state-lock.js";
import { installedRestoreServicePaths } from "./restore-service.js";
import {
  boundedWait,
  describeArchive,
  encrypted,
  listPreparedRestoreStages,
  publicStage,
  readLocalRestoreStage,
  restoreInspectionDefaults,
  startDetachedServer,
} from "./restore-support.js";
import {
  assertNoDatabaseUsers,
  assertNoUpdateTransaction,
  assertRunningRestoreServiceOwner,
  liveRestorePanes,
  preservableRestorePanes,
  type RestorePane,
  requireRestoreSessionConsent,
  restoredListenPort,
  retireRestorePanes,
  sharesRestoreState,
  terminateRestorePanes,
} from "./restore-system.js";

export interface RestoreDeps extends PasswordDeps {
  log: (line: string) => void;
  error: (line: string) => void;
  service: ServiceDeps;
  confirm?: (question: string, def: boolean) => boolean | null | Promise<boolean | null>;
  prompt?: (question: string, def: string) => string | null | Promise<string | null>;
  source?: () => InstancePaths;
  manager?: { query(): ServiceState; stop(): { code: number; err: string }; start(): { code: number; err: string } };
  servicePaths?: (state: ServiceState) => InstancePaths;
  stageArchive?: typeof stageInstanceBackup;
  panes?: (databasePath: string) => Promise<RestorePane[]>;
  terminatePanes?: (panes: RestorePane[]) => void;
  checkDatabaseUsers?: (path: string) => void;
  probePort?: (host: string, port: number) => boolean | null;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  startDetached?: (
    configDir: string,
    destination: InstancePaths,
    legacy: boolean,
  ) => { stop(): void; exited(): boolean; pid: number };
}

export async function runRestore(opts: RestoreOpts, deps: RestoreDeps): Promise<number> {
  let stage: StagedInstanceBackup | undefined;
  let ownedStage = false;
  let applied = false;
  let legacy = false;
  let journalPath: string | undefined;
  const releases: (() => void)[] = [];
  let rollbackLockPaths: string[] = [];
  let stopStartedService: (() => { code: number; err: string }) | undefined;
  let child: ReturnType<NonNullable<RestoreDeps["startDetached"]>> | undefined;
  const pause = deps.sleep ?? ((ms) => Bun.sleep(ms));
  const probe = deps.probePort ?? syncPortListening;
  const timeout = deps.waitMs ?? 15_000;
  const interactive = !opts.json && deps.isTTY === true;
  try {
    if (opts.discardStaged) {
      const discarded = readLocalRestoreStage(opts.discardStaged, true);
      await stagedBackupFromRecord(discarded).cleanup();
      deps.log(
        opts.json ? JSON.stringify({ id: discarded.id, discarded: true }) : `Discarded restore ${discarded.id}.`,
      );
      return 0;
    }
    if (opts.listStaged) {
      const stages = listPreparedRestoreStages();
      if (opts.json) deps.log(JSON.stringify({ stages }));
      else
        for (const row of stages)
          deps.log(
            `${row.id} — ${row.manifest.completedAt} — ${row.legacyDatabaseOnly ? "database-only" : "full instance"} — expires ${new Date(row.expiresAt).toISOString()}`,
          );
      return 0;
    }
    let record: StageRecord | undefined;
    if (opts.staged) {
      record = readLocalRestoreStage(opts.staged);
      stage = stagedBackupFromRecord(record);
      if (!opts.inspect && !record.prepared)
        throw new Error("Restore upload is not prepared. Complete the restore form before stopping the server.");
    } else {
      if (!opts.archive) throw new Error("Specify an archive or --staged <UUID>.");
      let password = opts.passwordFile ? readPasswordFile(opts.passwordFile) : undefined;
      if (password === undefined && (await encrypted(opts.archive)))
        password = await askPassword("Backup decryption password", false, { ...deps, isTTY: interactive });
      if (opts.prepare) {
        record = await createRestoreStage(resolve(opts.archive), `cli:${process.getuid?.() ?? "local"}`, password);
        stage = stagedBackupFromRecord(record);
      } else stage = await (deps.stageArchive ?? stageInstanceBackup)(resolve(opts.archive), password);
      ownedStage = true;
    }
    legacy = stage.legacyDatabaseOnly;
    if (opts.inspect) {
      const inspection = record
        ? publicStage(record)
        : {
            manifest: stage.manifest,
            admins: stage.admins,
            legacyDatabaseOnly: stage.legacyDatabaseOnly,
            ...restoreInspectionDefaults(stage, (deps.source ?? instanceBackupPaths)()),
          };
      if (opts.json) deps.log(JSON.stringify(inspection));
      else {
        describeArchive(stage, deps.log);
        for (const admin of stage.admins) deps.log(`Administrator: ${admin.id} (${admin.email})`);
      }
      return 0;
    }
    const source = (deps.source ?? instanceBackupPaths)();
    const sourceConfigDir = dirname(source.configPath ?? join(source.dataDir, "config.env"));
    const preparedDestination = record?.destination;
    if (
      preparedDestination &&
      ((opts.configDir && resolve(opts.configDir) !== dirname(preparedDestination.configPath ?? "")) ||
        (opts.dataDir && resolve(opts.dataDir) !== preparedDestination.dataDir) ||
        (opts.databasePath && resolve(opts.databasePath) !== preparedDestination.databasePath))
    )
      throw new Error("The prepared destination is fixed; prepare another archive to change paths.");
    const configDir = resolve(
      opts.configDir ?? (preparedDestination?.configPath ? dirname(preparedDestination.configPath) : sourceConfigDir),
    );
    const dataDir = resolve(opts.dataDir ?? preparedDestination?.dataDir ?? source.dataDir);
    const destination: InstancePaths = {
      dataDir,
      databasePath: resolve(
        opts.databasePath ??
          preparedDestination?.databasePath ??
          (opts.dataDir ? join(dataDir, "subshell.db") : source.databasePath),
      ),
      configPath: join(configDir, "config.env"),
    };
    let mode = record?.choices?.mode ?? opts.mode ?? BACKUP_RESTORE_DEFAULTS.mode;
    const overrides = record?.choices?.configOverrides ?? opts.configOverrides ?? {};
    let start = opts.start ?? BACKUP_RESTORE_DEFAULTS.start;
    let recoverAdmin = opts.recoverAdmin;
    if (interactive && !opts.staged && !opts.yes) {
      if (!opts.mode && deps.prompt) {
        const choice = await deps.prompt("Restore mode (same-machine or migration)", mode);
        if (choice === null) throw new Error("Cancelled; nothing was changed.");
        if (choice !== "same-machine" && choice !== "migration")
          throw new Error("Restore mode must be same-machine or migration.");
        mode = choice;
      }
      if (
        !recoverAdmin &&
        deps.confirm &&
        (await deps.confirm(
          "Reset the password of an existing administrator for recovery?",
          BACKUP_RESTORE_DEFAULTS.recoverAdmin,
        ))
      ) {
        for (const admin of stage.admins) deps.log(`${admin.id} (${admin.email})`);
        const id = await deps.prompt?.("Administrator ID", stage.admins[0]?.id ?? "");
        if (!id) throw new Error("Select an existing administrator to recover.");
        recoverAdmin = id;
      }
    }
    validateRestoreConfigOverrides(overrides);
    if (stage.legacyDatabaseOnly && (mode !== "same-machine" || Object.keys(overrides).length))
      throw new Error("Database-only snapshots cannot migrate instance state or change addresses. Use a full archive.");
    if (recoverAdmin) {
      if (!stage.admins.some((admin) => admin.id === recoverAdmin))
        throw new Error("Select an administrator listed in the backup.");
      const password = opts.temporaryPasswordFile
        ? readPasswordFile(opts.temporaryPasswordFile)
        : await askPassword("Temporary administrator password", true, { ...deps, isTTY: interactive });
      await prepareBackupAdminRecovery(stage.databasePath, recoverAdmin, password);
    }
    if (interactive && opts.start === undefined && deps.confirm) {
      const answer = await deps.confirm("Start the server after restoring?", BACKUP_RESTORE_DEFAULTS.start);
      if (answer === null) throw new Error("Cancelled; nothing was changed.");
      start = answer;
    }
    // Complete validation and the concrete plan precede every service or target write.
    journalPath = instanceRestoreJournalPath(configDir);
    assertNoUpdateTransaction([source, destination]);
    if (existsSync(journalPath))
      throw new Error("A restore transaction is already pending; boot or recover that transaction first.");
    await assertSafeHostPath(journalPath);
    if (opts.staged && readInstanceRestoreResult(journalPath)?.transactionId === record?.id)
      throw new Error("This prepared restore transaction was already consumed; prepare another archive.");
    for (const replacement of replacementsFor(destination, crypto.randomUUID(), stage.legacyDatabaseOnly)) {
      await assertSafeHostPath(replacement.target);
      if (
        resolve(stage.dir) === replacement.target ||
        resolve(stage.dir).startsWith(`${replacement.target}/`) ||
        replacement.target.startsWith(`${resolve(stage.dir)}/`)
      )
        throw new Error("Restore destination overlaps its staging directory.");
    }
    let targetPort = SERVER_PORT;
    if (!stage.legacyDatabaseOnly) {
      const rendered = restoreConfig(
        readFileSync(join(stage.dir, "config", "config.env"), "utf8"),
        destination,
        overrides,
      );
      targetPort = Number(parseEnvFile(rendered).SERVER_PORT ?? SERVER_PORT);
    } else targetPort = restoredListenPort(destination, SERVER_PORT);
    if (opts.prepare) {
      if (!record) throw new Error("Restore preparation did not create a protected stage.");
      record.choices = { mode, configOverrides: overrides };
      record.destination = destination;
      record.recoveryUserId = recoverAdmin;
      record.prepared = true;
      saveRestoreStage(record);
      // Publish the public result before retaining it, so output failure cleans up.
      deps.log(
        opts.json
          ? JSON.stringify(publicStage(record))
          : `Prepared restore ${record.id}. Apply with subshell-server restore --staged ${record.id}.`,
      );
      ownedStage = false;
      return 0;
    }
    const affectsSource = sharesRestoreState(source, destination);
    const manager = deps.manager ?? {
      query: () => queryService(deps.service),
      stop: () => controlService(deps.service, "stop", { force: true }),
      start: () => controlService(deps.service, "start"),
    };
    const service = manager.query();
    const serviceSource = service.installed
      ? (deps.servicePaths ?? ((state) => installedRestoreServicePaths(state, deps.service)))(service)
      : undefined;
    const affectsService = !!serviceSource && sharesRestoreState(serviceSource, destination);
    const servicePort = serviceSource ? restoredListenPort(serviceSource, SERVER_PORT) : SERVER_PORT;
    const installedHere = !!serviceSource && destination.configPath === serviceSource.configPath;
    if (
      (opts.native || opts.nativePreflight) &&
      serviceSource &&
      (destination.configPath !== serviceSource.configPath ||
        destination.databasePath !== serviceSource.databasePath ||
        destination.dataDir !== serviceSource.dataDir)
    )
      throw new Error(
        "The installed service cannot boot this native restore destination. Use its configured config, database and data paths; no server was stopped or replaced.",
      );
    const panes = await (deps.panes ?? liveRestorePanes)(destination.databasePath);
    const keepPane = (pane: RestorePane) =>
      pane.nodeId !== "local" || !affectsService || service.paneSafety === "keeps";
    const preserved = preservableRestorePanes(destination.databasePath, stage, destination, mode, panes).filter(
      keepPane,
    );
    const preservedIds = new Set(preserved.map((pane) => pane.id));
    const affected = panes.filter((pane) => !preservedIds.has(pane.id));
    if (opts.nativePreflight) {
      requireRestoreSessionConsent(affected, opts.force === true);
      deps.log(
        opts.json
          ? JSON.stringify({
              ...publicStage(record as StageRecord),
              compatible: true,
              serviceInstalled: service.installed,
            })
          : "Native restore destination is compatible.",
      );
      return 0;
    }
    if (affectsService && service.state === "running") {
      if (!serviceSource?.configPath) throw new Error("Cannot prove the running service's config directory.");
      assertRunningRestoreServiceOwner(join(dirname(serviceSource.configPath), "instance-state.lock"), service.pid);
    }
    if (service.installed && start && !installedHere)
      throw new Error(
        "The installed service uses a different config directory. Use --no-start and start the restored instance explicitly; the service definition will not be changed.",
      );
    if (
      installedHere &&
      start &&
      stage.legacyDatabaseOnly &&
      (destination.databasePath !== serviceSource?.databasePath || destination.dataDir !== serviceSource?.dataDir)
    )
      throw new Error(
        "A database-only restore does not change config.env, so the installed service cannot start with different database or data paths. Use the configured paths or --no-start and start the restored destination explicitly.",
      );
    const lockPaths = [join(configDir, "instance-state.lock")];
    if (affectsSource && resolve(sourceConfigDir) !== configDir)
      lockPaths.push(join(sourceConfigDir, "instance-state.lock"));
    if (affectsService && serviceSource?.configPath)
      lockPaths.push(join(dirname(serviceSource.configPath), "instance-state.lock"));
    for (const path of lockPaths) {
      const owner = readInstanceLock(path);
      if (owner && (owner.kind !== "server" || !affectsService || !service.installed || service.pid !== owner.pid))
        throw new Error(
          `Instance is running or busy in process ${owner.pid}. Stop its unmanaged server before restoring.`,
        );
    }
    if (affectsSource && !service.installed && probe("127.0.0.1", SERVER_PORT) === true)
      throw new Error("An unmanaged server is still listening. Stop it before restoring.");
    describeArchive(stage, (line) => deps.error(line));
    deps.error(
      `Restore destination: database=${destination.databasePath}; data=${dataDir}; config=${destination.configPath}`,
    );
    deps.error(
      `Mode: ${mode}; ${affectsService ? "stop installed service" : "requires offline destination"}; ${start ? "start after replacement" : "leave stopped, pending boot confirmation"}.`,
    );
    deps.error(
      `Pane consequences: ${preserved.length} compatible sessions will be preserved; ${affected.filter((pane) => pane.nodeId === "local").length} local panes require termination; ${affected.filter((pane) => pane.nodeId !== "local").length} remote sessions cannot be preserved; stale running records from the backup will be retired.`,
    );
    if (affected.length && !opts.force) {
      if (
        !interactive ||
        !deps.confirm ||
        (await deps.confirm("Interrupt these panes and terminate the local panes?", false)) !== true
      )
        requireRestoreSessionConsent(affected, false);
    }
    if (
      !opts.yes &&
      (!interactive ||
        !deps.confirm ||
        (await deps.confirm("Replace the destination instance with this backup?", false)) !== true)
    )
      throw new Error("Replacement requires --yes or interactive confirmation; nothing was changed.");
    if (affectsService) {
      const stopped = manager.stop();
      if (stopped.code) throw new Error(`Could not stop the installed server: ${stopped.err.trim()}`);
      await boundedWait(
        () =>
          lockPaths.every((path) => !readInstanceLock(path)) &&
          manager.query().state !== "running" &&
          probe("127.0.0.1", servicePort) !== true,
        timeout,
        pause,
        "The server did not stop; restore was not applied.",
      );
    }
    for (const path of [...new Set(lockPaths)].sort()) releases.push(acquireInstanceLock(path, "restore"));
    const capturePaths = [join(configDir, "backup-capture.lock")];
    if (affectsSource) capturePaths.push(join(sourceConfigDir, "backup-capture.lock"));
    if (affectsService && serviceSource?.configPath)
      capturePaths.push(join(dirname(serviceSource.configPath), "backup-capture.lock"));
    for (const path of [...new Set(capturePaths)].sort()) releases.push(acquireInstanceLock(path, "restore"));
    rollbackLockPaths = [...new Set([...lockPaths, ...capturePaths])].sort();
    assertNoUpdateTransaction([source, destination]);
    (deps.checkDatabaseUsers ?? assertNoDatabaseUsers)(destination.databasePath);
    // Recheck after stop/lock: a pane created during consent still requires explicit consent.
    const latestPanes = await (deps.panes ?? liveRestorePanes)(destination.databasePath);
    const originalIds = new Set(panes.map((pane) => pane.id));
    requireRestoreSessionConsent(
      latestPanes.filter((pane) => !originalIds.has(pane.id)),
      opts.force === true,
    );
    const latestPreserved = preservableRestorePanes(
      destination.databasePath,
      stage,
      destination,
      mode,
      latestPanes,
    ).filter(keepPane);
    const latestPreservedIds = new Set(latestPreserved.map((pane) => pane.id));
    const affectedIds = new Set(affected.map((pane) => pane.id));
    const latestAffected = latestPanes.filter((pane) => !latestPreservedIds.has(pane.id));
    requireRestoreSessionConsent(
      latestAffected,
      opts.force === true || latestAffected.every((pane) => affectedIds.has(pane.id)),
    );
    (deps.terminatePanes ?? terminateRestorePanes)(latestAffected);
    retireRestorePanes(
      destination.databasePath,
      latestAffected.map((pane) => pane.id),
    );
    retireRestorePanes(
      stage.databasePath,
      undefined,
      latestPreserved.map((pane) => pane.id),
    );
    const result = await restoreInstanceBackup(stage, {
      destination,
      mode,
      configOverrides: overrides,
      journalPath,
      transactionId: opts.staged ? record?.id : undefined,
    });
    applied = true;
    await stage.cleanup();
    stage = undefined;
    while (releases.length) releases.pop()?.();
    if (start) {
      if (installedHere) {
        const startPaths = (deps.servicePaths ?? ((state) => installedRestoreServicePaths(state, deps.service)))(
          manager.query(),
        );
        if (
          startPaths.configPath !== destination.configPath ||
          startPaths.databasePath !== destination.databasePath ||
          startPaths.dataDir !== destination.dataDir
        )
          throw new Error("The installed service's paths changed; the restored destination will not be started.");
        stopStartedService = () => manager.stop();
        const started = manager.start();
        if (started.code) throw new Error("The restored server service could not start.");
      } else
        child = (deps.startDetached ?? ((dir, paths, legacy) => startDetachedServer(dir, paths, legacy, deps.service)))(
          configDir,
          destination,
          legacy,
        );
      await boundedWait(
        () => {
          const receipt = readInstanceRestoreResult(journalPath as string);
          if (receipt?.transactionId === result.transactionId && receipt.outcome === "rolled-back")
            throw new Error("The restored server failed during boot and the previous instance was restored.");
          if (child?.exited()) throw new Error("The restored server exited before confirming its boot.");
          return (
            receipt?.transactionId === result.transactionId &&
            receipt.outcome === "completed" &&
            probe("127.0.0.1", targetPort) !== false
          );
        },
        timeout,
        pause,
        "The restored server did not confirm a successful serving boot.",
      );
    }
    const output = {
      ...result,
      destination,
      mode,
      started: start,
      status: start ? "completed" : "pending-boot",
      legacyDatabaseOnly: legacy,
    };
    if (opts.json) deps.log(JSON.stringify(output));
    else
      deps.log(
        start
          ? "Instance restored and its serving boot confirmed."
          : "Instance restored; stopped and pending-boot until its next successful serving boot.",
      );
    return 0;
  } catch (failure) {
    // A failed start must be offline before rollback; never restore under a live handle.
    if (applied && journalPath && existsSync(journalPath)) {
      try {
        // Cleanup may have failed while this CLI still held its own mutexes.
        // Release them before waiting for server ownership or acquiring recovery locks.
        while (releases.length) releases.pop()?.();
        child?.stop();
        if (stopStartedService) {
          const stopped = stopStartedService();
          if (stopped.code) throw new Error("The restored service could not be stopped; recovery is pending.");
        }
        const lockPath = join(dirname(journalPath), "instance-state.lock");
        await boundedWait(
          () => !readInstanceLock(lockPath),
          timeout,
          pause,
          "Server still owns the instance; pending restore retained for safe boot recovery.",
        );
        for (const path of rollbackLockPaths) releases.push(acquireInstanceLock(path, "restore"));
        await rollbackInstanceRestore(journalPath);
        deps.error("The previous instance was restored after the failed restore.");
      } catch (rollbackError) {
        deps.error(
          `Restore recovery is pending: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    deps.error(`subshell-server: restore failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    return 1;
  } finally {
    while (releases.length) releases.pop()?.();
    if (ownedStage && stage) {
      try {
        await stage.cleanup();
      } catch {
        deps.error("The temporary restore stage could not be removed.");
      }
    }
  }
}
