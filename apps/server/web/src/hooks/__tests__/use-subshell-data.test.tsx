import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { LiveSubshellsFeedProvider } from "@/hooks/use-live-subshells-feed";
import { useSubshellData } from "@/hooks/use-subshell-data";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/**
 * Minimal WebSocket double (same contract as `live-subshells-feed.test`):
 * records instances so the test can deliver a snapshot and flip `connected`.
 *
 * Stubbing it is not optional here — the provider opens a REAL socket
 * otherwise, and a refused connection surfaces as an unhandled `ErrorEvent`
 * that fails the test rather than the assertion.
 */
class FakeWS {
  static instances: FakeWS[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
  constructor(_url: string) {
    FakeWS.instances.push(this);
  }
}

function row(over: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    status: "running",
    alive: true,
    activity: "idle",
    ...over,
  } as SubshellView;
}

const originalFetch = globalThis.fetch;
const originalWS = globalThis.WebSocket;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWS;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  FakeWS.instances = [];
});

/**
 * Captures the hook's 5000 ms interval callback instead of scheduling it, so
 * the test drives a "tick" by calling it — no fake clocks, no sleeping. The
 * real `setInterval` answers with a never-firing timer so `clearInterval` in
 * the cleanup has something legitimate to clear.
 */
/**
 * Captures the hook's 5000 ms interval callbacks AND their teardown, so
 * `ticks()` answers "which poll is LIVE right now" — a captured callback
 * whose timer the effect already cleared is still callable, so a dead-row
 * test asserting "no live poll" must track `clearInterval`, not just arms.
 * Every other interval — testing-library's waitFor polling included — goes
 * to the real timer.
 */
function captureFiveSecondTicks(): { ticks: () => Array<() => void> } {
  const captured = new Map<() => void, { cleared: boolean }>();
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 5000) {
      const state = { cleared: false };
      captured.set(fn, state);
      return { __capturedTick: state };
    }
    return (realSetInterval as unknown as (...args: unknown[]) => unknown)(fn, ms, ...rest);
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    const state = (handle as { __capturedTick?: { cleared: boolean } } | null)?.__capturedTick;
    if (state) {
      state.cleared = true;
      return;
    }
    (realClear as (h: unknown) => void)(handle);
  }) as unknown as typeof clearInterval;
  return {
    ticks: () => [...captured.entries()].filter(([, s]) => !s.cleared).map(([fn]) => fn),
  };
}

function stubFetch(r: SubshellView) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("ws-token")) {
      return new Response(JSON.stringify({ token: "t1" }), { status: 200 });
    }
    return new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
}

/** One tick's worth of invalidations, recorded per query key. */
function spyInvalidations(client: QueryClient): unknown[][] {
  const keys: unknown[][] = [];
  spyOn(client, "invalidateQueries").mockImplementation((query) => {
    keys.push((query as { queryKey?: unknown[] }).queryKey ?? []);
    return Promise.resolve();
  });
  return keys;
}

async function mount(opts: { feed: "off" | "delivering" }) {
  stubFetch(row());
  globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;
  const timers = captureFiveSecondTicks();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated = spyInvalidations(client);
  // "off" = the provider is mounted but never opens a socket (no frames are
  // delivered), which is the same posture the unmounted provider answers with
  // — a single wrapper keeps the two cases honestly identical.
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <LiveSubshellsFeedProvider enabled>{children}</LiveSubshellsFeedProvider>
    </QueryClientProvider>
  );
  const view = renderHook(() => useSubshellData("s1"), { wrapper });
  await waitFor(() => expect(view.result.current.subshell).toBeTruthy());
  if (opts.feed === "delivering") {
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    act(() => {
      FakeWS.instances[0].onmessage?.({
        data: JSON.stringify({ type: "snapshot", subshells: [row()] }),
      } as MessageEvent);
    });
  }
  invalidated.length = 0; // keep only what the driven ticks cause
  return { client, invalidated, tick: () => act(() => timers.ticks().at(-1)?.()) };
}

describe("useSubshellData — no poll; the live socket is the freshness source", () => {
  /**
   * The 5 s interval is GONE (spec 2026-09-19). It invalidated both this row
   * and the whole list, and a list rebuild captures every running pane's
   * screen server-side — the single most expensive thing a quiet subshell
   * page did. Every change to this row now arrives as an event: the reconcile
   * sweep, a terminate, a restart and a rename all publish.
   */
  it("arms no interval while the feed is delivering", async () => {
    const { tick, invalidated } = await mount({ feed: "delivering" });
    // Nothing was captured to drive, and driving nothing invalidates anything.
    tick();
    expect(invalidated).toEqual([]);
  });

  it("arms no interval even when the feed never delivers", async () => {
    // The pre-feed posture used to be the poll's justification. It is not one
    // any more: a socket that never delivers is a connection problem, and the
    // client reconnects — re-fetching the world every 5 s in the meantime is
    // what made a broken feed expensive instead of merely stale.
    const { tick, invalidated } = await mount({ feed: "off" });
    tick();
    expect(invalidated).toEqual([]);
  });

  it("reflects a change the feed pushes into the list cache, with no fetch of its own", async () => {
    const { client, invalidated } = await mount({ feed: "delivering" });
    act(() => {
      FakeWS.instances[0].onmessage?.({
        data: JSON.stringify({
          type: "snapshot",
          subshells: [{ ...row(), status: "terminated", alive: false }],
        }),
      } as MessageEvent);
    });
    const rows = client.getQueryData<Array<{ id: string; status: string }>>(SUBSHELLS_QUERY_KEY);
    expect(rows?.[0]?.status).toBe("terminated");
    // The point of removing the poll: this page asked the server for nothing.
    expect(invalidated).toEqual([]);
  });
});
