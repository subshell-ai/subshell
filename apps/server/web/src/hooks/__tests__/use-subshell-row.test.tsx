import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSubshellRow } from "@/hooks/use-subshell-row";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/** The fields this hook touches; cast up to SubshellView for the cache shape. */
function entry(id: string, patch: Partial<SubshellView> = {}): SubshellView {
  return { id, status: "running", alive: true, activity: "idle", ...patch } as SubshellView;
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useSubshellRow", () => {
  it("selects the row by id, by reference, out of the shared cache", () => {
    const a = entry("a");
    const b = entry("b");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(SUBSHELLS_QUERY_KEY, [a, b]);
    const { result } = renderHook(() => useSubshellRow("a"), { wrapper: wrapperFor(qc) });
    expect(result.current).toBe(a);
  });

  it("does NOT re-render when a sibling row changes — only this row's writes reach it", async () => {
    // The whole point of the selector: the SSE feed rewrites the list every
    // 1.5 s, and a pane subscribing to the array repaints for every OTHER
    // subshell's output. The frame here is exactly the feed's shape — same
    // array key, row `a` byte-identical, row `b` moved — and `setQueryData`'s
    // structural sharing keeps `a`'s reference, so the observer's tracked
    // props are unchanged and React never runs the callback again.
    const a = entry("a");
    const b = entry("b");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(SUBSHELLS_QUERY_KEY, [a, b]);
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useSubshellRow("a");
      },
      { wrapper: wrapperFor(qc) },
    );
    expect(renders).toBe(1);

    // `act(async)` + a macrotask inside, because query-core notifies
    // observers on a scheduled microtask: the flush must complete WITHIN the
    // act or the re-render lands un-wrapped.
    await act(async () => {
      qc.setQueryData(SUBSHELLS_QUERY_KEY, [a, entry("b", { name: "moved" })]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current).toBe(a);
    expect(renders).toBe(1);

    // And it DOES render when its own row moves. `toEqual`, not `toBe`:
    // structural sharing rebuilds a CHANGED row as a merged copy, so the
    // cache holds a new-but-equal object — the reference identity that
    // matters is the UNCHANGED row's, asserted above.
    const aChanged = entry("a", { activity: "active" });
    await act(async () => {
      qc.setQueryData(SUBSHELLS_QUERY_KEY, [aChanged, entry("b", { name: "moved" })]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toEqual(aChanged);
    expect(result.current).not.toBe(a);
    expect(renders).toBe(2);
  });

  it("mounts against an empty cache with the shared REST read", async () => {
    // A pane opened before the feed's first frame pays the same `GET
    // /api/subshells` any list consumer would — and writes the shared key.
    const a = entry("a");
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([a]), { status: 200 })) as unknown as typeof fetch;
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result } = renderHook(() => useSubshellRow("a"), { wrapper: wrapperFor(qc) });
      await waitFor(() => expect(result.current).toBeTruthy());
      expect(qc.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY)).toEqual([a]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
