import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { LiveSubshellsFeedProvider, useLiveSubshellsFeed } from "@/hooks/use-live-subshells-feed";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";

/** Minimal EventSource double: records instances, lets the test fire frames. */
class FakeES {
  static instances: FakeES[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(_url: string) {
    FakeES.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

function Consumer() {
  const feed = useLiveSubshellsFeed();
  return <p data-testid="state">{`${feed.connected}:${feed.lastList?.length ?? -1}`}</p>;
}

function setup(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LiveSubshellsFeedProvider enabled={enabled}>
        <Consumer />
      </LiveSubshellsFeedProvider>
    </QueryClientProvider>,
  );
  return client;
}

const original = { es: globalThis.EventSource, fetch: globalThis.fetch };
afterEach(() => {
  cleanup();
  globalThis.EventSource = original.es;
  globalThis.fetch = original.fetch;
  FakeES.instances = [];
});

function stubAuthOk() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token: "t1" }), {
      status: 200,
    })) as unknown as typeof fetch;
  globalThis.EventSource = FakeES as unknown as typeof EventSource;
}

describe("LiveSubshellsFeedProvider", () => {
  it("writes each frame into the query cache and exposes connected/lastList", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    act(() => {
      FakeES.instances[0].onmessage?.({
        data: JSON.stringify({ subshells: [{ id: "a" }, { id: "b" }] }),
      } as MessageEvent);
    });
    expect(screen.getByTestId("state").textContent).toBe("true:2");
    expect(client.getQueryData<Array<{ id: string }>>(SUBSHELLS_QUERY_KEY)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("stays silent (no token POST, no socket) while disabled", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    globalThis.EventSource = FakeES as unknown as typeof EventSource;
    setup(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toBe(0);
    expect(FakeES.instances.length).toBe(0);
  });
});
