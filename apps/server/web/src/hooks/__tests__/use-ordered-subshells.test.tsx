import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { useOrderedSubshells } from "@/hooks/use-ordered-subshells";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/** The fields sortByStatus reads; cast up to SubshellView for the cache shape. */
function entry(id: string, patch: Partial<SubshellView>): SubshellView {
  return { id, status: "running", alive: true, activity: "idle", ...patch } as SubshellView;
}

function seed(list: SubshellView[] | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (list) qc.setQueryData(SUBSHELLS_QUERY_KEY, list);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useOrderedSubshells(), { wrapper });
}

describe("useOrderedSubshells", () => {
  it("orders the full cached list by status band, cache order as tie-break", async () => {
    // Cache order is createdAt-DESC: the terminated row is FIRST in the input,
    // the waiting row must still float to the top of the result.
    const { result } = seed([
      entry("gone", { status: "terminated", alive: false }),
      entry("wait", { waitingSince: "2026-09-04T00:00:00Z" }),
      entry("run", { activity: "active" }),
    ]);
    await waitFor(() => expect(result.current.map((s) => s.id)).toEqual(["wait", "run", "gone"]));
  });

  it("is empty while the list query has no data", async () => {
    const { result } = seed(undefined);
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
