import { describe, expect, it } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { NetworkError } from "@/lib/api";
import { createServerStatusStore } from "@/lib/server-status";

async function settle(qc: QueryClient) {
  // Let queued cache events flush through the store's subscriber.
  await new Promise((r) => setTimeout(r, 0));
  await qc.cancelQueries();
}

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
