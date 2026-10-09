import { apiFetch, NODES_QUERY_KEY } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Safe progress mirrored from the owner-only setup status endpoint. */
export interface SshSetupOperation {
  /** Server-observed stage; no installer output is exposed. */
  stage: "checking" | "installing" | "connecting" | "complete" | "failed";
  /** ISO timestamp for elapsed-time display. */
  startedAt: string;
  /** Enrolled destination once its connection is confirmed. */
  nodeId: string | null;
  /** Safe failure explanation. */
  error: string | null;
}

/** Reopening a dialog reattaches to the server operation; it never starts another install. */
export function useSshSetup(paneId: string) {
  const client = useQueryClient();
  const queryKey = ["ssh-setup", paneId];
  const upgrade = useMutation({
    mutationFn: () =>
      apiFetch<{ nodeId: string }>("/api/ssh/setup-here", { method: "POST", body: JSON.stringify({ paneId }) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: NODES_QUERY_KEY });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey });
    },
  });
  const status = useQuery({
    queryKey,
    queryFn: () =>
      apiFetch<{ operation: SshSetupOperation | null }>(`/api/ssh/setup-here/${encodeURIComponent(paneId)}`),
    staleTime: 0,
    refetchInterval: (query) =>
      upgrade.isPending ||
      (query.state.data?.operation && !["complete", "failed"].includes(query.state.data.operation.stage))
        ? 1500
        : false,
  });
  const operation = status.data?.operation;
  return {
    upgrade,
    status,
    operation,
    pending: upgrade.isPending || (!!operation && !["complete", "failed"].includes(operation.stage)),
  };
}
