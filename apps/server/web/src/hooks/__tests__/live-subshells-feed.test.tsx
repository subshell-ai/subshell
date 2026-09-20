import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { LiveSubshellsFeedProvider, useLiveSubshellsFeed } from "@/hooks/use-live-subshells-feed";
import { SUBSHELL_QUERY_KEY, SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/** Minimal WebSocket double: records instances, lets the test fire frames. */
class FakeWS {
  static instances: FakeWS[] = [];
  /** The real constant the provider's readyState guard compares against. */
  static readonly OPEN = 1;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  /** Frames the provider sent US — resync and preview requests. */
  readonly outbox: string[] = [];
  readyState = 1; // OPEN
  send(data: string): void {
    this.outbox.push(data);
  }
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

/** Counts the ws-token mints, so a reconnect can be shown to fetch a NEW one. */
let tokenMints = 0;

function stubAuthOk() {
  tokenMints = 0;
  globalThis.fetch = (async () => {
    tokenMints += 1;
    return new Response(JSON.stringify({ token: `t${tokenMints}` }), { status: 200 });
  }) as unknown as typeof fetch;
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
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;
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
    expect(tokenMints).toBe(1);
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
    // …and it carries a token minted for THIS attempt: the old one was spent
    // at the first connect and would be refused.
    expect(tokenMints).toBe(2);
    expect(FakeWS.instances[1].url).toContain("token=t2");
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
  it("applies a subshell event onto the row it already holds, keeping this viewer's access", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const frame = (payload: unknown) =>
      act(() => {
        FakeWS.instances[0].onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
      });

    frame({ type: "snapshot", subshells: [{ id: "a", name: "A", access: "view" }] });
    // A broadcast carries no `access` — one payload reaches every subscriber.
    frame({ type: "subshell", id: "a", row: { id: "a", name: "A renamed" } });

    const rows = client.getQueryData<Array<{ id: string; name: string; access: string }>>(SUBSHELLS_QUERY_KEY);
    expect(rows).toEqual([{ id: "a", name: "A renamed", access: "view" }]);
  });

  it("drops a row on subshell-gone, and ignores one it never held", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const frame = (payload: unknown) =>
      act(() => {
        FakeWS.instances[0].onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
      });

    frame({ type: "snapshot", subshells: [{ id: "a" }, { id: "b" }] });
    frame({ type: "subshell-gone", id: "zzz" }); // never held — no-op, no throw
    expect(client.getQueryData<Array<{ id: string }>>(SUBSHELLS_QUERY_KEY)).toHaveLength(2);

    frame({ type: "subshell-gone", id: "a" });
    expect(client.getQueryData<Array<{ id: string }>>(SUBSHELLS_QUERY_KEY)).toEqual([{ id: "b" }]);
  });

  /**
   * The ordering rule: the snapshot's read may have begun BEFORE an event that
   * arrived first, so applying it wholesale would replace the newer row with
   * the older one. Rows this connection has heard an event for win.
   */
  it("a later snapshot does not clobber a row an event already updated", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const frame = (payload: unknown) =>
      act(() => {
        FakeWS.instances[0].onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
      });

    frame({ type: "snapshot", subshells: [{ id: "a", name: "old", access: "owner" }] });
    frame({ type: "subshell", id: "a", row: { id: "a", name: "new" } });
    // A stale snapshot — read before the event, delivered after it.
    frame({ type: "snapshot", subshells: [{ id: "a", name: "old", access: "owner" }] });

    const rows = client.getQueryData<Array<{ id: string; name: string }>>(SUBSHELLS_QUERY_KEY);
    expect(rows?.[0]?.name).toBe("new");
  });

  it("a snapshot still decides which rows EXIST, even beside a live row", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const frame = (payload: unknown) =>
      act(() => {
        FakeWS.instances[0].onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
      });

    frame({
      type: "snapshot",
      subshells: [
        { id: "a", access: "owner" },
        { id: "b", access: "owner" },
      ],
    });
    frame({ type: "subshell", id: "a", row: { id: "a", name: "kept" } });
    frame({ type: "snapshot", subshells: [{ id: "a", access: "owner" }] }); // b is gone

    const rows = client.getQueryData<Array<{ id: string; name?: string }>>(SUBSHELLS_QUERY_KEY);
    expect(rows?.map((r) => r.id)).toEqual(["a"]);
    expect(rows?.[0]?.name).toBe("kept");
  });
  it("asks for a resync when a row it has never seen arrives", async () => {
    stubAuthOk();
    setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const ws = FakeWS.instances[0];
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: "snapshot", subshells: [] }) } as MessageEvent);
    });
    ws.outbox.length = 0;
    // A broadcast carries no `access`, so an unseen row cannot be rendered —
    // this is how a NEWLY created subshell reaches an admin or an Everyone
    // grantee now that the polls are gone.
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "subshell", id: "brand-new", row: { id: "brand-new" } }),
      } as MessageEvent);
    });
    expect(ws.outbox.map((f) => JSON.parse(f).type)).toContain("resync");
  });

  it("writes a change into the OPEN subshell page's own cache, not only the list", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const frame = (payload: unknown) =>
      act(() => {
        FakeWS.instances[0].onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
      });
    const detailKey = [...SUBSHELL_QUERY_KEY, "a"];
    // The detail page is open: it has fetched its own row into its own cache
    // entry, which is a DIFFERENT key from the list's.
    client.setQueryData(detailKey, { id: "a", access: "owner", status: "running", preview: ["held"] });

    frame({ type: "snapshot", subshells: [{ id: "a", access: "owner", status: "running" }] });
    // The pane dies. This is the half-second the whole design is measured on,
    // and for one review cycle it reached every surface except this one.
    frame({ type: "subshell", id: "a", row: { id: "a", status: "terminated", exitCode: 3 } });

    const held = client.getQueryData<Record<string, unknown>>(detailKey);
    expect(held?.status).toBe("terminated");
    expect(held?.exitCode).toBe(3);
    // The broadcast carries neither, so the merge must not drop them.
    expect(held?.access).toBe("owner");
    expect(held?.preview).toEqual(["held"]);
  });

  it("does not invent a detail cache entry for a page nobody opened", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const frame = (payload: unknown) =>
      act(() => {
        FakeWS.instances[0].onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
      });
    frame({ type: "snapshot", subshells: [{ id: "a", access: "owner" }] });
    frame({ type: "subshell", id: "a", row: { id: "a", status: "terminated" } });
    // Writing one would fill the cache with rows the detail view never asked
    // for — and it fetches on mount regardless.
    expect(client.getQueryData([...SUBSHELL_QUERY_KEY, "a"])).toBeUndefined();
  });

  it("answers subshell-recheck by asking, and drops nothing on its own", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const ws = FakeWS.instances[0];
    const frame = (payload: unknown) =>
      act(() => {
        ws.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
      });

    frame({ type: "snapshot", subshells: [{ id: "a", access: "owner" }] });
    ws.outbox.length = 0;
    // The server could not address this audience exactly — the same topic
    // reaches viewers who kept the row and viewers who lost it — so the frame
    // asks. Removing the row here would make an unshare that does not concern
    // this viewer look like a deletion that does.
    frame({ type: "subshell-recheck", id: "a" });

    expect(ws.outbox.map((f) => JSON.parse(f).type)).toContain("resync");
    expect(client.getQueryData<Array<{ id: string }>>(SUBSHELLS_QUERY_KEY)?.map((r) => r.id)).toEqual(["a"]);

    // And the answer sticks: a snapshot that still carries the row is NOT
    // filtered out, unlike one arriving after a `subshell-gone`.
    frame({ type: "snapshot", subshells: [{ id: "a", access: "owner" }] });
    expect(client.getQueryData<Array<{ id: string }>>(SUBSHELLS_QUERY_KEY)?.map((r) => r.id)).toEqual(["a"]);
  });

  it("ignores a recheck for a row it is not holding, so an unshare is not a broadcast storm", async () => {
    stubAuthOk();
    setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const ws = FakeWS.instances[0];
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: "snapshot", subshells: [] }) } as MessageEvent);
    });
    ws.outbox.length = 0;
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: "subshell-recheck", id: "never-held" }) } as MessageEvent);
    });
    // `live:everyone` carries this to every signed-in tab; only the ones
    // actually showing the row have a reason to ask again.
    expect(ws.outbox).toEqual([]);
  });

  it("does not let a stale snapshot resurrect a row it was told is gone", async () => {
    stubAuthOk();
    const client = setup();
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const frame = (payload: unknown) =>
      act(() => {
        FakeWS.instances[0].onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
      });

    frame({
      type: "snapshot",
      subshells: [
        { id: "a", access: "owner" },
        { id: "b", access: "owner" },
      ],
    });
    frame({ type: "subshell-gone", id: "a" });
    // A snapshot whose read began BEFORE the removal.
    frame({
      type: "snapshot",
      subshells: [
        { id: "a", access: "owner" },
        { id: "b", access: "owner" },
      ],
    });

    const rows = client.getQueryData<Array<{ id: string }>>(SUBSHELLS_QUERY_KEY);
    expect(rows?.map((r) => r.id)).toEqual(["b"]);
  });
});
