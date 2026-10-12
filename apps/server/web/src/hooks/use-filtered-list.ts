import { apiFetch } from "@internal/node-admin";
import { useQuery } from "@tanstack/react-query";

/** Filtered reads never replace the complete list used by live feeds and pickers. */
export function useFilteredList<T>(
  key: readonly string[],
  path: string,
  filters: Record<string, string | undefined>,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) if (value) params.set(name, value);
  const search = params.toString();
  return useQuery({
    ...options,
    queryKey: search ? [...key, "filtered", search] : key,
    queryFn: ({ signal }) => apiFetch<T>(search ? `${path}?${search}` : path, { signal }),
  });
}
