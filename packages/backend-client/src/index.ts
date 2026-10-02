import { treaty } from "@elysiajs/eden";
import type { App } from "@internal/server";

export type { App } from "@internal/server";
export type { BackupInspection, InstanceBackupManifest, BackupAdmin } from "@internal/server/backup-types";

export type BackendClient = ReturnType<typeof treaty<App>>;

export function createBackendClient(baseUrl: string): BackendClient {
  return treaty<App>(baseUrl);
}
