import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useStartServerUpdate } from "@/hooks/use-updates";

const savedFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = savedFetch;
});

it("marks the server busy before its update request answers and clears it on refusal", async () => {
  let answer!: (response: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      answer = resolve;
    })) as never;
  const client = new QueryClient();
  const { result } = renderHook(() => useStartServerUpdate(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  let request!: Promise<void>;
  act(() => {
    request = result.current.start({});
  });
  expect(result.current.outcome).toBe("running");
  await act(async () => {
    answer(Response.json({ message: "Update unavailable" }, { status: 409 }));
    await request;
  });
  expect(result.current.outcome).toBe("failed");
});
