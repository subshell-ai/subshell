import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ADMIN_STATUS_QUERY_KEY } from "@/hooks/use-admin-status";
import { useServerRestart } from "@/hooks/use-server-restart";

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

/** The boot the cache holds before the press — what "a different boot" is measured against. */
const BOOTED_BEFORE = "2026-09-12T10:00:00.000Z";

/** Scripted fetch: the restart answers 202, then `/api/admin/status` answers as given, per call. */
function stubFetch(statusAnswers: (() => Response)[]) {
  const original = globalThis.fetch;
  restore.push(() => {
    globalThis.fetch = original;
  });
  let i = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/admin/server/restart") && init?.method === "POST") {
      return new Response(JSON.stringify({ restarting: true, resumeAt: "http://localhost:3080" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/admin/status"))
      return (statusAnswers[Math.min(i++, statusAnswers.length - 1)] as () => Response)();
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;
}

const statusWith = (bootedAt: string) => () =>
  new Response(JSON.stringify({ runtime: { bootedAt } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const down = () => {
  throw new TypeError("fetch failed");
};

/**
 * A wrapper whose QueryClient is built ONCE per test rather than per render:
 * the hook re-renders on every outcome change, and a client rebuilt there
 * would drop the seeded `bootedAt` the waiter compares against.
 */
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(ADMIN_STATUS_QUERY_KEY, { runtime: { bootedAt: BOOTED_BEFORE } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useServerRestart", () => {
  it("waits through the outage and reports back once bootedAt changes", async () => {
    stubFetch([down, down, statusWith("2026-09-12T10:00:07.000Z")]);
    const { result } = renderHook(() => useServerRestart({ pollMs: 5, timeoutMs: 5000 }), { wrapper: makeWrapper() });
    await act(() => result.current.restart({}));
    expect(result.current.outcome).toBe("waiting");
    await waitFor(() => expect(result.current.outcome).toBe("back"));
  });

  it("times out when the server never answers with a new boot", async () => {
    stubFetch([statusWith(BOOTED_BEFORE)]);
    const { result } = renderHook(() => useServerRestart({ pollMs: 5, timeoutMs: 40 }), { wrapper: makeWrapper() });
    await act(() => result.current.restart({}));
    await waitFor(() => expect(result.current.outcome).toBe("timeout"));
  });

  it("treats a boot time within the derivation's drift as the SAME boot", async () => {
    // `bootedAt` is derived server-side as `now - uptime*1000`, so two reads
    // of one unrestarted process differ by a second or so. Without the
    // tolerance the very first poll would answer "back" and the waiter would
    // never wait for anything.
    stubFetch([statusWith("2026-09-12T10:00:03.000Z")]);
    const { result } = renderHook(() => useServerRestart({ pollMs: 5, timeoutMs: 40 }), { wrapper: makeWrapper() });
    await act(() => result.current.restart({}));
    await waitFor(() => expect(result.current.outcome).toBe("timeout"));
  });
});
