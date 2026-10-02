import type { BackupInspection } from "@internal/backend-client";
import { ApiError, apiFetch, apiPost, parseErrorBody } from "@internal/node-admin";
import type { BackupRestoreChoices } from "@internal/subshell-protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

const ROOT = "/api/admin/backups";
export interface RestoreInspection extends BackupInspection {
  id: string;
  expiresAt: number;
}
export interface PreparedRestore {
  id: string;
  expiresAt: number;
  command: string;
}
interface BackupJob {
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
    mutationFn: () => apiFetch(`${ROOT}/jobs/${jobId}`, { method: "DELETE" }),
    onSuccess: () => setJobId(null),
  });
  return { create, job, cancel, jobId, downloadUrl: jobId ? `${ROOT}/download/${jobId}` : null };
}

export function useRestoreBackup() {
  const inspect = useMutation({
    mutationFn: ({ file, password }: { file: File; password?: string }) => inspectBackup(file, password),
  });
  const prepare = useMutation({
    mutationFn: (body: BackupRestoreChoices & { id: string; recoveryUserId?: string; temporaryPassword?: string }) => {
      const { id, ...choices } = body;
      return apiPost<PreparedRestore>(`${ROOT}/staged/${id}`, choices);
    },
  });
  const cancel = useMutation({ mutationFn: (id: string) => apiFetch(`${ROOT}/staged/${id}`, { method: "DELETE" }) });
  return { inspect, prepare, cancel };
}
