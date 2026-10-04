import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import {
  backupDownloadJobStatus,
  cancelBackupDownloadJob,
  claimBackupDownload,
  startBackupDownloadJob,
} from "@/services/backup-download-jobs.js";

const actor = "download-test-admin";

async function readyJobId(): Promise<string> {
  const job = startBackupDownloadJob(actor);
  for (let attempt = 0; attempt < 4000; attempt++) {
    const status = backupDownloadJobStatus(job.id, actor);
    if (status.status === "ready") return job.id;
    if (status.status === "failed") throw new Error(status.error ?? "backup failed");
    await Bun.sleep(2);
  }
  throw new Error("backup did not become ready");
}

describe("backup download job lifecycle", () => {
  beforeAll(async () => {
    await ensureMigratedTestDb();
  });

  it("frees a claimed download when the operator cancels it (the abandoned-stream recovery)", async () => {
    // The leak the fix closes: a claim flips the job to "downloading" and the
    // old code (a) cleared the TTL timer and (b) refused to cancel a
    // downloading job. A stream whose connection was abandoned then held both
    // its 0700 archive dir and one of the eight create-slots for the life of
    // the process. Cancel must now forget even a downloading job.
    const id = await readyJobId();
    const claimed = claimBackupDownload(id, actor);
    expect(backupDownloadJobStatus(id, actor).status).toBe("downloading");
    expect(() => claimBackupDownload(id, actor)).toThrow("not ready"); // claim is one-shot
    cancelBackupDownloadJob(id, actor);
    expect(() => backupDownloadJobStatus(id, actor)).toThrow("unavailable");
    expect(existsSync(claimed.path)).toBe(false);
    // The download ROOT survives; only this job's dir is forgotten.
    expect(existsSync(join(SUBSHELL_SERVER_DATA_DIR, "backup-downloads"))).toBe(true);
  });

  it("canceling a claimed download releases a slot at the eight-job cap", async () => {
    // The discriminating version: fill the cap, hold one slot with a
    // "downloading" job, and prove a cancel returns it. The old code refused to
    // cancel a downloading job, so the slot stayed held for the life of the
    // process and a create at the cap could never recover without restart.
    const ids: string[] = [];
    const capMessage = (): string => {
      try {
        startBackupDownloadJob(actor); // at-cap throws BEFORE acquiring the lock
        return "<unexpected success>";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const atCap = /Finish or cancel existing backup downloads/;
    try {
      // Eight READY jobs fill the map (a create's capture lock is released when
      // it reaches "ready", so only a ready job can be stacked behind another,
      // and each `readyJobId` returns only once that lock is free again).
      for (let filled = 0; filled < 8; filled++) ids.push(await readyJobId());
      expect(capMessage()).toMatch(atCap); // a ninth is refused
      // Claim the first: it becomes "downloading", still holding its slot.
      claimBackupDownload(ids[0] as string, actor);
      expect(capMessage()).toMatch(atCap);
      // Cancel the downloading job — the fix forgets it and returns the slot,
      // which the old code (refusing to cancel a download) could not. Drive the
      // replacement to "ready" so the file leaves NO create in flight holding
      // the shared capture lock for whatever file runs next in this worker.
      cancelBackupDownloadJob(ids[0] as string, actor);
      ids.shift();
      const recovered = await readyJobId();
      ids.push(recovered);
      expect(recovered).toBeTruthy();
    } finally {
      for (const id of ids) {
        try {
          cancelBackupDownloadJob(id, actor);
        } catch {
          /* already forgotten */
        }
      }
    }
  });
});
