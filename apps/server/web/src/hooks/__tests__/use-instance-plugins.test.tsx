import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  useInstallInstancePlugin,
  useSetPluginEnabled,
  useUninstallInstancePlugin,
} from "@/hooks/use-instance-plugins";
import { useNetwork } from "@/hooks/use-network";
import { usePresets } from "@/hooks/use-presets";
import { usePublicSettings } from "@/hooks/use-public-settings";

/**
 * The TWO couplings this pins. Availability became the instance STORE (spec
 * 2026-09-13 amendment), so `GET /api/presets` filters on installed ∧ enabled
 * ∧ ¬broken: every plugin mutation changes what that list answers —
 * including the two that touch no preset row at all — and a mounted /presets
 * page or an open launch dialog is stale the moment one returns. And the
 * trusted-origins registry is LIVE (spec 2026-09-16): enabling or disabling a
 * network plugin moves its addresses onto or off the allowlist, so the
 * network list and the public settings the mobile dialog reads must refetch
 * on the very same mutations.
 *
 * Both are asserted as a REFETCH on the wire rather than as a call to
 * `invalidateQueries`, so a hook that stops refreshing cannot pass by
 * invalidating some other key.
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
    calls.push({ method, url: url.pathname });
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

const presetFetches = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.url === "/api/presets").length;

/**
 * Mounts a real `usePresets()` observer beside the mutation. An invalidation
 * only REFETCHES a query something is watching, so a seeded cache entry with
 * no observer would go stale silently and prove nothing.
 */
function renderWithPresets<T>(useMutationHook: () => T, wrapper: ReturnType<typeof makeWrapper>["wrapper"]) {
  return renderHook(() => ({ presets: usePresets(), mutation: useMutationHook() }), { wrapper });
}

afterEach(cleanup);

describe("instance plugin mutations refresh the preset list and the network/allowlist surfaces", () => {
  it("enabling/disabling a plugin refetches presets — no row changes, but the LIST does", async () => {
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch({ "GET /api/presets": () => json([]) });
    try {
      const { result } = renderWithPresets(useSetPluginEnabled, wrapper);
      await waitFor(() => expect(presetFetches(calls)).toBe(1));
      result.current.mutation.mutate({ id: "claude-code", enabled: false });
      await waitFor(() => expect(presetFetches(calls)).toBe(2));
    } finally {
      restore();
    }
  });

  it("installing a plugin refetches presets — its presets become listable again", async () => {
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch({ "GET /api/presets": () => json([]) });
    try {
      const { result } = renderWithPresets(useInstallInstancePlugin, wrapper);
      await waitFor(() => expect(presetFetches(calls)).toBe(1));
      result.current.mutation.mutate({ pluginId: "codex" });
      await waitFor(() => expect(presetFetches(calls)).toBe(2));
    } finally {
      restore();
    }
  });

  it("uninstalling still refetches presets (the case that always did)", async () => {
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch({ "GET /api/presets": () => json([]) });
    try {
      const { result } = renderWithPresets(useUninstallInstancePlugin, wrapper);
      await waitFor(() => expect(presetFetches(calls)).toBe(1));
      result.current.mutation.mutate({ id: "codex", mode: "delete" });
      await waitFor(() => expect(presetFetches(calls)).toBe(2));
    } finally {
      restore();
    }
  });

  it("enabling/disabling a plugin refetches the network list and the public settings — a network's addresses join or leave the allowlist with the flag", async () => {
    // The Networking card's Disable/Enable action rides THIS mutation (one
    // plugin toggle, not two), and what the flag changes is visible in two
    // other reads: `GET /api/network` (the row's state) and
    // `GET /api/settings/public → trustedOrigins` (the effective allowlist).
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch({
      "GET /api/presets": () => json([]),
      "GET /api/network": () => json({ networks: [] }),
      "GET /api/settings/public": () => json({ viewerIsAdmin: true, trustedOrigins: [] }),
    });
    const fetches = (path: string) => calls.filter((c) => c.method === "GET" && c.url === path).length;
    try {
      const { result } = renderHook(
        () => ({ network: useNetwork(true), settings: usePublicSettings(), mutation: useSetPluginEnabled() }),
        { wrapper },
      );
      await waitFor(() => {
        expect(fetches("/api/network")).toBe(1);
        expect(fetches("/api/settings/public")).toBe(1);
      });
      act(() => result.current.mutation.mutate({ id: "tailscale", enabled: false }));
      await waitFor(() => {
        expect(fetches("/api/network")).toBe(2);
        expect(fetches("/api/settings/public")).toBe(2);
      });
    } finally {
      restore();
    }
  });
});
