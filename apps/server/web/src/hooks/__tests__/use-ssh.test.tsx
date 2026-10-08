import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useLaunchSsh, useSshAliases, useSshSavedHosts } from "@/hooks/use-ssh";

/**
 * The keys and URLs this file states, asserted on the WIRE the way
 * `use-instance-plugins.test.tsx` asserts its invalidations — a hook that
 * stops refreshing cannot pass by invalidating some other key.
 *
 * Three facts: the ledger fetches once under `["ssh-saved-hosts"]`; aliases
 * are per-machine and gated (a null picker asks the node nothing); and a
 * successful launch refetches the ledger ONLY — the recency row moved, the
 * machine's config did not.
 */
interface Call {
  method: string;
  url: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mockFetch(overrides: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname + url.search });
    const custom = overrides[`${method} ${url.pathname}`];
    return Promise.resolve(custom ? custom() : json({}));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const savedHosts = { saved: [], recent: [], defaultNodeId: null };

afterEach(cleanup);

describe("useSshSavedHosts", () => {
  it("fetches the ledger once at /api/ssh/saved-hosts", async () => {
    const { calls, restore } = mockFetch({ "GET /api/ssh/saved-hosts": () => json(savedHosts) });
    try {
      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useSshSavedHosts(), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(calls.filter((c) => c.url === "/api/ssh/saved-hosts")).toEqual([
        { method: "GET", url: "/api/ssh/saved-hosts" },
      ]);
    } finally {
      restore();
    }
  });
});

describe("useSshAliases", () => {
  it("asks nothing while no machine is chosen", async () => {
    const { calls, restore } = mockFetch();
    try {
      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useSshAliases(null), { wrapper });
      // `enabled: false` parks the query in its idle state — never fetching.
      await new Promise((r) => setTimeout(r, 20));
      expect(result.current.fetchStatus).toBe("idle");
      expect(calls.filter((c) => c.url.startsWith("/api/ssh/aliases"))).toEqual([]);
    } finally {
      restore();
    }
  });

  it("names the machine on the wire when one is", async () => {
    const { calls, restore } = mockFetch({
      "GET /api/ssh/aliases": () => json({ aliases: ["box"], includeCycle: false, truncated: false }),
    });
    try {
      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useSshAliases("n1"), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(calls).toEqual([{ method: "GET", url: "/api/ssh/aliases?node=n1" }]);
    } finally {
      restore();
    }
  });
});

describe("useLaunchSsh", () => {
  it("refetches the ledger and nothing else on success", async () => {
    const { calls, restore } = mockFetch({
      "GET /api/ssh/saved-hosts": () => json(savedHosts),
      "GET /api/ssh/aliases": () => json({ aliases: [], includeCycle: false, truncated: false }),
      "POST /api/ssh/launch": () => json({ subshell: { id: "s1" } }, 201),
    });
    try {
      const { wrapper } = makeWrapper();
      // Both lists mounted as observers: only the ledger may move.
      const { result } = renderHook(
        () => ({ launch: useLaunchSsh(), hosts: useSshSavedHosts(), aliases: useSshAliases("n1") }),
        {
          wrapper,
        },
      );
      await waitFor(() => expect(result.current.hosts.isSuccess && result.current.aliases.isSuccess).toBe(true));
      const before = { ...counts(calls) };
      result.current.launch.mutate({ node: "n1", destination: "box" });
      await waitFor(() => expect(result.current.launch.isSuccess).toBe(true));
      await waitFor(() => expect(counts(calls).saved - before.saved).toBe(1));
      expect(counts(calls).aliases).toBe(before.aliases);
    } finally {
      restore();
    }
  });
});

function counts(calls: Call[]): { saved: number; aliases: number } {
  return {
    saved: calls.filter((c) => c.url === "/api/ssh/saved-hosts").length,
    aliases: calls.filter((c) => c.url.startsWith("/api/ssh/aliases")).length,
  };
}
