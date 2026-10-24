import { afterEach, describe, expect, it } from "bun:test";
import type { LiveClientFrame } from "@internal/subshell-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { FeedContext, type LiveSubshellsFeedValue } from "@/hooks/use-live-subshells-feed";
import { useSubshellPreview } from "@/hooks/use-subshell-preview";
import type { SubshellView } from "@/types/subshell";

/**
 * The watch-protocol halves (task-12 brief). The REST call opens the pane's
 * one bridge on the plane; the `watch` frame registers THIS device's socket
 * as a recipient. Both or neither: a POST the bridge refuses must not leave a
 * socket attached to someone else's stream, and a socket that died mid-watch
 * re-registers when the feed reconnects. These tests fake the feed's bound
 * `send` and the fetch route, and count what each side produced.
 */

type Call = { method: string; url: string; body?: Record<string, unknown> };

function paneRow(over: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "pane1",
    name: "pane",
    status: "running",
    alive: true,
    lastOutputAt: null,
    access: "owner",
    ...over,
  } as unknown as SubshellView;
}

function wire(opts: { watchStatus?: number; watchMessage?: string } = {}) {
  const calls: Call[] = [];
  const frames: LiveClientFrame[] = [];
  const feedRef: { value: LiveSubshellsFeedValue } = {
    value: {
      connected: true,
      lastList: null,
      requestPreviews: () => {},
      send: (frame) => {
        frames.push(frame);
        return feedRef.value.connected;
      },
    },
  };
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname,
      body: init?.body ? (JSON.parse(String(init.body)) as Call["body"]) : undefined,
    });
    if (/^\/api\/subshells\/pane\d+\/views$/.test(url.pathname) && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ ports: [], cdpPort: 9333, screen: null, nodeEnabled: true })),
      );
    }
    if (/^\/api\/subshells\/pane\d+\/views\/browser\/watch$/.test(url.pathname)) {
      if (method === "POST" && opts.watchStatus && opts.watchStatus !== 200) {
        return Promise.resolve(
          new Response(JSON.stringify({ errId: "e", code: "CONFLICT", message: opts.watchMessage ?? "refused" }), {
            status: opts.watchStatus,
          }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let subshell: SubshellView | undefined = paneRow();
  let paneId = "pane1";
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <FeedContext.Provider value={feedRef.value}>{children}</FeedContext.Provider>
      </QueryClientProvider>
    );
  }
  const hook = renderHook(() => useSubshellPreview(paneId, subshell), { wrapper: Wrapper });
  const infoGets = () => calls.filter((c) => c.method === "GET" && c.url.endsWith("/views")).length;
  const watchFrames = () => frames.filter((f) => f.type === "watch" && f.id === "pane1").length;
  return {
    calls,
    frames,
    feed: feedRef,
    result: hook.result,
    infoGets,
    watchFrames,
    setFeed(patch: Partial<LiveSubshellsFeedValue>) {
      feedRef.value = { ...feedRef.value, ...patch };
    },
    rerenderWith(next: SubshellView | undefined) {
      subshell = next;
      hook.rerender();
    },
    setPane(next: string) {
      paneId = next;
      hook.rerender();
    },
    framesFor(type: "watch" | "unwatch", id: string) {
      return frames.filter((f) => f.type === type && f.id === id);
    },
    unmount: hook.unmount,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

afterEach(() => cleanup());

describe("startWatch fires both halves", () => {
  it("POSTs the bridge, then sends the watch frame on the live socket", async () => {
    const h = wire();
    try {
      await waitFor(() => expect(h.infoGets()).toBe(1));
      await act(async () => {
        await h.result.current.startWatch(9333);
      });
      const post = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/views/browser/watch"));
      expect(post?.body).toEqual({ port: 9333 });
      expect(h.watchFrames()).toBe(1);
      expect(h.result.current.watching).toBe(true);
      expect(h.result.current.watchError).toBeNull();
    } finally {
      h.restore();
    }
  });

  it("omits the port to let the route fall back to the cached cdpPort", async () => {
    const h = wire();
    try {
      await act(async () => {
        await h.result.current.startWatch();
      });
      const post = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/views/browser/watch"));
      expect(post?.body).toEqual({});
    } finally {
      h.restore();
    }
  });

  it("a 409 refusal stops there: no live frame, and the named error renders", async () => {
    const h = wire({
      watchStatus: 409,
      watchMessage: "watch-port-conflict: the bridge is already streaming port 9333",
    });
    try {
      await act(async () => {
        await h.result.current.startWatch(9444);
      });
      expect(h.watchFrames()).toBe(0);
      expect(h.result.current.watching).toBe(false);
      expect(h.result.current.watchError).toContain("watch-port-conflict");
    } finally {
      h.restore();
    }
  });
});

describe("stopWatch mirrors it", () => {
  it("sends unwatch and DELETEs the bridge", async () => {
    const h = wire();
    try {
      await act(async () => {
        await h.result.current.startWatch(9333);
      });
      await act(async () => {
        await h.result.current.stopWatch();
      });
      expect(h.frames.filter((f) => f.type === "unwatch" && f.id === "pane1").length).toBe(1);
      expect(h.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/views/browser/watch"))).toBe(true);
      expect(h.result.current.watching).toBe(false);
    } finally {
      h.restore();
    }
  });

  it("unmounting a watching hook releases both halves", async () => {
    const h = wire();
    try {
      await act(async () => {
        await h.result.current.startWatch(9333);
      });
      await act(async () => {
        h.unmount();
      });
      expect(h.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/views/browser/watch"))).toBe(true);
      expect(h.frames.filter((f) => f.type === "unwatch").length).toBe(1);
    } finally {
      h.restore();
    }
  });
});

describe("pane navigation", () => {
  it("watching pane A, navigating to pane B releases A and never half-watches B", async () => {
    const h = wire();
    try {
      await act(async () => {
        await h.result.current.startWatch(9333);
      });
      expect(h.framesFor("watch", "pane1").length).toBe(1);
      // The route re-renders the SAME hook for the next pane: the [id]
      // release effect runs its cleanup, then every id-keyed effect re-runs
      // against B. Watching B needs B's own REST bridge first; without the
      // state reset, the reconnect re-fire (which depends on `id`) would
      // happily send a `watch` frame for a bridge this tab never joined.
      await act(async () => {
        h.setPane("pane2");
      });
      // A is released on both halves.
      expect(h.framesFor("unwatch", "pane1").length).toBe(1);
      await waitFor(() =>
        expect(h.calls.some((c) => c.method === "DELETE" && c.url === "/api/subshells/pane1/views/browser/watch")).toBe(
          true,
        ),
      );
      // B is untouched: no frame, no bridge POST, and the surface reads false.
      expect(h.framesFor("watch", "pane2").length).toBe(0);
      expect(h.framesFor("unwatch", "pane2").length).toBe(0);
      expect(h.calls.some((c) => c.url === "/api/subshells/pane2/views/browser/watch")).toBe(false);
      expect(h.result.current.watching).toBe(false);
    } finally {
      h.restore();
    }
  });

  it("a refused watch's named error does not ride into the next pane", async () => {
    const h = wire({
      watchStatus: 409,
      watchMessage: "watch-port-conflict: the bridge is already streaming port 9333",
    });
    try {
      await act(async () => {
        await h.result.current.startWatch(9444);
      });
      expect(h.result.current.watchError).toContain("watch-port-conflict");
      // The refusal left no live watch to release, so the [id] cleanup's
      // release guard is false here; clearing the error must not sit behind
      // it, or pane B's section renders pane A's red alert.
      await act(async () => {
        h.setPane("pane2");
      });
      expect(h.result.current.watchError).toBeNull();
    } finally {
      h.restore();
    }
  });
});

describe("reconnect re-registers", () => {
  it("a socket that dropped mid-watch gets the watch frame again on reconnect", async () => {
    const h = wire();
    try {
      await act(async () => {
        await h.result.current.startWatch(9333);
      });
      expect(h.watchFrames()).toBe(1);
      // The socket drops, then returns: the re-fire is the registration path.
      h.setFeed({ connected: false });
      h.rerenderWith(paneRow());
      h.setFeed({ connected: true });
      h.rerenderWith(paneRow());
      await waitFor(() => expect(h.watchFrames()).toBe(2));
    } finally {
      h.restore();
    }
  });

  it("watching while disconnected still holds, and the re-fire rides the reconnect", async () => {
    const h = wire();
    try {
      h.setFeed({ connected: false });
      h.rerenderWith(paneRow());
      await act(async () => {
        await h.result.current.startWatch(9333);
      });
      // The REST half ran; the frame it sent was refused by the closed socket,
      // and the hook keeps the watch so the reconnect can re-register it.
      expect(h.result.current.watching).toBe(true);
      h.setFeed({ connected: true });
      h.rerenderWith(paneRow());
      await waitFor(() => expect(h.watchFrames()).toBe(2));
    } finally {
      h.restore();
    }
  });

  it("a pane that was never watched sends nothing on reconnect", async () => {
    const h = wire();
    try {
      h.setFeed({ connected: false });
      h.rerenderWith(paneRow());
      h.setFeed({ connected: true });
      h.rerenderWith(paneRow());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.watchFrames()).toBe(0);
    } finally {
      h.restore();
    }
  });
});

describe("the info refresh", () => {
  /**
   * A frozen fake clock makes the five-second window deterministic: the mount
   * fetch stamps `now`, refreshes inside the window buy nothing, and a clock
   * pushed past it opens the gate again.
   */
  function frozenClock() {
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => fake;
    return { advance: (ms: number) => (fake += ms), restore: () => (Date.now = realNow) };
  }

  it("focus twice inside the window, refetch once", async () => {
    const clock = frozenClock();
    const h = wire();
    try {
      await waitFor(() => expect(h.infoGets()).toBe(1));
      act(() => window.dispatchEvent(new Event("focus")));
      act(() => h.result.current.refresh());
      expect(h.infoGets()).toBe(1);
      clock.advance(6_000);
      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(h.infoGets()).toBe(2));
    } finally {
      clock.restore();
      h.restore();
    }
  });

  it("an output burst refreshes it, inside the same throttle", async () => {
    const clock = frozenClock();
    const h = wire();
    try {
      await waitFor(() => expect(h.infoGets()).toBe(1));
      clock.advance(6_000);
      h.rerenderWith(paneRow({ lastOutputAt: "2026-10-23T10:00:00.000Z" }));
      await waitFor(() => expect(h.infoGets()).toBe(2));
      // A second burst inside the same window buys nothing.
      h.rerenderWith(paneRow({ lastOutputAt: "2026-10-23T10:00:01.000Z" }));
      expect(h.infoGets()).toBe(2);
    } finally {
      clock.restore();
      h.restore();
    }
  });
});
