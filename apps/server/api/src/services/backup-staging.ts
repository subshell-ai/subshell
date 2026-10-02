import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackupRestoreChoices } from "@internal/subshell-protocol";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { type InstancePaths, stageInstanceBackup } from "@/services/backups/index.js";

export const RESTORE_STAGE_TTL_MS = 60 * 60 * 1000;
export const restoreStagingRoot = () => join(SUBSHELL_SERVER_DATA_DIR, "backup-staging");
export type StagedBackup = Awaited<ReturnType<typeof stageInstanceBackup>>;
export type RestoreChoices = BackupRestoreChoices;

export interface StageRecord {
  id: string;
  actorUserId: string;
  expiresAt: number;
  stage: Omit<StagedBackup, "cleanup">;
  choices?: RestoreChoices;
  prepared?: boolean;
  destination?: InstancePaths;
  recoveryUserId?: string;
}

function stagePath(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid restore identifier.");
  return join(restoreStagingRoot(), id);
}

export function sweepRestoreStages(): void {
  const root = restoreStagingRoot();
  if (!existsSync(root)) return;
  for (const id of readdirSync(root)) {
    try {
      readRestoreStage(id);
    } catch {
      // A crashed upload can leave extraction before stage.json was published.
      if (/^[a-f0-9-]{36}$/.test(id)) {
        const info = lstatSync(join(root, id), { throwIfNoEntry: false });
        if (info?.isDirectory() && info.mtimeMs + RESTORE_STAGE_TTL_MS <= Date.now())
          rmSync(join(root, id), { recursive: true, force: true });
      }
    }
  }
}

export async function createRestoreStage(
  archive: string,
  actorUserId: string,
  password?: string,
): Promise<StageRecord> {
  sweepRestoreStages();
  const id = crypto.randomUUID();
  const root = stagePath(id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(restoreStagingRoot(), 0o700);
  try {
    const stage = await stageInstanceBackup(archive, password, join(root, "contents"));
    const { cleanup: _cleanup, ...serializable } = stage;
    const record: StageRecord = { id, actorUserId, expiresAt: Date.now() + RESTORE_STAGE_TTL_MS, stage: serializable };
    saveRestoreStage(record);
    return record;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function saveRestoreStage(record: StageRecord): void {
  writeFileSync(join(stagePath(record.id), "stage.json"), JSON.stringify(record), { mode: 0o600 });
}

export function readRestoreStage(id: string, actorUserId?: string): StageRecord {
  const root = stagePath(id);
  const record = JSON.parse(readFileSync(join(root, "stage.json"), "utf8")) as StageRecord;
  if (record.id !== id || !Number.isFinite(record.expiresAt)) throw new Error("Invalid restore metadata.");
  if (record.expiresAt <= Date.now()) {
    rmSync(root, { recursive: true, force: true });
    throw new Error("Restore upload expired. Upload it again.");
  }
  if (actorUserId && record.actorUserId !== actorUserId)
    throw new Error("Restore upload belongs to another administrator.");
  return record;
}

export function deleteRestoreStage(id: string, actorUserId?: string): void {
  readRestoreStage(id, actorUserId);
  rmSync(stagePath(id), { recursive: true, force: true });
}

export function stagedBackupFromRecord(record: StageRecord): StagedBackup {
  return {
    ...record.stage,
    cleanup: async () => {
      rmSync(stagePath(record.id), { recursive: true, force: true });
    },
  };
}
