import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backupEncryptionPasswordProblem } from "@internal/subshell-protocol";
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
  if (password !== undefined) {
    const problem = backupEncryptionPasswordProblem(password);
    if (problem) throw new Error(problem);
  }
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
    filename: `subshell-instance-${new Date().toISOString().slice(0, 10)}.tar.gz${password === undefined ? "" : ".enc"}`,
    expiresAt: Date.now() + JOB_TTL_MS,
    timer: setTimeout(() => {
      // The creation half may still be mid-write (holding the capture lock);
      // mark it cancelled and let that path's finally forget it. Everything
      // else — including a DOWNLOAD an abandoned connection never finished —
      // is forgotten here, so no job outlives its TTL whatever the stream
      // does or does not call.
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
  // "downloading" forgets too: on POSIX the stream's open file survives the
  // unlink, and a half-pulled connection that never calls cleanup must not
  // hold the slot or the (possibly plaintext) archive past the operator's
  // cancel.
  else forget(job);
}

/** Claims the download once; the HTTP stream calls cleanup when complete or cancelled. */
export function claimBackupDownload(id: string, actorUserId: string) {
  const job = ownedJob(id, actorUserId);
  if (job.status !== "ready" || !job.path) throw new Error("Backup is not ready to download.");
  job.status = "downloading";
  // The TTL timer stays ARMED deliberately: a stream that is never fully
  // pulled and never cancelled would otherwise leak its 0700 temp dir and its
  // slot in the eight-job cap for the life of the process. The timer forgets
  // the job at its published expiry whatever the stream does; `cleanup` and
  // `forget` are both idempotent, so the normal completion path is unaffected.
  return {
    path: job.path,
    expiresAt: job.expiresAt,
    filename: job.filename,
    bytes: job.bytes,
    cleanup: () => forget(job),
  };
}
