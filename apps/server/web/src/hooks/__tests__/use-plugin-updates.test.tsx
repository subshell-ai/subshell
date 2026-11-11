import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { INSTANCE_PLUGINS_QUERY_KEY, type InstancePluginRow, useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNetwork } from "@/hooks/use-network";
import {
  PLUGIN_UPDATES_QUERY_KEY,
  type PluginUpdateRow,
  type PluginUpdatesView,
  useCheckPluginUpdates,
  usePluginUpdates,
  useUpdatePlugin,
} from "@/hooks/use-plugin-updates";
import { usePresets } from "@/hooks/use-presets";
import { usePublicSettings } from "@/hooks/use-public-settings";

/**
 * The update surface is a read, a check and an act, and each has a coupling
 * this pins on the WIRE rather than on a call to `invalidateQueries`:
 *
 * 1. **The read is admin-gated.** Every route in the group 403s a non-admin,
 *    so mounting the card as a member must fire no doomed GET — the same
 *    confirmed-admin gate `/settings/status` and `/api/network` use.
 * 2. **The check writes its own answer.** Unlike the server update check, the
 *    plugin check answers the WHOLE view, so the fresh offers land in the
 *    cache instead of leaving the card to guess from a refetch.
 * 3. **An update refreshes every surface an install does.** An update swaps
 *    the plugin's bytes in the instance store, so the catalog row, the offer
 *    list, the preset list (availability is the store) and a network plugin's
 *    addresses on the allowlist all move with it.
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

const count = (calls: Call[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.url === path).length;

const view = (updates: PluginUpdateRow[] = []): PluginUpdatesView => ({
  updates,
  errors: [],
  checkedAt: 1,
});

const updatedRow: InstancePluginRow = {
  id: "pi",
  name: "pi",
  description: "",
  installed: true,
  enabled: true,
  builtIn: false,
  version: "0.0.5",
};

afterEach(cleanup);

describe("plugin update queries and mutation", () => {
  it("files the view under the key the restart recovery invalidates", () => {
    expect(PLUGIN_UPDATES_QUERY_KEY).toEqual(["plugin-updates"]);
  });

  it("reads the check only once the viewer is a confirmed admin", async () => {
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch({ "GET /api/plugins/updates": () => json(view()) });
    try {
      const { rerender } = renderHook(({ enabled }: { enabled: boolean }) => usePluginUpdates(enabled), {
        wrapper,
        initialProps: { enabled: false },
      });
      // A real tick, not just a microtask: a fetch dispatched from the mount
      // effect would have landed by now.
      await Bun.sleep(0);
      expect(count(calls, "GET", "/api/plugins/updates")).toBe(0);
      rerender({ enabled: true });
      await waitFor(() => expect(count(calls, "GET", "/api/plugins/updates")).toBe(1));
    } finally {
      restore();
    }
  });

  it("the check POSTs and writes the fresh view into the query", async () => {
    const { client, wrapper } = makeWrapper();
    const seeded = view([{ id: "pi", name: "pi", from: "0.0.1", to: "0.0.5" }]);
    const fresh: PluginUpdatesView = { updates: [], errors: [], checkedAt: 2 };
    client.setQueryData(PLUGIN_UPDATES_QUERY_KEY, seeded);
    const { calls, restore } = mockFetch({ "POST /api/plugins/updates/check": () => json(fresh) });
    try {
      const { result } = renderHook(() => useCheckPluginUpdates(), { wrapper });
      expect(result.current.pending).toBe(false);
      result.current.check();
      await waitFor(() => expect(client.getQueryData<PluginUpdatesView>(PLUGIN_UPDATES_QUERY_KEY)).toEqual(fresh));
      expect(count(calls, "POST", "/api/plugins/updates/check")).toBe(1);
      expect(result.current.pending).toBe(false);
    } finally {
      restore();
    }
  });

  it("a failed check reports why and leaves the last view alone", async () => {
    const { client, wrapper } = makeWrapper();
    const seeded = view([{ id: "pi", name: "pi", from: "0.0.1", to: "0.0.5" }]);
    client.setQueryData(PLUGIN_UPDATES_QUERY_KEY, seeded);
    const { restore } = mockFetch({
      "POST /api/plugins/updates/check": () => json({ message: "registry unreachable" }, 500),
    });
    try {
      const { result } = renderHook(() => useCheckPluginUpdates(), { wrapper });
      result.current.check();
      await waitFor(() => expect(result.current.error).toContain("registry unreachable"));
      expect(client.getQueryData<PluginUpdatesView>(PLUGIN_UPDATES_QUERY_KEY)).toEqual(seeded);
    } finally {
      restore();
    }
  });

  it("an update POSTs and refetches both lists", async () => {
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch({
      "GET /api/plugins": () => json({ plugins: [] }),
      "GET /api/plugins/updates": () => json(view()),
      "POST /api/plugins/pi/update": () => json(updatedRow),
    });
    try {
      const { result } = renderHook(
        () => ({ plugins: useInstancePlugins(), updates: usePluginUpdates(true), mutation: useUpdatePlugin() }),
        { wrapper },
      );
      await waitFor(() => {
        expect(count(calls, "GET", "/api/plugins")).toBe(1);
        expect(count(calls, "GET", "/api/plugins/updates")).toBe(1);
      });
      result.current.mutation.mutate("pi");
      await waitFor(() => {
        expect(count(calls, "GET", "/api/plugins")).toBe(2);
        expect(count(calls, "GET", "/api/plugins/updates")).toBe(2);
      });
      expect(result.current.mutation.data).toEqual(updatedRow);
      expect(INSTANCE_PLUGINS_QUERY_KEY).toEqual(["instance-plugins"]);
    } finally {
      restore();
    }
  });

  it("an update also refreshes the preset list and the network/allowlist surfaces", async () => {
    // Same coupling as install and toggle: availability is the instance
    // STORE, so new bytes can change which presets are listed, and a network
    // plugin's manifest decides its addresses on the trusted allowlist.
    const { wrapper } = makeWrapper();
    const { calls, restore } = mockFetch({
      "GET /api/presets": () => json([]),
      "GET /api/network": () => json({ networks: [] }),
      "GET /api/settings/public": () =>
        json({
          allowRegistrations: false,
          emergencyLoginActive: false,
          instanceName: "instance",
          appBaseUrl: "http://localhost",
          trustedOrigins: [],
        }),
      "POST /api/plugins/pi/update": () => json(updatedRow),
    });
    try {
      const { result } = renderHook(
        () => ({
          presets: usePresets(),
          network: useNetwork(true),
          settings: usePublicSettings(),
          mutation: useUpdatePlugin(),
        }),
        { wrapper },
      );
      await waitFor(() => {
        expect(count(calls, "GET", "/api/presets")).toBe(1);
        expect(count(calls, "GET", "/api/network")).toBe(1);
        expect(count(calls, "GET", "/api/settings/public")).toBe(1);
      });
      result.current.mutation.mutate("pi");
      await waitFor(() => {
        expect(count(calls, "GET", "/api/presets")).toBe(2);
        expect(count(calls, "GET", "/api/network")).toBe(2);
        expect(count(calls, "GET", "/api/settings/public")).toBe(2);
      });
    } finally {
      restore();
    }
  });
});
