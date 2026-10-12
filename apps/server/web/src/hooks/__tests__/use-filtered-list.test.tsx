import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useFilteredSubshells } from "@/hooks/use-subshells";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

it("debounces typing, sends encoded filters, and preserves the complete list cache", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(SUBSHELLS_QUERY_KEY, [{ id: "complete" }]);
  const calls: URL[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(new URL(String(input), "http://localhost"));
    return Response.json([{ id: "match" }]);
  }) as typeof fetch;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender } = renderHook(({ q, nodeId }) => useFilteredSubshells(q, nodeId), {
    wrapper,
    initialProps: { q: "", nodeId: undefined as string | undefined },
  });
  act(() => rerender({ q: "a", nodeId: undefined }));
  act(() => rerender({ q: "A & B", nodeId: undefined }));
  expect(calls.length).toBe(0);
  await waitFor(() => expect(result.current.data?.[0]?.id).toBe("match"));
  expect(calls.length).toBe(1);
  expect(calls[0]?.searchParams.get("q")).toBe("A & B");
  expect(client.getQueryData<{ id: string }[]>(SUBSHELLS_QUERY_KEY)).toEqual([{ id: "complete" }]);
  act(() => rerender({ q: "A & B", nodeId: "remote" }));
  await waitFor(() => expect(calls.length).toBe(2));
  expect(calls[1]?.searchParams.get("nodeId")).toBe("remote");
  act(() => rerender({ q: "", nodeId: undefined }));
  expect(result.current.data?.[0]?.id).toBe("complete");
  client.clear();
});

it("keeps a late response from replacing results for a newer query", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending = new Map<string, { resolve: (response: Response) => void; signal?: AbortSignal | null }>();
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const q = new URL(String(input), "http://localhost").searchParams.get("q") ?? "";
    return new Promise<Response>((resolve) => pending.set(q, { resolve, signal: init?.signal }));
  }) as typeof fetch;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender } = renderHook(({ q }) => useFilteredSubshells(q), {
    wrapper,
    initialProps: { q: "first" },
  });
  await waitFor(() => expect(pending.has("first")).toBe(true));
  act(() => rerender({ q: "second" }));
  await waitFor(() => expect(pending.has("second")).toBe(true));
  expect(pending.get("first")?.signal?.aborted).toBe(true);
  await act(async () => {
    pending.get("second")?.resolve(Response.json([{ id: "second" }]));
  });
  await waitFor(() => expect(result.current.data?.[0]?.id).toBe("second"));
  await act(async () => {
    pending.get("first")?.resolve(Response.json([{ id: "first" }]));
  });
  expect(result.current.data?.[0]?.id).toBe("second");
  client.clear();
});
