import type { BackupInspection } from "@internal/backend-client";
import { ApiError, apiFetch, apiPost, parseErrorBody } from "@internal/node-admin";
import type { BackupRestoreChoices } from "@internal/subshell-protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

const ROOT = "/api/admin/backups";
export interface RestoreDestination {
  databasePath: string;
  dataDir: string;
  configPath: string;
}
export interface SavedBackup {
  path: string;
  name: string;
  bytes: number;
  createdAt: string;
  encrypted: boolean;
  legacyDatabaseOnly: boolean;
  serverVersion?: string;
}
export interface RestoreInspection extends BackupInspection {
  destination?: RestoreDestination;
  choices?: BackupRestoreChoices;
  id: string;
  expiresAt: number;
}
export interface PreparedRestore {
  id: string;
  expiresAt: number;
  command: string;
}
interface BackupJob {
  bytes?: number;
  expiresAt?: number;
  id: string;
  status: "creating" | "ready" | "failed" | "cancelled" | "downloading";
  error?: string;
  filename: string;
}

/** Browser uploads use multipart, so the JSON helper's content type cannot be used. */
export async function inspectBackup(file: File, password?: string): Promise<RestoreInspection> {
  const body = new FormData();
  body.append("archive", file);
  if (password !== undefined) body.append("password", password);
  const response = await fetch(`${ROOT}/inspect`, { method: "POST", credentials: "include", body });
  if (!response.ok) {
    const error = parseErrorBody(await response.text());
    throw new ApiError(response.status, error.message, error);
  }
  return response.json();
}

export function useBackupDownload() {
  const [jobId, setJobId] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (password?: string) => {
      if (jobId)
        await apiFetch(`${ROOT}/jobs/${jobId}`, { method: "DELETE" }).catch((error: unknown) => {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        });
      return apiPost<{ id: string }>(`${ROOT}/create`, password === undefined ? {} : { password });
    },
    onSuccess: (job) => setJobId(job.id),
  });
  const job = useQuery({
    queryKey: ["backup-download", jobId],
    queryFn: () => apiFetch<BackupJob>(`${ROOT}/jobs/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (query) => (query.state.data?.status === "creating" ? 1000 : false),
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: () =>
      apiFetch(`${ROOT}/jobs/${jobId}`, { method: "DELETE" }).catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }),
    onSuccess: () => setJobId(null),
  });
  return { create, job, cancel, jobId, downloadUrl: jobId ? `${ROOT}/download/${jobId}` : null };
}

export function useRestoreBackup() {
  const saved = useQuery({
    queryKey: ["saved-backups"],
    queryFn: () => apiFetch<{ backups: SavedBackup[] }>(`${ROOT}/saved`),
    retry: false,
  });
  const inspect = useMutation({
    mutationFn: ({ file, path, password }: { file?: File; path?: string; password?: string }) => {
      if (path)
        return apiPost<RestoreInspection>(`${ROOT}/inspect-saved`, {
          path,
          ...(password !== undefined && { password }),
        });
      if (!file) throw new Error("Choose a backup file.");
      return inspectBackup(file, password);
    },
  });
  const prepare = useMutation({
    mutationFn: (
      body: BackupRestoreChoices & {
        id: string;
        destination?: RestoreDestination;
        start?: boolean;
        recoveryUserId?: string;
        temporaryPassword?: string;
      },
    ) => {
      const { id, ...choices } = body;
      return apiPost<PreparedRestore>(`${ROOT}/staged/${id}`, choices);
    },
  });
  const cancel = useMutation({ mutationFn: (id: string) => apiFetch(`${ROOT}/staged/${id}`, { method: "DELETE" }) });
  return { saved, inspect, prepare, cancel };
}
