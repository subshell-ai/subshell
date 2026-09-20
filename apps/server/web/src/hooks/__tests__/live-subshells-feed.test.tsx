import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { LiveSubshellsFeedProvider, useLiveSubshellsFeed } from "@/hooks/use-live-subshells-feed";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/** Minimal WebSocket double: records instances, lets the test fire frames. */
class FakeWS {
  static instances: FakeWS[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
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

const original = { ws: globalThis.WebSocket, fetch: globalThis.fetch };
afterEach(() => {
  cleanup();
  globalThis.WebSocket = original.ws;
  globalThis.fetch = original.fetch;
  FakeWS.instances = [];
});

function stubAuthOk() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token: "t1" }), {
      status: 200,
    })) as unknown as typeof fetch;
  globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;
}

describe("LiveSubshellsFeedProvider", () => {
  it("writes each frame into the query cache and exposes connected/lastList", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    act(() => {
      FakeWS.instances[0].onmessage?.({
        data: JSON.stringify({ type: "snapshot", subshells: [{ id: "a" }, { id: "b" }] }),
      } as MessageEvent);
    });
    expect(screen.getByTestId("state").textContent).toBe("true:2");
    expect(client.getQueryData<Array<{ id: string }>>(SUBSHELLS_QUERY_KEY)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("quiet frames leave every reference intact; a changed frame shares the untouched rows", async () => {
    // The cost story of the 1.5 s beat: a frame that changed nothing must
    // not re-render anything, and a frame that touched one row must hand
    // observers the SAME objects for the rows it did not. Both ride on
    // `setQueryData`'s structural sharing and `lastList` being set from the
    // cache read-back rather than the freshly parsed frame.
    stubAuthOk();
    const rendered: Array<SubshellView[] | null> = [];
    function IdentityConsumer() {
      const feed = useLiveSubshellsFeed();
      rendered.push(feed.lastList);
      return null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LiveSubshellsFeedProvider enabled>
          <IdentityConsumer />
        </LiveSubshellsFeedProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    expect(rendered).toEqual([null]); // mount render, list not yet delivered

    const frame = (subshells: unknown[]) =>
      act(() => {
        FakeWS.instances[0].onmessage?.({ data: JSON.stringify({ type: "snapshot", subshells }) } as MessageEvent);
      });

    frame([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    const first = client.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY);
    expect(first).toBeTruthy();
    expect(rendered.at(-1)).toBe(first);

    // Identical frame: cache array identity intact, and NO new consumer
    // render — `rendered` gains nothing between the two length reads below.
    const rendersBefore = rendered.length;
    frame([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    expect(client.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY)).toBe(first);
    expect(rendered.length).toBe(rendersBefore);

    // Changed frame: new array (b moved), but a's row object is shared, so
    // `useSubshellRow("a")` subscribers stay put.
    frame([
      { id: "a", name: "A" },
      { id: "b", name: "B!" },
    ]);
    const second = client.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY);
    expect(second).not.toBe(first);
    expect(second?.[0]).toBe(first?.[0]);
    expect(second?.[1]).not.toBe(first?.[1]);
  });

  it("stays silent (no token POST, no socket) while disabled", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    globalThis.EventSource = FakeWS as unknown as typeof EventSource;
    setup(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toBe(0);
    expect(FakeWS.instances.length).toBe(0);
  });
  it("connects to /ws/live carrying the minted token", async () => {
    stubAuthOk();
    setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const url = FakeWS.instances[0].url;
    expect(url).toContain("/ws/live?token=t1");
    // The scheme follows the page, so an https instance does not open an
    // insecure socket the browser would refuse as mixed content.
    expect(url.startsWith("ws://") || url.startsWith("wss://")).toBe(true);
  });

  it("reconnects with a fresh token after the socket closes", async () => {
    stubAuthOk();
    setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    act(() => {
      FakeWS.instances[0].onclose?.();
    });
    expect(screen.getByTestId("state").textContent).toStartWith("false:");
    // A second socket is armed on the reconnect delay, not immediately.
    await waitFor(() => expect(FakeWS.instances.length).toBe(2), { timeout: 4000 });
  });

  it("ignores a frame that is not a snapshot", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    act(() => {
      FakeWS.instances[0].onmessage?.({ data: JSON.stringify({ type: "preview", id: "a" }) } as MessageEvent);
    });
    // Nothing was written, and the feed does not claim to be delivering.
    expect(client.getQueryData(SUBSHELLS_QUERY_KEY)).toBeUndefined();
    expect(screen.getByTestId("state").textContent).toBe("false:-1");
  });

  it("closes the socket when the provider unmounts", async () => {
    stubAuthOk();
    setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    cleanup();
    expect(FakeWS.instances[0].closed).toBe(true);
  });
});
