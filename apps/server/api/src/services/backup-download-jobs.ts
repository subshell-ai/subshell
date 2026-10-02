import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { beginBackupCapture } from "@/services/backup-capture-lock.js";
import { createInstanceBackup } from "@/services/backups/index.js";
import { instanceBackupConfig, instanceBackupPaths } from "@/services/instance-backup-source.js";

const JOB_TTL_MS = 60 * 60 * 1000;
interface DownloadJob {
  id: string;
  actorUserId: string;
  status: "creating" | "ready" | "failed" | "cancelled" | "downloading";
  filename: string;
  expiresAt: number;
  dir: string;
  path?: string;
  bytes?: number;
  error?: string;
  timer: ReturnType<typeof setTimeout>;
}
const jobs = new Map<string, DownloadJob>();
const downloadRoot = () => join(SUBSHELL_SERVER_DATA_DIR, "backup-downloads");

/** Boot holds the instance lock, so no previous server can own these outputs. */
export function sweepBackupDownloads(): void {
  const root = downloadRoot();
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (/^download-[A-Za-z0-9]+$/.test(name)) rmSync(join(root, name), { recursive: true, force: true });
  }
}

function forget(job: DownloadJob): void {
  clearTimeout(job.timer);
  jobs.delete(job.id);
  rmSync(job.dir, { recursive: true, force: true });
}

export function startBackupDownloadJob(actorUserId: string, password?: string) {
  if (jobs.size >= 8) throw new Error("Finish or cancel existing backup downloads before creating another.");
  if (password !== undefined && (!password || password.length > 4096))
    throw new Error("Enter an encryption password of 1–4096 characters.");
  const release = beginBackupCapture();
  let dir: string;
  try {
    mkdirSync(downloadRoot(), { recursive: true, mode: 0o700 });
    chmodSync(downloadRoot(), 0o700);
    dir = mkdtempSync(join(downloadRoot(), "download-"));
    chmodSync(dir, 0o700);
  } catch (error) {
    release();
    throw error;
  }
  const id = crypto.randomUUID();
  const job: DownloadJob = {
    id,
    actorUserId,
    status: "creating",
    dir,
    filename: `subshell-${new Date().toISOString().replace(/[:.]/g, "-")}.${password === undefined ? "tar.gz" : "subshell-backup"}`,
    expiresAt: Date.now() + JOB_TTL_MS,
    timer: setTimeout(() => {
      if (job.status === "creating") job.status = "cancelled";
      else forget(job);
    }, JOB_TTL_MS),
  };
  job.timer.unref();
  jobs.set(id, job);
  void Promise.resolve()
    .then(() =>
      createInstanceBackup({
        source: instanceBackupPaths(),
        effectiveConfig: instanceBackupConfig(),
        destinationPath: join(dir, "archive"),
        password,
      }),
    )
    .then((result) => {
      if (job.status === "cancelled") {
        forget(job);
        return;
      }
      job.path = result.path;
      job.bytes = result.bytes;
      job.status = "ready";
    })
    .catch((error: unknown) => {
      if (job.status === "cancelled") {
        forget(job);
        return;
      }
      job.error = error instanceof Error ? error.message : "Backup failed.";
      job.status = "failed";
      rmSync(dir, { recursive: true, force: true });
    })
    .finally(release);
  return { id, expiresAt: job.expiresAt, filename: job.filename };
}

function ownedJob(id: string, actorUserId: string): DownloadJob {
  const job = jobs.get(id);
  if (!job || job.actorUserId !== actorUserId || job.expiresAt <= Date.now())
    throw new Error("Backup download is unavailable or expired.");
  return job;
}

export function backupDownloadJobStatus(id: string, actorUserId: string) {
  const job = ownedJob(id, actorUserId);
  return {
    id: job.id,
    status: job.status,
    filename: job.filename,
    bytes: job.bytes,
    error: job.error,
    expiresAt: job.expiresAt,
  };
}

export function cancelBackupDownloadJob(id: string, actorUserId: string): void {
  const job = ownedJob(id, actorUserId);
  if (job.status === "creating") job.status = "cancelled";
  else if (job.status !== "downloading") forget(job);
}

/** Claims the download once; the HTTP stream calls cleanup when complete or cancelled. */
export function claimBackupDownload(id: string, actorUserId: string) {
  const job = ownedJob(id, actorUserId);
  if (job.status !== "ready" || !job.path) throw new Error("Backup is not ready to download.");
  job.status = "downloading";
  clearTimeout(job.timer);
  return {
    path: job.path,
    expiresAt: job.expiresAt,
    filename: job.filename,
    bytes: job.bytes,
    cleanup: () => forget(job),
  };
}
