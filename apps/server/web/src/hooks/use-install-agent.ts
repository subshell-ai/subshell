import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HARNESS_QUERY_KEY } from "@/hooks/use-harnesses";
import { apiFetch } from "@/lib/api";
import type { HarnessInfo } from "@/types/harness";

/** What `POST /api/setup/agents/:id/install` answers. */
export interface AgentInstallResult {
  /** Whether the installer command itself exited zero */
  ok: boolean;
  /** The installer's exit code, or null when it could not be run */
  exitCode: number | null;
  /** Captured stdout+stderr from the installer */
  output: string;
  /** The harness's detection row after the install attempt */
  harness: HarnessInfo;
}

/** Runs a built-in agent's installer on the control-plane host (admin only); refetches detection afterwards. */
export function useInstallAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<AgentInstallResult>(`/api/setup/agents/${id}/install`, { method: "POST" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY }),
  });
}
