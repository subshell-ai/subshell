import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SSH_SESSIONS_QUERY_KEY } from "@/hooks/use-ssh-runtime";
import { type SshRuntimeSessionView, sshRuntimeFetch } from "@/lib/ssh-runtime";

export interface SshSavedLocation {
  id: string;
  originKind: "node" | "desktop";
  originId: string;
  alias: string;
  host: string;
  port: number;
  user: string | null;
  path: string;
}
const KEY = ["ssh-saved-locations"] as const;
export function useSshLocations() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => sshRuntimeFetch<{ locations: SshSavedLocation[] }>("/api/ssh-runtime/locations"),
  });
}
export function useSaveSshLocation() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (body: { sessionId: string; path: string }) =>
      sshRuntimeFetch<SshSavedLocation>("/api/ssh-runtime/locations", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: KEY });
    },
  });
}
export function useConnectSshLocation() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      sshRuntimeFetch<{ location: SshSavedLocation; session: SshRuntimeSessionView }>(
        `/api/ssh-runtime/locations/${encodeURIComponent(id)}/connect`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: SSH_SESSIONS_QUERY_KEY });
    },
  });
}
export function useDeleteSshLocation() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      sshRuntimeFetch(`/api/ssh-runtime/locations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: KEY });
    },
  });
}
