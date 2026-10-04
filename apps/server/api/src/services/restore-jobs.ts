import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type RestoreDeps, runRestore } from "@/commands/restore.js";
import { startDetachedServer } from "@/commands/restore-support.js";
import { assertRunningRestoreServiceOwner } from "@/commands/restore-system.js";
import { parseEnvFile, serverConfigDir } from "@/config-env.js";
import { SERVER_PORT } from "@/constants.js";
import {
  controlService,
  DEFAULT_DEPS,
  execLine,
  queryService,
  type ServiceDeps,
  type ServiceState,
} from "@/service.js";
import { readRestoreStage } from "@/services/backup-staging.js";
import { trustedTemporaryDirectory } from "@/services/backups/paths.js";
import type { InstancePaths } from "@/services/backups/types.js";
import { instanceBackupPaths } from "@/services/instance-backup-source.js";
import { readInstanceLock } from "@/services/instance-state-lock.js";
import { clearRestoreHold, writeRestoreHold } from "@/services/restore-hold.js";
import { appSupervised } from "@/services/server-deployment.js";

const TTL = 60 * 60 * 1000;
export interface RestoreJobStatus {
  phase: "restoring" | "completed" | "failed";
  expiresAt: number;
  error?: string;
}
interface RestoreJobRequest {
  staged: string;
  source: InstancePaths;
  pid: number;
  app: boolean;
  force: boolean;
  /** The prepared transaction's stored boot choice (the control plane rejects false under a supervisor). */
  start: boolean;
  expiresAt: number;
}

function jobRoot() {
  const root = join(trustedTemporaryDirectory(), `subshell-restore-jobs-${process.getuid?.() ?? "user"}`);
  mkdirSync(root, { mode: 0o700, recursive: true });
  const info = lstatSync(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Restore job directory is not private to this OS user.");
  return root;
}
function jobDir(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
    throw new Error("Invalid restore job.");
  return join(jobRoot(), id);
}
function protectedJson<T>(file: string): T {
  const info = lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    info.size > 1024 * 1024 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Invalid restore job file.");
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
function writeStatus(id: string, status: RestoreJobStatus) {
  const target = join(jobDir(id), "status.json");
  writeFileSync(`${target}.next`, JSON.stringify(status), { mode: 0o600 });
  renameSync(`${target}.next`, target);
}
export function readRestoreJob(id: string): RestoreJobStatus {
  const status = protectedJson<RestoreJobStatus>(join(jobDir(id), "status.json"));
  if (status.expiresAt <= Date.now()) throw new Error("Restore result expired.");
  return status;
}
function serviceDeps(): ServiceDeps {
  return DEFAULT_DEPS({
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    servicePath: process.execPath,
    argv1: process.argv[1] ?? "",
    configDir: serverConfigDir(),
    env: process.env,
    which: (name) => Bun.which(name),
  });
}
function unmanagedManager(request: RestoreJobRequest, deps: ServiceDeps) {
  const lockPath = join(dirname(request.source.configPath as string), "instance-state.lock");
  let stoppedOriginal = false;
  let started = false;
  return {
    query: (): ServiceState => {
      const owner = readInstanceLock(lockPath);
      return {
        installed: true,
        definitionPath: null,
        state: owner?.kind === "server" ? "running" : "stopped",
        pid: owner?.kind === "server" ? owner.pid : null,
        enabled: false,
        linger: null,
        paneSafety: "keeps",
        logPath: null,
        detail: "",
      };
    },
    stop: () => {
      const owner = readInstanceLock(lockPath);
      if (!stoppedOriginal) {
        assertRunningRestoreServiceOwner(lockPath, request.pid);
        // Hold the native parent's respawn BEFORE the signal: the moment the
        // child dies, a parent without this note would respawn it and race
        // this worker for the instance lock.
        if (request.app && request.source.configPath) writeRestoreHold(dirname(request.source.configPath as string));
        process.kill(request.pid, "SIGTERM");
        stoppedOriginal = true;
      } else if (started && owner?.kind === "server") {
        assertRunningRestoreServiceOwner(lockPath, owner.pid);
        process.kill(owner.pid, "SIGTERM");
      }
      return { code: 0, err: "" };
    },
    start: () => {
      // The native parent restarts its own child; never create a second supervisor.
      if (!request.app) startDetachedServer(dirname(request.source.configPath as string), request.source, false, deps);
      else if (request.source.configPath) clearRestoreHold(dirname(request.source.configPath as string));
      started = true;
      return { code: 0, err: "" };
    },
  };
}
function restoreDeps(
  request: RestoreJobRequest,
  deps: ServiceDeps,
  log: (line: string) => void,
  error: (line: string) => void,
): RestoreDeps {
  const service = queryService(deps);
  if (service.installed && !request.app) {
    if (service.state !== "running" || service.pid !== request.pid)
      throw new Error("The installed service no longer owns this server; nothing was replaced.");
    return { service: deps, source: () => request.source, log, error, waitMs: 60_000 };
  }
  return {
    service: deps,
    source: () => request.source,
    log,
    error,
    waitMs: 60_000,
    manager: unmanagedManager(request, deps),
    servicePaths: () => request.source,
  };
}
export async function preflightRestoreJob(staged: string, actor: string): Promise<{ affectedSessions: number }> {
  const record = readRestoreStage(staged, actor);
  if (!record.prepared || !record.destination) throw new Error("Prepare the restore before applying it.");
  const source = instanceBackupPaths();
  assertRunningRestoreServiceOwner(join(dirname(source.configPath as string), "instance-state.lock"), process.pid);
  // This online operation replaces this exact serving instance. Alternate offline destinations remain CLI operations.
  for (const key of ["databasePath", "dataDir", "configPath"] as const)
    if (
      !source[key] ||
      !record.destination[key] ||
      resolve(source[key] as string) !== resolve(record.destination[key] as string)
    )
      throw new Error("Use this server’s current destination paths to restore from the control plane.");
  if (process.env.SUBSHELL_CONTAINER === "1" && Number(process.env.SUBSHELL_CONTAINER_SUPERVISOR_PID) !== process.ppid)
    throw new Error("Update the container image to enable control-plane restores.");
  const request: RestoreJobRequest = {
    staged,
    source,
    pid: process.pid,
    app:
      appSupervised(process.env, process.ppid) ||
      (process.env.SUBSHELL_CONTAINER === "1" &&
        Number(process.env.SUBSHELL_CONTAINER_SUPERVISOR_PID) === process.ppid),
    force: false,
    // Preflight never stops or starts anything; the field only has to be
    // present so the request shape matches the apply worker's.
    start: true,
    expiresAt: Date.now() + TTL,
  };
  const errors: string[] = [];
  const code = await runRestore(
    { staged, nativePreflight: true, json: true },
    restoreDeps(
      request,
      serviceDeps(),
      () => {},
      (line) => errors.push(line),
    ),
  );
  if (!code) return { affectedSessions: 0 };
  const message = errors.join("\n");
  const match = /RESTORE_SESSION_CONFIRMATION_REQUIRED: (\d+)/.exec(message);
  if (match) return { affectedSessions: Number(match[1]) };
  throw new Error(message.replace(/^subshell-server: restore failed: /, "") || "Could not validate restore execution.");
}
let launching = false;
let activeJob: {
  id: string;
  staged: string;
  actor: string;
  expiresAt: number;
  port: number;
  priorPort: number;
} | null = null;
export async function startRestoreJob(
  staged: string,
  actor: string,
  force: boolean,
): Promise<{ id: string; expiresAt: number; port: number; priorPort: number }> {
  if (launching) throw new Error("A restore is already starting.");
  if (activeJob) {
    try {
      const status = readRestoreJob(activeJob.id);
      // Only an IN-PROGRESS job dedups to its own id. A COMPLETED job must
      // not: returning its id would present a no-op as a fresh successful
      // restore. The re-apply instead falls through, where the consumed
      // transaction is refused honestly ("prepare another archive").
      if (status.phase === "restoring" && activeJob.staged === staged && activeJob.actor === actor)
        return {
          id: activeJob.id,
          expiresAt: activeJob.expiresAt,
          port: activeJob.port,
          priorPort: activeJob.priorPort,
        };
      if (status.phase === "restoring") throw new Error("A restore is already starting.");
    } catch (error) {
      if (error instanceof Error && error.message === "A restore is already starting.") throw error;
    }
    activeJob = null;
  }
  launching = true;
  let created: string | null = null;
  try {
    const root = jobRoot();
    for (const entry of readdirSync(root)) {
      try {
        const old = protectedJson<RestoreJobRequest>(join(jobDir(entry), "request.json"));
        if (old.expiresAt < Date.now()) rmSync(jobDir(entry), { recursive: true, force: true });
      } catch {
        /* Foreign or incomplete records are never followed or erased. */
      }
    }
    const preview = await preflightRestoreJob(staged, actor);
    if (preview.affectedSessions && !force)
      throw new Error("Review and confirm the affected sessions before restoring.");
    const record = readRestoreStage(staged, actor);
    const configuration = record.stage.legacyDatabaseOnly
      ? {}
      : parseEnvFile(readFileSync(join(record.stage.dir, "config", "config.env"), "utf8"));
    const port = Number(record.choices?.configOverrides?.port ?? configuration.SERVER_PORT ?? SERVER_PORT);
    const app =
      appSupervised(process.env, process.ppid) ||
      (process.env.SUBSHELL_CONTAINER === "1" &&
        Number(process.env.SUBSHELL_CONTAINER_SUPERVISOR_PID) === process.ppid);
    // The native parent restarts its own child, so on this server a stored
    // start:false could not be honored; the preparation would have to be
    // refused rather than silently overridden at apply time.
    const start = record.choices?.start ?? true;
    if (app && !start)
      throw new Error(
        "This server is supervised by its native parent, which starts it again after a restore; leave start enabled.",
      );
    const id = crypto.randomUUID();
    const dir = jobDir(id);
    created = id;
    mkdirSync(dir, { mode: 0o700 });
    const request: RestoreJobRequest = {
      staged,
      source: instanceBackupPaths(),
      pid: process.pid,
      app,
      force,
      start,
      expiresAt: Date.now() + TTL,
    };
    writeFileSync(join(dir, "request.json"), JSON.stringify(request), { mode: 0o600 });
    writeStatus(id, { phase: "restoring", expiresAt: request.expiresAt });
    const deps = serviceDeps();
    const argv = [...execLine(deps), "restore-worker", id];
    const service = queryService(deps);
    if (process.platform === "linux" && service.installed && !request.app) {
      // A detached child still belongs to systemd's server cgroup and dies on stop.
      // A transient unit owns the worker separately. Secrets travel only via this private file.
      const envPath = join(dir, "worker.env");
      writeFileSync(
        envPath,
        Object.entries(process.env)
          .filter(
            ([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined && !/[\r\n\0]/.test(value),
          )
          .map(([key, value]) => `${key}="${value?.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
          .join("\n"),
        { mode: 0o600 },
      );
      // ASYNC on purpose: this handler still serves traffic until the worker
      // stops the server, and a synchronous spawn (bounded at ten seconds by
      // the old spawnSync timeout) stalled every live request, socket and
      // long-poll on a jammed systemd for that whole window. The ten-second
      // bound carries over as a race against the kill below.
      const runner = Bun.spawn({
        cmd: [
          "systemd-run",
          "--user",
          "--collect",
          `--unit=subshell-restore-${id}`,
          `--property=EnvironmentFile=${envPath}`,
          `--working-directory=${process.cwd()}`,
          "--",
          ...argv,
        ],
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      const outcome = await Promise.race([runner.exited, Bun.sleep(10_000).then(() => null)]);
      if (outcome === null) runner.kill(9);
      if (outcome !== 0)
        throw new Error("Could not start the independent restore worker; the server has not been stopped.");
    } else {
      const child = Bun.spawn({
        cmd: argv,
        env: process.env as Record<string, string>,
        cwd: process.cwd(),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      child.unref();
    }
    activeJob = { id, staged, actor, expiresAt: request.expiresAt, port, priorPort: SERVER_PORT };
    return { id, expiresAt: request.expiresAt, port, priorPort: SERVER_PORT };
  } catch (error) {
    if (created) {
      writeStatus(created, {
        phase: "failed",
        expiresAt: Date.now() + TTL,
        error: "The restore worker could not start. The server was not stopped.",
      });
      rmSync(join(jobDir(created), "worker.env"), { force: true });
    }
    throw error;
  } finally {
    launching = false;
  }
}
export async function runRestoreWorker(id: string): Promise<number> {
  const output: string[] = [];
  const errors: string[] = [];
  let request: RestoreJobRequest | undefined;
  try {
    // The read and the expiry check live INSIDE the try: a throw here used to
    // skip both the failed status and the finally, stranding the browser at
    // "restoring" for the rest of the TTL and the secret-bearing worker.env
    // on disk until a later job's sweep.
    request = protectedJson<RestoreJobRequest>(join(jobDir(id), "request.json"));
    if (request.expiresAt <= Date.now()) throw new Error("Restore request expired.");
    // Let the authenticated HTTP response reach the caller before stopping it.
    await Bun.sleep(1000);
    const deps = serviceDeps();
    const runner = restoreDeps(
      request,
      deps,
      (line) => output.push(line),
      (line) => errors.push(line),
    );
    const code = await runRestore(
      { staged: request.staged, yes: true, force: request.force, start: request.start, native: true, json: true },
      runner,
    );
    if (code) {
      const lock = join(dirname(request.source.configPath as string), "instance-state.lock");
      const journal = join(dirname(request.source.configPath as string), "restore-journal.json");
      // A rejected/rolled-back restore must not leave the original host stopped.
      // Never start over a live owner or an unresolved replacement journal.
      if (!readInstanceLock(lock) && !existsSync(journal)) {
        if (runner.manager) runner.manager.start();
        else if (queryService(deps).state !== "running") controlService(deps, "start");
      }
      throw new Error(errors.join("\n"));
    }
    writeStatus(id, { phase: "completed", expiresAt: request.expiresAt });
    return 0;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    try {
      // A failure must be READABLE: readRestoreJob drops anything past its
      // expiry, so a failed status on an already-expired request would 404 the
      // poller into "status unavailable" instead of the honest failure. Floor
      // it a full window from now; the normal (in-window) failure keeps the
      // request's own expiry.
      const expires = request && request.expiresAt > Date.now() ? request.expiresAt : Date.now() + TTL;
      writeStatus(id, {
        phase: "failed",
        expiresAt: expires,
        error: "Restore could not complete. Check the server host’s restore logs before retrying.",
      });
      // Keep diagnostics private: status capability reveals no paths, secrets, or user names.
      writeFileSync(join(jobDir(id), "error.log"), errors.join("\n"), { mode: 0o600 });
    } catch {
      /* The status file is the report, not the transaction; a broken job root cannot carry either. */
    }
    return 1;
  } finally {
    rmSync(join(jobDir(id), "worker.env"), { force: true });
    // Backstop for every exit path, including a failed swap before any start:
    // once this process is gone nothing may keep the native parent waiting.
    if (request?.source.configPath) clearRestoreHold(dirname(request.source.configPath as string));
  }
}
