import { useQuery } from "@tanstack/react-query";
import { fetchSubshellList } from "@/hooks/use-subshells";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/**
 * One row out of the app-wide live list, for a consumer that needs exactly
 * that row's fields — a workspace pane's trust disclosure is the motivating
 * case (the row is wider than the pane-summary join but narrower than a
 * second request).
 *
 * This is deliberately NOT `useSubshellsList()` + `.find()`: that subscribes
 * the caller to the WHOLE array, and the SSE feed writes it every 1.5 s, so
 * every pane re-rendered on every other subshell's output. The selector runs
 * per cache write and TanStack shares the result structurally, so an
 * unchanged row keeps its object reference across frames — this hook
 * re-renders its caller when THIS row changed, and not when a sibling's
 * preview ticked.
 *
 * Shares the list query (same key, same fetcher): a mount before the feed's
 * first frame pays the same REST read any other list consumer would, and a
 * mount after it is free.
 */
export function useSubshellRow(id: string): SubshellView | undefined {
  const { data } = useQuery({
    queryKey: SUBSHELLS_QUERY_KEY,
    queryFn: fetchSubshellList,
    select: (rows) => rows.find((row) => row.id === id),
  });
  return data;
}
