import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { LiveSubshellsFeedProvider } from "@/hooks/use-live-subshells-feed";
import { useSubshellData } from "@/hooks/use-subshell-data";
import { SUBSHELL_QUERY_KEY, SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/**
 * Minimal EventSource double (same contract as `live-subshells-feed.test`):
 * records instances so the test can deliver a frame and flip `connected`.
 */
class FakeES {
  static instances: FakeES[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
  constructor(_url: string) {
    FakeES.instances.push(this);
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
const originalES = globalThis.EventSource;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalES;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  FakeES.instances = [];
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
  globalThis.EventSource = FakeES as unknown as typeof EventSource;
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
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    act(() => {
      FakeES.instances[0].onmessage?.({ data: JSON.stringify({ subshells: [row()] }) } as MessageEvent);
    });
  }
  invalidated.length = 0; // keep only what the driven ticks cause
  return { client, invalidated, tick: () => act(() => timers.ticks().at(-1)?.()) };
}

describe("useSubshellData — 5 s liveness poll", () => {
  it("refreshes BOTH the row and the list while the feed is not delivering", async () => {
    // The pre-feed / feed-less posture keeps the behavior the poll was
    // written for: while no frame has ever landed, the page itself keeps the
    // sidebar list honest.
    const { invalidated, tick } = await mount({ feed: "off" });
    tick();
    expect(invalidated).toEqual([[...SUBSHELL_QUERY_KEY, "s1"], [...SUBSHELLS_QUERY_KEY]]);
  });

  it("refreshes ONLY the row once the feed is connected — the list is the feed's job", async () => {
    // The duplicate this removes: an invalidation-driven `GET /api/subshells`
    // every 5 s beside a feed writing the same key every 1.5 s, each list
    // build capturing every running pane server-side.
    const { invalidated, tick } = await mount({ feed: "delivering" });
    tick();
    tick();
    expect(invalidated).toEqual([
      [...SUBSHELL_QUERY_KEY, "s1"],
      [...SUBSHELL_QUERY_KEY, "s1"],
    ]);
  });

  it("falls back to refreshing the list again when the feed goes quiet", async () => {
    // Connected → disconnected is the fallback's whole reason to exist: the
    // token expired, the backend restarted, the stream died. The provider
    // flips `connected` false; the next tick must own the list again.
    const { invalidated, tick } = await mount({ feed: "delivering" });
    act(() => {
      FakeES.instances[0].onerror?.();
    });
    // `connected` is now false (onerror closes the stream), and `act` has
    // flushed the effect re-arm on the hook's `feedConnected` dep — the
    // LATEST captured tick carries the fallback behavior.
    invalidated.length = 0;
    tick();
    expect(invalidated).toEqual([[...SUBSHELL_QUERY_KEY, "s1"], [...SUBSHELLS_QUERY_KEY]]);
  });

  it("arms no poll once the subshell is dead", async () => {
    // Before the row resolves the hook cannot know it is dead, so an effect
    // pass may arm a timer and the cleanup tears it down. `ticks()` reports
    // only LIVE timers, so the assertion is exact: dead ⇒ nothing armed.
    stubFetch(row({ status: "running", alive: false })); // isSubshellExited
    const timers = captureFiveSecondTicks();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderHook(() => useSubshellData("s1"), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(view.result.current.dead).toBe(true));
    expect(timers.ticks()).toHaveLength(0);
  });
});
