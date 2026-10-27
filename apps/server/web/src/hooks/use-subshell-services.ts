import { apiFetch } from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export interface SavedService {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: "http" | "https";
}
export function useSubshellServices(id: string, enabled = true) {
  const client = useQueryClient();
  const path = `/api/subshells/${encodeURIComponent(id)}/services`;
  const queryKey = ["subshell-services", id];
  // `enabled` lets a caller that may not have an id yet (a header rendering
  // before its row) share this hook without ever asking for `/api/subshells//`.
  const query = useQuery({
    queryKey,
    queryFn: () => apiFetch<SavedService[]>(path),
    refetchInterval: 5000,
    enabled,
  });
  async function save(input: Omit<SavedService, "id">) {
    const service = await apiFetch<SavedService>(path, { method: "POST", body: JSON.stringify(input) });
    await client.invalidateQueries({ queryKey });
    return service;
  }
  async function remove(serviceId: string) {
    await apiFetch(`${path}/${encodeURIComponent(serviceId)}`, { method: "DELETE" });
    await client.invalidateQueries({ queryKey });
  }
  return { ...query, save, remove };
}
