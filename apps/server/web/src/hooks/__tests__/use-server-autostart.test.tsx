import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { useSetServerAutostart } from "@/hooks/use-server-deployment";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";
import type { ServerDeployment } from "@/types/server-deployment";

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

/** Just enough of the view for the cache assertions; the route answers the whole thing. */
const viewWith = (enabled: boolean) => ({ service: { enabled }, generatedAt: "2026-09-12T10:00:00.000Z" });

/** The route's answer, or a refusal — whichever this test is about. */
function stubFetch(answer: () => Response): { calls: unknown[] } {
  const original = globalThis.fetch;
  const calls: unknown[] = [];
  restore.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/admin/server/autostart") && init?.method === "POST") {
      calls.push(JSON.parse(String(init.body)));
      return answer();
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;
  return { calls };
}

const ok = (enabled: boolean) => () =>
  new Response(JSON.stringify(viewWith(enabled)), { status: 200, headers: { "content-type": "application/json" } });

const refused = () =>
  new Response(
    JSON.stringify({
      code: "AUTOSTART_UNAVAILABLE",
      message: "No service is installed on this machine, so there is nothing to start at login.",
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );

/**
 * One QueryClient per test, seeded with the pre-press view — which is the
 * thing the hook is supposed to REPLACE, so a client rebuilt per render would
 * hide the very write under test.
 */
function makeWrapper(): { Wrapper: (p: { children: ReactNode }) => ReactElement; qc: QueryClient } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, viewWith(false));
  return {
    qc,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  };
}

const cached = (qc: QueryClient) => qc.getQueryData<ServerDeployment>(SERVER_DEPLOYMENT_QUERY_KEY);

describe("useSetServerAutostart", () => {
  it("writes the answer into the deployment cache, so the switch moves without a re-fetch", async () => {
    const { calls } = stubFetch(ok(true));
    const { Wrapper, qc } = makeWrapper();
    const { result } = renderHook(() => useSetServerAutostart(), { wrapper: Wrapper });

    await act(async () => result.current.set(true));
    await waitFor(() => expect(cached(qc)?.service.enabled).toBe(true));

    // The flag reaches the route as the route's own body shape.
    expect(calls).toEqual([{ enabled: true }]);
    expect(result.current.error).toBe(null);
  });

  it("leaves the cache alone when the server refuses, and surfaces the reason", async () => {
    stubFetch(refused);
    const { Wrapper, qc } = makeWrapper();
    const { result } = renderHook(() => useSetServerAutostart(), { wrapper: Wrapper });

    await act(async () => result.current.set(true));
    await waitFor(() => expect(result.current.error).toBeTruthy());

    // Nothing optimistic was written, so there is nothing to revert: the
    // switch keeps showing what the machine actually reports.
    expect(cached(qc)?.service.enabled).toBe(false);
    expect(result.current.error).toContain("No service is installed");
  });

  it("reports a press in flight, so the switch can refuse a second one", async () => {
    let release: (() => void) | undefined;
    const original = globalThis.fetch;
    restore.push(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = (async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return ok(true)();
    }) as unknown as typeof globalThis.fetch;

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetServerAutostart(), { wrapper: Wrapper });
    act(() => result.current.set(true));
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});
