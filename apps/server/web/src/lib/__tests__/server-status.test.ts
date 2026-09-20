import { describe, expect, it } from "bun:test";
import { ApiError, NetworkError } from "@internal/node-admin";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createServerStatusStore, queryIndicatesOffline } from "@/lib/server-status";

async function settle(qc: QueryClient) {
  // Let queued cache events flush through the store's subscriber.
  await new Promise((r) => setTimeout(r, 0));
  await qc.cancelQueries();
}

const net = new NetworkError(new TypeError("down"));

describe("queryIndicatesOffline", () => {
  const q = (over: Record<string, unknown>, active = true) =>
    queryIndicatesOffline({
      isActive: () => active,
      state: { status: "success", error: null, fetchFailureReason: null, ...over },
    });

  // THE outage signal the retry loop actually produces (regression, review #6):
  // status stays success/pending with only fetchFailureReason set — the old
  // `status === "error"` predicate never fired during the loop.
  it("is true on a mid-retry network failure (status not yet error)", () => {
    expect(q({ status: "pending", fetchFailureReason: net })).toBe(true);
    expect(q({ status: "success", fetchFailureReason: net })).toBe(true);
  });
  it("is true on an exhausted network error", () => {
    expect(q({ status: "error", error: net, fetchFailureReason: net })).toBe(true);
  });
  it("is false on a healthy query and on an HTTP (answered) failure", () => {
    expect(q({})).toBe(false);
    expect(
      q({ status: "error", error: new ApiError(404, "gone"), fetchFailureReason: new ApiError(404, "gone") }),
    ).toBe(false);
  });
  it("is false for an inactive query, however it failed", () => {
    expect(q({ status: "error", error: net, fetchFailureReason: net }, false)).toBe(false);
  });
});

describe("createServerStatusStore", () => {
  it("goes offline when an ACTIVE query is stuck on NetworkError, online when it recovers", async () => {
    let fail = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createServerStatusStore(qc);
    const seen: boolean[] = [];
    const unsub = store.subscribe(() => seen.push(store.getSnapshot()));

    const obs = new QueryObserver(qc, {
      queryKey: ["probe"],
      queryFn: async () => {
        if (fail) throw new NetworkError(new TypeError("down"));
        return "up";
      },
    });
    const unsubObs = obs.subscribe(() => {});
    await obs.refetch().catch(() => {});
    await settle(qc);
    expect(store.getSnapshot()).toBe(true);

    fail = false;
    await obs.refetch().catch(() => {});
    await settle(qc);
    expect(store.getSnapshot()).toBe(false);
    expect(seen).toEqual([true, false]); // transitions, not repeats

    unsubObs();
    unsub();
  });

  it("ignores errors from UNMOUNTED queries and non-network errors", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createServerStatusStore(qc);
    const unsub = store.subscribe(() => {});

    await qc
      .fetchQuery({
        queryKey: ["inactive-net"],
        queryFn: async () => {
          throw new NetworkError(new TypeError("x"));
        },
      })
      .catch(() => {});
    await qc
      .fetchQuery({
        queryKey: ["http-500"],
        queryFn: async () => {
          throw new Error("API 500: boom");
        },
      })
      .catch(() => {});
    await settle(qc);
    expect(store.getSnapshot()).toBe(false); // never mounted => not the user's view of reality

    unsub();
  });
});
